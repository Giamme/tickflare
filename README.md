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

Open <http://localhost:8787> in two tabs and play tic-tac-toe against yourself. Reload a tab mid-game to see it resume. The example lives in [`examples/tic-tac-toe`](examples/tic-tac-toe).

## How it fits together

```
browser ── WebSocket ──▶ Worker (gateway) ──▶ Room (Durable Object, one per room id)
                         authenticates          runs your hooks, saves state,
                         and routes             sends each player their view
```

**Event mode** is the only sync mode so far. There is no tick loop: the room wakes when a player connects, sends a command or drops, runs your hook, and goes back to sleep. While it sleeps the WebSockets stay open and you are not billed for duration, which makes turn-based and asynchronous games close to free to host.

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
| `view(player)` | Before state is sent to a player | Return what that player may see. Defaults to everything |

Options are plain fields you override: `maxPlayers` (default unlimited) and `maxMessageLength` (default 16,384 characters).

### What the kernel does for you

- **Rollback.** If a hook calls `reject()` or throws, any changes it made to `this.state` are undone.
- **Persistence.** Every accepted change is written to the room's SQLite storage before anyone hears about it. A room that hibernates, restarts or is redeployed picks up where it left off.
- **Ordering.** Each change gets the next `seq`. The sender's `ack` arrives after the `state` frame it caused, so when `send()` resolves the client already shows the result.
- **Seats and resume.** A player who drops keeps their seat. When they reconnect they get the current state in the `welcome` frame; there is nothing to replay.
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
| client → room | `ping` (plain text) | Keepalive. Answered with `pong` without waking the room |
| room → client | `{ t: "welcome", v, you, seq, state, players }` | First frame on every connection |
| room → client | `{ t: "state", seq, state }` | The state changed |
| room → client | `{ t: "presence", players }` | Someone joined, dropped or came back |
| room → client | `{ t: "ack", id, seq }` | Command applied |
| room → client | `{ t: "reject", id, reason }` | Command refused, state unchanged |
| room → client | `{ t: "error", reason }` | The frame could not be read |

Close codes: `4000` replaced by a newer connection, `4001` room full, `4002` refused by `onJoin` (the close reason says why). The client does not reconnect after these.

## Not there yet

- State is sent whole on every change. Deltas come with state sync.
- No turn timers or other scheduled wake-ups.
- No rate limiting of commands.
- Seats are permanent: a player cannot leave a room or be removed from it.
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

The tests in [`test/`](test) drive a fixture Worker over real WebSockets, including eviction of the room while sockets are open.

---

Tickflare is an independent project and is not affiliated with Cloudflare.
