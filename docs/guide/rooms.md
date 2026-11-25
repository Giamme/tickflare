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
5. Then it sends every connected player what changed in their [view](./state-and-views) of the state, and answers the player who sent the command.

Between events the room hibernates. The WebSockets stay open and Cloudflare stops billing for the object's time, so a game that waits a day between moves costs almost nothing while it waits.

## Hooks

Three hooks are required. The rest have defaults.

| Hook | Called when | Notes |
| --- | --- | --- |
| `initialState()` | The room is used for the first time | Required |
| `parseCommand(raw)` | A command arrives | Required. Turn untrusted input into a `Command`, by hand or [with a schema](#checking-commands-with-a-schema); throwing refuses it |
| `onCommand(player, command)` | After `parseCommand` | Required. Change `this.state`; call `reject(reason)` to refuse |
| `onJoin(player)` | A player takes a seat for the first time | `reject(reason)` turns them away |
| `onDisconnect(player)` | A seated player's last connection closes | They keep their seat |
| `onReconnect(player)` | A seated player comes back | |
| `onLeave(player)` | A player asks to leave, or stayed away longer than `seatTimeoutMs` | Tidy up; `reject(reason)` makes them stay |
| `onEmpty()` | The last seat is given up, however the players went | Say [what becomes of the room](#when-a-room-is-over). Not called for a room nobody ever sat in |
| `onTimer(name)` | A timer set with `setTimer` runs out | |
| `onTick(dt)` | `tickRate` times a second, in [state sync](./state-sync) | `dt` is always `1 / tickRate` seconds |
| `shouldTick()` | After every event and every tick | Return false to pause the simulation |
| `view(player)` | Before the state is sent to a player | What that player may see. Defaults to everything |
| `onSpectate(player)` | Someone asks to [watch](./spectators) a room with `maxSpectators` | `reject(reason)` turns them away |
| `spectatorView()` | Before the state is sent to those who watch | What a spectator may see. Defaults to everything, in a room without a `view()` of its own |
| `onHttp(request, player)` | An HTTP request to `/rooms/<id>/...` | For reading, e.g. a scoreboard. Defaults to 404 |
| `onArrive(player, carry)` | Another room [handed a player over](./worlds) | Defaults to `onJoin` |
| `onSignal(fromRoomId, data)` | Another room sent this one a [signal](./worlds#seeing-across-a-border) | |

Every hook receives a `Player`: `{ id, connected, name? }`. [Players and seats](./players) explains the seat lifecycle in detail.

### Checking commands with a schema

Everything a client sends is untrusted, and `parseCommand` is where it is checked. If you already describe your data with Zod, Valibot, ArkType or another library that implements [Standard Schema](https://standardschema.dev), hand the schema to `parseWith` and let it do the checking:

```ts
import { Room, parseWith } from "tickflare";
import { z } from "zod";

const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("move"), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("say"), text: z.string().max(200) }),
]);
type Command = z.infer<typeof Command>;

export class Game extends Room<State, Command> {
  protected parseCommand(raw: unknown) {
    return parseWith(Command, raw);
  }
}
```

The same with Valibot: `v.variant("type", [v.object({ … }), …])` for the schema and `v.InferOutput<typeof Command>` for the type.

- **The room gets what the schema gives back**, not what was sent: unknown keys stripped, defaults filled in, strings trimmed, whatever the schema does.
- **What does not fit is refused** as by `reject()`, with the first thing the schema found wrong and where: `invalid_command: Invalid input: expected number, received string (at x)`. The text is the library's, cut to 120 characters, and the client gets it as the reason. To send a reason of your own, catch what `parseWith` throws and call `reject()` with it.
- **The checks have to be synchronous.** A schema with an asynchronous check cannot be used in a hook: `parseWith` logs why and the command is refused with `invalid_command`.
- **Tickflare depends on none of these libraries.** It reads the interface they share, so the one you use is the only one installed. In a [lockstep](./lockstep) room, `parseInput` takes a schema the same way.

## Options

Options are fields you override:

| Field | Default | Meaning |
| --- | --- | --- |
| `maxPlayers` | `Infinity` | Distinct players who may hold a seat at once |
| `seatTimeoutMs` | `Infinity` | How long a disconnected player keeps their seat |
| `maxSpectators` | `0` | Connections that may [watch without a seat](./spectators). 0 lets nobody |
| `spectatorDelayMs` | `0` | How far behind the players the spectators are kept |
| `maxCommandsPerSecond` | `30` | Frames one player may send a second, and in one burst |
| `maxMessageLength` | `16384` | Longest frame accepted, in characters |
| `tickRate` | `0` | Ticks a second. 0 is event mode |
| `patchRate` | `0` | While ticking, patches a second, when that is to be fewer than ticks: [simulate at one rate and send at another](./state-sync#sending-less-often-than-you-simulate). 0 sends after every tick |
| `historyTicks` | `0` | While ticking, how many ticks of the state are kept for [`stateAt(tick)`](./state-sync#judging-a-command-by-what-its-player-saw). 0 keeps none |
| `saveIntervalMs` | `5000` | While ticking, how often the state is written |
| `trackChanges` | `true` | Follow what each hook writes, instead of comparing the whole state after it. See [The state inside a hook](#the-state-inside-a-hook) |
| `rememberCommands` | `true` | Remember which commands of each client were handled, so that [none is lost or applied twice](./client#when-the-connection-drops) when a connection drops. Turn it off in a ticking room that records commands in tables of its own without calling `saveNow()` |
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
| `spectators` | How many [spectators](./spectators) are connected |
| `roomId` | The id this room is reached under |
| `seq`, `tick` | Changes and ticks so far |
| `stateAt(tick)` | The state as an earlier tick left it, in a room with `historyTicks`: [judging a command by what its player saw](./state-sync#judging-a-command-by-what-its-player-saw) |
| `setTimer(name, ms)` / `clearTimer(name)` | [Timers](./timers-messages-async#timers) that survive restarts |
| `send(playerId, message)` / `broadcast(message)` | [Messages](./timers-messages-async#messages) outside the state |
| `defer(task)` / `act(hook)` | [Async work](./timers-messages-async#async-work) after the hook |
| `removePlayer(playerId, reason?)` | Take a seat away |
| `finishMatch(result, replay?)` | Announce a [finished match](./match-results) |
| `movePlayer(playerId, roomId, carry?)` / `signal(roomId, data)` | [Talk to other rooms](./worlds) |
| `saveNow()` | While ticking, write this hook's changes at once |
| `deleteRoom()` | [End the room](#when-a-room-is-over) and delete what it stored |

### The state inside a hook

A hook should cost what it does, not what the state weighs. So the room does not copy the state before a hook in order to undo it, or go through all of it afterwards to see what changed. It follows the hook's writes: inside a hook, `this.state` and everything you reach through it are stand-ins (JavaScript proxies) for the state's objects, which note each change as it is made. They read and write like the objects themselves:

```ts
const unit = this.state.units[command.unit];
unit.target = command.target;          // noted, and undone if the hook is refused
this.state.units[id] = { ...unit, hp: 10 };
this.state.order.push(id);
```

Three things are different from plain objects:

- **A stand-in is not `===` to an object that did not come from the state.** Two reads of the same unit give the same stand-in, so comparing state with state works. An object you made yourself and then put into the state is the exception: read back, it is its stand-in. `includes`, `indexOf` and `lastIndexOf` see through this; a comparison of your own does not, so compare ids.
- **`structuredClone` refuses a stand-in**, and so does anything that clones what it is handed: a Queue, a call to another Durable Object. `plain(value)`, exported by `tickflare`, gives the object underneath: `structuredClone(plain(this.state.board))`. Read from what it gives you; a change made through it is not followed. It is also the faster way to read a large part of the state in one go, to hash it for instance.
- **Go through `this.state` in every hook.** Do not keep an object of the state in a field of the room and change it in a later hook. Such a change is not followed either: it is not sent until the next tick or save, and it stays if the hook is refused.

`onTick` is the exception. A simulation reads far more than it writes, and reads through stand-ins are slower, so `onTick` gets the state itself and the room compares the whole of it once the tick is done. `view()`, `shouldTick()` and `onHttp` get the state itself too.

If your hooks need plain objects everywhere, set `trackChanges = false`. Every hook then works on the state itself, and each one costs a pass over the whole state.

## Rules for hooks

- **Hooks are synchronous.** A hook that returns a promise is refused with `internal_error`, because the room can't save or roll back work that finishes later. Use [`defer`](./timers-messages-async#async-work) for anything that waits.
- **The state must be JSON-serialisable.** It is stored and sent as JSON.
- **Change the state only inside hooks, through `this.state`.** What `onHttp` changes is discarded, and so is anything a refused hook's leftover promise changes later. See [The state inside a hook](#the-state-inside-a-hook).
- **Identity is decided at the gateway.** Rooms trust the player id your `authenticate` function returns ([Identity and join tokens](./identity)).

## What the room does for you

**Rollback.** If a hook calls `reject()` or throws, everything it did is undone: changes to `this.state`, timers it set or cleared, players it removed, messages it sent, and anything it wrote to the room's own SQLite database. The same happens if the result can't be saved, for instance a match result that isn't JSON.

**Persistence.** Every accepted change is written to the room's storage before anyone hears about it. A room that hibernates, is evicted or is redeployed picks up where it left off, timers included.

**Ordering.** Each change gets the next `seq`. The sender's acknowledgement arrives after the state the command caused, so when `room.send()` resolves on the client, `room.state` already shows the result. In a room that is [ticking](./state-sync#what-changes-while-a-room-ticks) that is with the next tick.

**One connection per player.** A newer connection for the same player closes the older one with `CloseCode.Replaced`.

**Rate limiting.** Each player may send `maxCommandsPerSecond` frames a second, with a burst of the same size. Frames over the limit are refused with `rate_limited` before they reach your code. The allowance belongs to the player, so reconnecting does not refill it.

## When a room is over

A room begins to exist with the first player who is seated in it. Before that it stores nothing: a refused join, a request for a room that was never used or a mistyped room id leaves nothing behind.

From then on it stays until you end it. Nothing ends a room by itself, not an empty lobby, not a finished match, so decide when yours is over and call `this.deleteRoom()`. The usual place is `onEmpty()`, which runs when the last seat is given up, whether its player left, stayed away longer than `seatTimeoutMs`, was removed or moved to another room:

```ts
protected override onEmpty(): void {
  this.deleteRoom();
}
```

`onEmpty()` runs as a hook of its own, straight after the one that emptied the room, with `this.players` empty. A match worth coming back to can set a timer there instead and delete itself when it fires; [Rooms nobody is in](./limits#rooms-nobody-is-in) shows one.

Shortly after the hook, everyone still connected is disconnected with `CloseCode.Removed` and the reason `"room_deleted"`, and everything the room stored is deleted: its state, seats and timers, a lockstep recording, and any tables of your own. With nothing stored, the Durable Object itself is gone from your account.

- **What the room owes goes out first.** A match announced with `finishMatch`, recording included, and a player on their way to another room are delivered before anything is deleted. If a delivery fails the room stays and tries again every 30 seconds.
- **Deferred work gets to finish.** A task passed to `defer()` that is still running, telling a lobby list that the room is gone for instance, is given ten seconds.
- **Your logs show it.** The room resets itself with `ctx.abort()`, which Cloudflare records as an uncaught error reading "deleteRoom(): this room deleted itself and its storage. Not a failure."
- **The room id is free again.** Whoever comes to it later finds a new, empty room.
- **It is undone with the hook**, like everything else, if the hook is refused.

Rooms that are never deleted cost nothing while nothing wakes them, and a room's storage is billed by size, which for most games is small. Delete them anyway: a list of rooms that are over is hard to tell from a list of rooms that are stuck.

## Reaching a room

Rooms are named. `routeToRoom` sends `/rooms/<id>` to the object called `<id>`, creating it on first use. Pick ids that mean something to your game:

- a lobby everyone shares: `/rooms/lobby`
- a match a matchmaker set up: `/rooms/m-7f3a…` ([Matchmaking](./matchmaking))
- a cell of a big world: `/rooms/overworld_3_-2` ([Worlds across rooms](./worlds))

A room id is 1 to 64 letters, digits, dashes and underscores; the gateway answers 400 to anything else under `/rooms/`.
