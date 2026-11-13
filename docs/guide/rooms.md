# Rooms and hooks

A room is one Durable Object: one match, one table, one lobby. You write it as a class that extends `Room<State, Command, Env>` and override the hooks you need. The room calls them when something happens and takes care of everything around them.

```ts
import { Room, reject, type Player } from "tickflare";

export class Duel extends Room<State, Command, Env> {
  protected override maxPlayers = 2;

  protected initialState(): State { /* ... */ }
  protected parseCommand(raw: unknown): Command { /* ... */ }
  protected onCommand(player: Player, command: Command): void { /* ... */ }
}
```

The three type parameters are your state, the commands players send, and your Worker's bindings. `Env` defaults to `Cloudflare.Env`, which `wrangler types` fills in for you.

## What happens on an event

In event mode, the default, a room has no loop. It wakes when something happens, handles it and goes back to sleep:

1. Something happens: a player connects, sends a command, drops or leaves, or a timer runs out.
2. The room calls the matching hook. The hook changes `this.state` in place.
3. If the hook calls `reject()` or throws, everything it did is undone and the event ends there.
4. Otherwise the room writes the new state to its storage.
5. Then it sends every connected player their [view](./state-and-views) of the new state, and answers the player who sent the command.

Between events the room hibernates. The WebSockets stay open and Cloudflare stops billing for the object's time, so a game that waits a day between moves costs almost nothing while it waits.

## Hooks

Three hooks are required. The rest have defaults.

| Hook | Called when | Notes |
| --- | --- | --- |
| `initialState()` | The room is used for the first time | Required |
| `parseCommand(raw)` | A command arrives | Required. Turn untrusted input into a `Command`; throwing refuses it |
| `onCommand(player, command)` | After `parseCommand` | Required. Change `this.state`; call `reject(reason)` to refuse |
| `onJoin(player)` | A player takes a seat for the first time | `reject(reason)` turns them away |
| `onDisconnect(player)` | A seated player's last connection closes | They keep their seat |
| `onReconnect(player)` | A seated player comes back | |
| `onLeave(player)` | A player asks to leave, or stayed away longer than `seatTimeoutMs` | Tidy up; `reject(reason)` makes them stay |
| `onTimer(name)` | A timer set with `setTimer` runs out | |
| `onTick(dt)` | `tickRate` times a second, in [state sync](./state-sync) | `dt` is always `1 / tickRate` seconds |
| `shouldTick()` | After every event and every tick | Return false to pause the simulation |
| `view(player)` | Before the state is sent to a player | What that player may see. Defaults to everything |
| `onHttp(request, player)` | An HTTP request to `/rooms/<id>/...` | For reading, e.g. a scoreboard. Defaults to 404 |
| `onArrive(player, carry)` | Another room [handed a player over](./worlds) | Defaults to `onJoin` |
| `onSignal(fromRoomId, data)` | Another room sent this one a [signal](./worlds#seeing-across-a-border) | |

Every hook receives a `Player`: `{ id, connected, name? }`. [Players and seats](./players) explains the seat lifecycle in detail.

## Options

Options are fields you override:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxPlayers` | `Infinity` | Distinct players who may hold a seat at once |
| `seatTimeoutMs` | `Infinity` | How long a disconnected player keeps their seat |
| `maxCommandsPerSecond` | `30` | Frames one player may send a second, and in one burst |
| `maxMessageLength` | `16384` | Longest frame accepted, in characters |
| `tickRate` | `0` | Ticks a second. 0 is event mode |
| `saveIntervalMs` | `5000` | While ticking, how often the state is written |
| `matchQueue` | none | A Queue binding for [finished matches](./match-results) |
| `matchBucket` | none | An R2 binding for replays |
| `rooms` | none | The namespace other rooms live in, for [handover and signals](./worlds) |

Bindings come from `this.env`, which is ready when field initialisers run:

```ts
protected override matchQueue = this.env.MATCHES;
```

## Inside a hook

These are available on `this` while a hook runs:

| Member | What it does |
| --- | --- |
| `state` | The authoritative state. Change it in place |
| `players` | Everyone with a seat, in join order |
| `roomId` | The id this room is reached under |
| `seq`, `tick` | Changes and ticks so far |
| `setTimer(name, ms)` / `clearTimer(name)` | [Timers](./timers-messages-async#timers) that survive restarts |
| `send(playerId, message)` / `broadcast(message)` | [Messages](./timers-messages-async#messages) outside the state |
| `defer(task)` / `act(hook)` | [Async work](./timers-messages-async#async-work) after the hook |
| `removePlayer(playerId, reason?)` | Take a seat away |
| `finishMatch(result, replay?)` | Announce a [finished match](./match-results) |
| `movePlayer(playerId, roomId, carry?)` / `signal(roomId, data)` | [Talk to other rooms](./worlds) |
| `saveNow()` | While ticking, write this hook's changes at once |
| `deleteRoom()` | [End the room](#when-a-room-is-over) and delete what it stored |

## Rules for hooks

- **Hooks are synchronous.** A hook that returns a promise is refused with `internal_error`, because the room can't save or roll back work that finishes later. Use [`defer`](./timers-messages-async#async-work) for anything that waits.
- **The state must be JSON-serialisable.** It is stored and sent as JSON, in one database row, which Cloudflare limits to 2 MB.
- **Change the state only inside hooks.** What `onHttp` changes is discarded, and so is anything a refused hook's leftover promise changes later.
- **Identity is decided at the gateway.** Rooms trust the player id your `authenticate` function returns ([Identity and join tokens](./identity)).

## What the room does for you

**Rollback.** If a hook calls `reject()` or throws, everything it did is undone: changes to `this.state`, timers it set or cleared, players it removed, messages it sent, and anything it wrote to the room's own SQLite database. The same happens if the result can't be saved, for instance a match result that isn't JSON.

**Persistence.** Every accepted change is written to the room's storage before anyone hears about it. A room that hibernates, is evicted or is redeployed picks up where it left off, timers included.

**Ordering.** Each change gets the next `seq`. In event mode the sender's acknowledgement arrives after the state it caused, so when `room.send()` resolves on the client, `room.state` already shows the result.

**One connection per player.** A newer connection for the same player closes the older one with `CloseCode.Replaced`.

**Rate limiting.** Each player may send `maxCommandsPerSecond` frames a second, with a burst of the same size. Frames over the limit are refused with `rate_limited` before they reach your code. The allowance belongs to the player, so reconnecting does not refill it.

## When a room is over

A room begins to exist with the first player who is seated in it. Before that it stores nothing: a refused join, a request for a room that was never used or a mistyped room id leaves nothing behind.

From then on it stays until you end it. Nothing ends a room by itself, not an empty lobby, not a finished match, so decide when yours is over and call `this.deleteRoom()`:

```ts
protected override onLeave(player: Player): void {
  const anyoneElse = this.players.some((seated) => seated.id !== player.id);
  if (!anyoneElse) this.deleteRoom();
}
```

Shortly after the hook, everyone still connected is disconnected with `CloseCode.Removed` and the reason `"room_deleted"`, and everything the room stored is deleted: its state, seats and timers, a lockstep recording, and any tables of your own. With nothing stored, the Durable Object itself is gone from your account.

- **What the room owes goes out first.** A match announced with `finishMatch`, recording included, and a player on their way to another room are delivered before anything is deleted. If a delivery fails the room stays and tries again every 30 seconds.
- **Deferred work gets to finish.** A task passed to `defer()` that is still running, telling a lobby list that the room is gone for instance, is given ten seconds.
- **The room id is free again.** Whoever comes to it later finds a new, empty room.
- **It is undone with the hook**, like everything else, if the hook is refused.

Rooms that are never deleted cost nothing while nothing wakes them, and a room's storage is billed by size, which for most games is small. Delete them anyway: a list of rooms that are over is hard to tell from a list of rooms that are stuck.

## Reaching a room

Rooms are named. `routeToRoom` sends `/rooms/<id>` to the object called `<id>`, creating it on first use. Pick ids that mean something to your game:

- a lobby everyone shares: `/rooms/lobby`
- a match a matchmaker set up: `/rooms/m-7f3a…` ([Matchmaking](./matchmaking))
- a cell of a big world: `/rooms/overworld_3_-2` ([Worlds across rooms](./worlds))

A room id is 1 to 64 letters, digits, dashes and underscores; the gateway answers 400 to anything else under `/rooms/`.
