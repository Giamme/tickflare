# Tickflare

A multiplayer game framework for Cloudflare Workers and Durable Objects.

Each room is one Durable Object: a single-threaded, authoritative server with its own storage, placed on Cloudflare's network. Tickflare gives that object a game-shaped API, so you write the rules and it handles connections, persistence, reconnects and what each player is allowed to see.

It is aimed at turn-based, card, co-op, .io-style and strategy games. Games that need UDP and rollback netcode (shooters, fighting games, sim racing) are out of scope.

> **Status: early.** Step 1 of the [roadmap](#roadmap) is in: the room kernel with event mode and a minimal client. Expect the API to change. The package is not on npm yet.

## Try the example

```sh
npm install
npm run dev
```

Open <http://localhost:8787> in two tabs and play tic-tac-toe against yourself. Reload a tab mid-game to see it resume. Each move is on a 30-second clock, and a tab that stays closed for 30 seconds loses its seat. The example lives in [`examples/tic-tac-toe`](examples/tic-tac-toe).

## How it fits together

```
browser ── WebSocket ──▶ Worker (gateway) ──▶ Room (Durable Object, one per room id)
                         authenticates          runs your hooks, saves state,
                         and routes             sends each player their view
```

**Event mode** is the only sync mode so far. There is no tick loop: the room wakes when a player connects, sends a command, drops or leaves, or when a timer you set runs out. It runs your hook and goes back to sleep. While it sleeps the WebSockets stay open and you are not billed for duration, which makes turn-based and asynchronous games close to free to host.

## Write a room

```ts
// src/game.ts
import { Room, reject, type Player } from "tickflare";

interface State {
  count: number;
  lastBy: string | null;
}
type Command = { type: "increment" };

export class Counter extends Room<State, Command> {
  protected override maxPlayers = 4;

  protected initialState(): State {
    return { count: 0, lastBy: null };
  }

  // Everything a client sends is untrusted. Check it here.
  protected parseCommand(raw: unknown): Command {
    if ((raw as { type?: unknown } | null)?.type === "increment") return { type: "increment" };
    return reject("invalid_command");
  }

  protected onCommand(player: Player, _command: Command): void {
    if (this.state.lastBy === player.id) reject("wait_for_someone_else");
    this.state.count += 1;
    this.state.lastBy = player.id;
  }
}
```

```ts
// src/index.ts
import { routeToRoom } from "tickflare";
export { Counter } from "./game";

export default {
  async fetch(request, env) {
    const response = await routeToRoom(request, {
      rooms: env.ROOMS,
      // Return the caller's player id, or a Response to turn them away.
      authenticate: (request) => playerIdFromSession(request),
    });
    return response ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

```jsonc
// wrangler.jsonc
{
  "name": "my-game",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "durable_objects": { "bindings": [{ "name": "ROOMS", "class_name": "Counter" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }]
}
```

```ts
// in the browser
import { RoomClient } from "tickflare/client";

const room = new RoomClient("wss://my-game.example/rooms/lobby", {
  onState: (state) => render(state),
});
await room.send({ type: "increment" }); // resolves once applied; rejects if refused
await room.leave(); // gives up the seat; the room then closes the connection
```

### Hooks

| Hook | Called when | Notes |
| --- | --- | --- |
| `initialState()` | The room is used for the first time | Required |
| `parseCommand(raw)` | A command arrives | Required. Throwing refuses the command |
| `onCommand(player, command)` | After `parseCommand` | Required. Change `this.state`; call `reject(reason)` to refuse |
| `onJoin(player)` | A player takes a seat for the first time | `reject(reason)` turns them away |
| `onDisconnect(player)` | A seated player's connection closes | They keep their seat |
| `onReconnect(player)` | A seated player comes back | |
| `onLeave(player)` | A player asks to give up their seat | Tidy up after them; they are removed when it returns. `reject(reason)` makes them stay |
| `onTimer(name)` | A timer set with `setTimer` runs out | |
| `view(player)` | Before state is sent to a player | Return what that player may see. Defaults to everything |

Options are plain fields you override: `maxPlayers` (default unlimited) and `maxMessageLength` (default 16,384 characters).

### Inside a hook

| Member | What it does |
| --- | --- |
| `this.state` | The authoritative state. Change it in place |
| `this.players` | Everyone with a seat, in join order, each with a `connected` flag |
| `this.setTimer(name, delayMs)` | Runs `onTimer(name)` once, `delayMs` from now. Setting the same name again replaces it. Returns the time it fires, in epoch milliseconds |
| `this.clearTimer(name)` | Cancels a timer |
| `this.removePlayer(playerId, reason?)` | Takes a seat away and closes that player's connection. `onLeave` is not called |

Timers and seats cover the usual table manners. A turn clock, with the deadline in the state so clients can show a countdown:

```ts
this.state.turnEndsAt = this.setTimer("turn", 30_000);
```

A player who drops keeps their seat for a minute, then loses it:

```ts
protected override onDisconnect(player: Player): void {
  this.setTimer(`away:${player.id}`, 60_000);
}

protected override onReconnect(player: Player): void {
  this.clearTimer(`away:${player.id}`);
}

protected override onTimer(name: string): void {
  if (name.startsWith("away:")) this.removePlayer(name.slice(5), "away");
}
```

### What the kernel does for you

- **Rollback.** If a hook calls `reject()` or throws, everything it did is undone: changes to `this.state`, timers it set or cleared, and players it removed.
- **Persistence.** Every accepted change is written to the room's SQLite storage before anyone hears about it. A room that hibernates, restarts or is redeployed picks up where it left off, timers included.
- **Timers.** Any number of named timers share the object's single alarm. Each fires once; one whose hook throws is spent, not retried.
- **Ordering.** Each change gets the next `seq`. The sender's `ack` arrives after the `state` frame it caused, so when `send()` resolves the client already shows the result.
- **Seats and resume.** A player who drops keeps their seat until they leave or you remove them. When they reconnect they get the current state in the `welcome` frame; there is nothing to replay.
- **One connection per player.** A newer connection for the same player closes the older one.
- **Hidden information.** With `view()`, each player receives only their own projection of the state.

### Rules for hooks

- Hooks are **synchronous**. A hook that returns a promise is refused with `internal_error`, because the kernel cannot save or roll back work that finishes later.
- `this.state` must be **JSON-serializable**. It is stored and sent as JSON.
- Identity is **yours to establish**. Rooms trust the id your `authenticate` function returns. The example trusts a `?player=` query parameter so it can run without a login; do not ship that.

## Protocol

JSON text frames over one WebSocket per player.

| Direction | Frame | Meaning |
| --- | --- | --- |
| client → room | `{ t: "cmd", id, data }` | A command. `id` is echoed in the answer |
| client → room | `{ t: "leave", id }` | Give up the seat. Answered like a command, then the room closes the connection |
| client → room | `ping` (plain text) | Keepalive. Answered with `pong` without waking the room |
| room → client | `{ t: "welcome", v, you, seq, state, players }` | First frame on every connection |
| room → client | `{ t: "state", seq, state }` | The state changed |
| room → client | `{ t: "presence", players }` | Someone joined, dropped or came back |
| room → client | `{ t: "ack", id, seq }` | Command or leave applied |
| room → client | `{ t: "reject", id, reason }` | Command or leave refused, state unchanged |
| room → client | `{ t: "error", reason }` | The frame could not be read |

Close codes: `4000` replaced by a newer connection, `4001` room full, `4002` refused by `onJoin`, `4003` the seat is gone (the close reason is `left`, or whatever was passed to `removePlayer`). The client does not reconnect after these.

## Not there yet

- State is sent whole on every change. Deltas come with state sync.
- No rate limiting of commands.
- No matchmaking; clients pick the room id.

## Roadmap

1. **Room kernel, event mode, TypeScript client** (this is where we are)
2. State sync: a fixed-rate authoritative simulation with delta snapshots and visibility rules
3. Lockstep: the room orders inputs, clients simulate deterministically; replays from the input log
4. Matchmaking and the services around a room (D1, R2, Queues)
5. World shards: large worlds split across rooms, with handoff between them

## Development

```sh
npm test            # runs the suite inside workerd via @cloudflare/vitest-plugin
npm run typecheck
npm run build       # emits dist/ for the tickflare and tickflare/client entry points
npm run dev         # the tic-tac-toe example on http://localhost:8787
```

The tests in [`test/`](test) drive a fixture Worker over real WebSockets, including eviction of the room while sockets are open and timers are pending.

When you test your own rooms, `runDurableObjectAlarm(stub)` from `cloudflare:test` fires the room's earliest pending timer straight away, so you do not have to wait for the clock.

---

Tickflare is an independent project and is not affiliated with Cloudflare.
