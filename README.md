# Tickflare

[![CI](https://github.com/Giamme/tickflare/actions/workflows/ci.yml/badge.svg)](https://github.com/Giamme/tickflare/actions/workflows/ci.yml)

A multiplayer game framework for Cloudflare Workers and Durable Objects.

Each room is one Durable Object: a single-threaded, authoritative server with its own storage, placed on Cloudflare's network. Tickflare gives that object a game-shaped API, so you write the rules and it handles connections, persistence, reconnects and what each player is allowed to see.

It is aimed at turn-based, card, co-op, .io-style and strategy games. Games that need UDP and rollback netcode (shooters, fighting games, sim racing) are out of scope.

> **Status: early.** All five steps of the [roadmap](#roadmap) have a first version: the room kernel with event mode, state sync and lockstep, matchmaking, match results, handover between rooms, and a minimal client. Expect the API to change. The package is not on npm yet.

## Try the examples

```sh
npm install
npm run dev         # tic-tac-toe: event mode
npm run dev:arena   # arena: state sync at 20 ticks a second
npm run dev:skirmish  # skirmish: lockstep at 10 turns a second
npm run dev:ranked    # ranked tic-tac-toe: matchmaking, a queue and a database
```

Open <http://localhost:8787> in two tabs and play tic-tac-toe against yourself. Reload a tab mid-game to see it resume. Each move is on a 30-second clock, and a tab that stays closed for 30 seconds loses its seat. The example lives in [`examples/tic-tac-toe`](examples/tic-tac-toe).

The arena in [`examples/arena`](examples/arena) is a real-time room: click to move a dot and eat pellets, with every extra tab another player. It is also a row of rooms: walk into the left or right wall and the dot is handed to the arena next door, and dots near a wall are visible from the other side.

The skirmish in [`examples/skirmish`](examples/skirmish) is lockstep: each tab commands a squad and simulates the whole battle itself, and a fingerprint on screen shows the tabs agree.

The ranked tic-tac-toe in [`examples/ranked`](examples/ranked) adds what surrounds a room: a matchmaker pairs players and reserves their room, and every finished game travels through a Queue into D1 and shows up in the lobby.

## How it fits together

```
browser ── WebSocket ──▶ Worker (gateway) ──▶ Room (Durable Object, one per room id)
                         authenticates          runs your hooks, saves state,
                         and routes             sends each player their view
```

A room synchronises its players in one of three ways:

- **Event mode** is the default. There is no tick loop: the room wakes when a player connects, sends a command, drops or leaves, or when a timer you set runs out. It runs your hook and goes back to sleep. While it sleeps the WebSockets stay open and you are not billed for duration, which makes turn-based and asynchronous games close to free to host.
- **State sync** adds a simulation. The room calls `onTick` at a fixed rate while players are connected and sends each player only what changed in their view since the previous tick. See [State sync](#state-sync).
- **Lockstep** turns that around: the room never runs the game. It orders everyone's inputs into numbered turns and every client runs the same deterministic simulation over them. Bandwidth depends on what players do, not on how many units exist, which is what strategy games need. See [Lockstep](#lockstep).

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

### Identity

A room trusts the player id your `authenticate` function returns, so that function is where identity is decided. `tokenAuth` gives you one that accepts signed join tokens:

```ts
import { createJoinToken, routeToRoom, tokenAuth } from "tickflare";

// 1. Your backend knows who the player is (a login, a session, a guest account) and signs a token.
const token = await createJoinToken(env.JOIN_SECRET, { player: user.id, expiresIn: 3600 });

// 2. The gateway only lets in connections that present a valid one.
await routeToRoom(request, {
  rooms: env.ROOMS,
  authenticate: tokenAuth({ secret: env.JOIN_SECRET }),
});
```

```ts
// 3. The client connects with it. `token` is asked before every connection attempt.
const room = new RoomClient("wss://my-game.example/rooms/lobby", {
  token: (roomId) => getJoinToken(roomId), // yours: return the one you have, or fetch a new one
});
```

- A token is an HMAC-SHA256 signature over the player id and an expiry. It cannot be forged or changed without the secret, so a player cannot connect as someone else.
- Tokens expire, and a client reconnects for as long as the page is open. That is why the client takes a function: it is called for the first connection, for every reconnect and when the room hands the player to another room, each time with the id of the room being connected to. Return the token you have while it is still good and get a new one from your backend when it is not. A token written into the URL (`?token=...`) works too, but it is fixed for the life of the client: once it has run out, the client can no longer reconnect.
- Pass `scope: roomId` to `createJoinToken` for a token that only opens one room or one matchmaking queue. The `roomId` the client passes to `token` is what to ask your backend for.
- Keep the secret out of the repository: `wrangler secret put JOIN_SECRET`. It must be at least 16 characters.
- The examples sign tokens for anonymous guests at `POST /api/guest` (see [`examples/shared`](examples/shared/src/guest.ts)), and a guest who presents a token that is still valid gets a new one for the same player. That is the place to plug in your own accounts.

You can still write `authenticate` yourself, for example to read a session cookie. It receives the request and the room id, and returns the player id (or `{ id, name }`) or a `Response` to refuse. A name reaches `onJoin`, `onReconnect`, `onArrive` and `onHttp` as `player.name`; put `name` in a join token and `tokenAuth` passes it on. For accounts that already do all of this, see below.

### Accounts and player data

`Accounts` is a small player backend on D1: accounts with a name and a password, sessions, guests who can sign up without losing what they earned, per-player data, stats and leaderboards, public profiles, and a player's right to download or delete everything about them.

```ts
import { Accounts, routeToRoom } from "tickflare";

const accounts = (env: Env) =>
  new Accounts(env.DB, {
    secret: env.JOIN_SECRET,
    data: {
      avatar: { read: "public", write: "owner" }, // on the profile; players set it themselves
      settings: { write: "owner" }, //               private; players set it themselves
      rating: { read: "public" }, //                 on the profile; only your server sets it
    },
  });

export default {
  async fetch(request, env) {
    const a = accounts(env);
    return (
      (await a.route(request)) ?? // the HTTP API, under /api/accounts
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate: a.authenticate })) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
```

```ts
// In the browser.
import { AccountClient, RoomClient } from "tickflare/client";

const accounts = new AccountClient();
await accounts.restore(); // signed in from an earlier visit?
const room = new RoomClient(`wss://${location.host}/rooms/lobby`, { token: accounts.tokenSource });

await accounts.register({ name: "Ada", password: "correct horse battery" }); // keeps the guest's id
await accounts.setData("avatar", { hat: "red" });
const top = await accounts.leaderboard("wins");
```

```ts
// In a room or a queue consumer: what players cannot be trusted to write.
await accounts(env).addStats(winner, { wins: 1, games: 1 });
await accounts(env).maxStats(winner, { bestStreak: streak });
await accounts(env).setData(winner, "rating", newRating);
```

- Rooms see signed-in players under their account id, with `player.name` set. Guests connect with a token from `POST /api/accounts/guest`, which `tokenSource` fetches, keeps in `localStorage` and renews for the same id. `a.requireAccount` in place of `a.authenticate` keeps guests out.
- In the browser the session is an `HttpOnly` cookie the page's scripts never see, which the WebSocket connection carries too. Other clients get the session token in the response and send it as `Authorization: Bearer`; `AccountClient` does that outside browsers.
- Passwords are hashed with PBKDF2-SHA256, 100,000 iterations, the most the Workers runtime allows. Sessions are stored as hashes, so a leaked database does not sign anyone in, and they last 30 days since last used. Changing the password ends every session.
- Requests that would act as the player are refused from other sites' pages, cookie-carrying WebSocket connections included. If your pages are served from another origin, list it in `allowedOrigins`; it then gets CORS headers.
- After ten failed sign-ins for a name, or fifty from one address, sign-ins are refused for up to fifteen minutes.
- Names are 3 to 24 characters and unique regardless of case, spaces, dots, dashes and underscores. An email address is optional and only stored.
- Data is JSON per key, up to 64 KiB per key and 100 keys per player by default. Keys not listed in `data` are private and only your server writes them. Stats are numbers only your server writes, and every stat is a leaderboard: `GET /api/accounts/leaderboards/wins`. Guests can have data and stats too; leaderboards and profiles only list accounts.
- `GET /export` gives a player everything stored about them, matches recorded by `recordMatches` included; `DELETE /me` with their password deletes their account, data and stats.
- Moving from another service: `importAccount` takes an account with its id and its old password hash, and `verifyImportedPassword` checks that hash when they first sign in, after which it is replaced with one of these.
- `rename`, `setEmail` and `statsOf` (stats of many players at once, for your own leaderboards and lists) are there for server code too.
- The tables are prefixed `tickflare_` and created on first use (`ACCOUNTS_SCHEMA` has the SQL).

The whole API, under `/api/accounts`: `POST /guest`, `POST /register`, `POST /login`, `POST /logout`, `GET /me`, `DELETE /me`, `POST /password`, `POST /name`, `POST /email`, `GET /export`, `POST /token` (a join token with the player's name, for clients that connect without the cookie), `GET|PUT|DELETE /data/:key`, `GET /players/:id`, `GET /leaderboards/:stat?limit=&offset=`. Errors are `{ error, message }` with a code such as `name_taken` or `invalid_credentials`.

Not included, on purpose: email verification and password reset (they need an email sender), analytics events and remote config.

### Hooks

| Hook | Called when | Notes |
| --- | --- | --- |
| `initialState()` | The room is used for the first time | Required |
| `parseCommand(raw)` | A command arrives | Required. Throwing refuses the command |
| `onCommand(player, command)` | After `parseCommand` | Required. Change `this.state`; call `reject(reason)` to refuse |
| `onJoin(player)` | A player takes a seat for the first time | `reject(reason)` turns them away |
| `onDisconnect(player)` | A seated player's connection closes | They keep their seat |
| `onReconnect(player)` | A seated player comes back | |
| `onLeave(player)` | A player asks to give up their seat, or stayed away longer than `seatTimeoutMs` | Tidy up after them; they are removed when it returns. `reject(reason)` makes them stay |
| `onTimer(name)` | A timer set with `setTimer` runs out | |
| `onTick(dt)` | `tickRate` times a second while the room is ticking | `dt` is always `1 / tickRate` seconds |
| `shouldTick()` | After every event and every tick | Return false to pause the simulation. Defaults to true |
| `view(player)` | Before state is sent to a player | Return what that player may see. Defaults to everything |
| `onHttp(request, player)` | A plain HTTP request to `{prefix}/{roomId}/...` | For reading from the room, e.g. a scoreboard. Already authenticated. Defaults to 404. Anything it changes in `this.state` is discarded |

Options are plain fields you override: `maxPlayers` (default unlimited), `maxMessageLength` (default 16,384 characters), `maxCommandsPerSecond` (default 30), `seatTimeoutMs` (default never), `tickRate` (default 0, which is event mode) and `saveIntervalMs` (default 5,000).

### Inside a hook

| Member | What it does |
| --- | --- |
| `this.state` | The authoritative state. Change it in place |
| `this.players` | Everyone with a seat, in join order, each with a `connected` flag |
| `this.setTimer(name, delayMs)` | Runs `onTimer(name)` once, `delayMs` from now. Setting the same name again replaces it. Returns the time it fires, in epoch milliseconds. Names starting with `tickflare:` are the kernel's |
| `this.clearTimer(name)` | Cancels a timer |
| `this.removePlayer(playerId, reason?)` | Takes a seat away and closes that player's connection. `onLeave` is not called |
| `this.saveNow()` | While ticking, writes what this hook changes to storage as soon as it returns instead of at the next save interval. For hooks that also write to the room's database themselves |
| `this.send(playerId, message)` | Sends one player a message outside the state. The client gets it in `onMessage` |
| `this.broadcast(message)` | Sends every connected player a message |

Timers and seats cover the usual table manners. A turn clock, with the deadline in the state so clients can show a countdown:

```ts
this.state.turnEndsAt = this.setTimer("turn", 30_000);
```

A player who drops keeps their seat for a minute, then loses it:

```ts
protected override seatTimeoutMs = 60_000;

// Runs when they leave and when their minute is up.
protected override onLeave(player: Player): void {
  delete this.state.units[player.id];
}
```

Set `seatTimeoutMs` in any real-time room. Without it a seat is kept until the player leaves, which suits a game played over days but lets closed tabs fill a room for good.

Messages are for what does not belong in the state: an event to hear about once, a result with more in it than an ack, or a stream you keep in step yourself, such as what one player can see.

```ts
this.send(player.id, { type: "hit", by: attacker.id });
```

They go out when the event that sent them is over, after the state frame it caused (in a ticking room, after the tick's patch), and are dropped for players who are not connected and when the hook that sent them is refused. A player the same hook removes still hears them before the connection closes. Nothing is sent again on reconnect, unlike the state: send what a returning player needs from `onReconnect`.

### State sync

Set `tickRate` and write `onTick`. Everything else about the room stays the same: hooks, timers, seats and views work as in event mode.

```ts
export class Arena extends Room<State, Command> {
  protected override tickRate = 20; // ticks per second

  protected override onTick(dt: number): void {
    for (const unit of Object.values(this.state.units)) {
      unit.x += unit.vx * dt;
      unit.y += unit.vy * dt;
    }
  }

  // Optional: only simulate during a match. In the lobby the room is back in event mode and can sleep.
  protected override shouldTick(): boolean {
    return this.state.phase === "playing";
  }
}
```

What changes while a room is ticking:

- **Deltas.** After each tick every player gets a `patch` frame with only what changed in their own `view()`. The client applies it for you; `onState` and `client.state` work as before. In the arena example a tick is about 110 bytes on the wire against 740 for the whole state.
- **Shared parts of views.** When `view()` returns an object whose top-level fields include one that is the same object for many players (a public part of the match built once per tick, next to a private part per player), that field is diffed and serialized once per tick for everyone, not once per player. Build the shared part once per tick and return the same object from every `view()` call to get this. In a 20-player match with 500 units this took the cost of sending a tick from 85 ms to 10 ms.
- **Commands** are applied when they arrive and acknowledged at once. Their effect reaches clients with the next tick, so `send()` resolving no longer means the client already shows the result.
- **Saving.** The state is written to storage every `saveIntervalMs` (5 seconds by default) and when the simulation stops, not on every change. A room that is torn down mid-simulation by a deploy or a crash resumes from the last write. Seats, timers, finished matches and handovers are still saved the moment they change, and the state is written with them, so storage never holds one without the other. The same goes for what `onTimer` does, and for any hook that calls `this.saveNow()`.
- **Stopping.** The simulation stops when the last player disconnects or `shouldTick()` returns false, and starts again when a player is connected and it returns true.

On the client, `Interpolator` smooths what arrives once per tick for drawing at screen rate. It always glides from what is on screen, so a late or bunched update bends the motion instead of making it jump:

```ts
import { Interpolator } from "tickflare/client";

const glide = new Interpolator(1000 / 20, ["x", "y"]); // one tick at 20 ticks a second
// onState: (state) => glide.update(state.units)
// in the render loop: const { x, y } = glide.at(id) ?? state.units[id];
```

Two things keep ticks cheap:

- Keep things that change one at a time (units, players, projectiles) in objects keyed by id. Objects are patched key by key; arrays are sent whole when anything in them changes.
- Round what you can. A position with one decimal is shorter on the wire than a 17-digit float.

### Lockstep

The room validates and orders inputs; the game itself lives in the client.

```ts
// server: src/game.ts
import { LockstepRoom, reject } from "tickflare";

type Order = { type: "move"; x: number; y: number };

export class Skirmish extends LockstepRoom<Order> {
  protected override tickRate = 10; // turns per second

  // Every client will feed what this returns to its simulation.
  protected parseInput(raw: unknown): Order {
    const input = raw as Partial<Order> | null;
    if (input?.type !== "move" || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      return reject("invalid_order");
    }
    return { type: "move", x: Math.round(input.x!), y: Math.round(input.y!) };
  }
}
```

```ts
// client
import { LockstepClient, seededRandom } from "tickflare/client";

const client = new LockstepClient<Order, World>("wss://my-game.example/rooms/lobby", {
  create: (seed) => new World(seededRandom(seed)),
  step(world, entries, turn) {
    for (const entry of entries) {
      if (entry.e === "join") world.addPlayer(entry.p);
      else if (entry.e === "leave") world.removePlayer(entry.p);
      else if (entry.i) world.order(entry.p, entry.i);
    }
    world.advance();
  },
  hash: (world) => world.checksum(), // optional: lets the room catch desyncs
  onTurn: (world) => render(world),
});

client.input({ type: "move", x: 120, y: 80 });
```

How it works:

- **Turns.** `tickRate` times a second the room closes a turn: whatever inputs arrived since the last one, in arrival order. All players get the same turn. An input takes effect in the turn the room puts it in, for everyone at once, so there is nothing to predict or roll back.
- **Players are part of the stream.** Joining, leaving, dropping and reconnecting arrive as entries with `e` set, so every simulation sees them at the same turn. Every way of losing a seat (leaving, `seatTimeoutMs`, `removePlayer`) arrives as `leave`.
- **Even pacing.** A real network delivers turns in fits. The client holds one turn in reserve (`bufferTurns`) and advances the simulation at the room's pace, so movement does not stutter. An order is therefore visible one to two turns after it reaches the room; show the player their click straight away, as the skirmish does.
- **Recording.** Every turn in which something happened is stored in the room. The recording is served at `{prefix}/{roomId}/replay`, behind the same `authenticate` as the WebSocket. `runReplay(replay, { create, step })` plays one back.
- **Catching up.** On every (re)connect the client rebuilds its simulation from the recording and then follows the live turns. A reload mid-match ends in the same state as everyone else.
- **Desync detection.** If you pass `hash`, clients report it every 20 turns. When two players disagree about a turn that has happened, the room sets `desync` and every client's `onDesync` fires. One player alone cannot set it.

Your simulation must be deterministic. In practice:

- Take randomness only from `seededRandom(seed)`, never `Math.random()`.
- Do not read the clock. Time is the turn number.
- Prefer whole numbers. `+ - * /` and `Math.sqrt` give the same result everywhere; `Math.sin`, `Math.cos` and friends are not guaranteed to.
- Iterate in a fixed order. Object keys keep insertion order, which is the same on every client because joins arrive in the same order.

### Matchmaking

A `Matchmaker` is a Durable Object that players wait in. When enough are waiting it picks a new room id, reserves that room for them and tells each where to go. Each queue name is its own object, so `ranked` and `casual` fill separately.

```ts
// server
import { Matchmaker, routeToMatchmaker, routeToRoom } from "tickflare";

export class Lobby extends Matchmaker<Env> {
  protected override matchSize = 2;

  protected async reserveRoom(roomId: string, players: string[], locationHint?: DurableObjectLocationHint) {
    const rooms = this.env.ROOMS;
    await rooms.get(rooms.idFromName(roomId), { locationHint }).reserve(roomId, players);
  }
}

export default {
  async fetch(request, env) {
    const response =
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate })) ??
      (await routeToMatchmaker(request, { matchmaker: env.LOBBY, authenticate }));
    return response ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
```

```ts
// client
import { RoomClient, findMatch } from "tickflare/client";

const { room } = await findMatch("wss://my-game.example/matchmaking/ranked");
const client = new RoomClient(`wss://my-game.example/rooms/${room}`);
```

- **Reserved seats.** Only the matched players can take a seat in the room; anyone else is closed with `4002` and `not_invited`.
- **One match at a time.** Reserving a room takes a moment. Players who arrive meanwhile wait for the next match, and if one of the group gives up meanwhile the others go back in the queue instead of into a room that will never fill. A reservation that fails is tried again by itself, a little later each time.
- **Placement.** The gateway works out roughly where each player is from `request.cf`, and the matchmaker passes the most common region as `locationHint`, so the room is created near the players. Locally there is no `request.cf` and the hint is undefined.
- **Cost.** The queue is the set of open WebSockets, so a matchmaker hibernates while people wait.

- **Starting short.** Set `minPlayers` and `maxWaitMs` to start a match with fewer than `matchSize` players once the longest-waiting one has waited that long: `matchSize = 8`, `minPlayers = 2`, `maxWaitMs = 20_000` fills a lobby of eight but never keeps two players waiting more than twenty seconds.

Add the matchmaker class to `durable_objects.bindings` and `migrations` in your Wrangler config like a room. `findMatch` takes an `AbortSignal` to stop waiting.

### Match results

Call `this.finishMatch(result)` from a hook when a match ends. The room puts a message on a queue; a queue consumer stores it in D1. Lockstep rooms also store their recording in R2 and the message carries its key.

```ts
export class Duel extends Room<State, Command, Env> {
  protected override matchQueue = this.env.MATCHES; // a Queue binding
  protected override matchBucket = this.env.REPLAYS; // optional: an R2 binding, for replays

  protected onCommand(player: Player, command: Command): void {
    // ...
    if (this.state.winner) this.finishMatch({ winner: this.state.winner });
  }
}

export default {
  // ...fetch as above
  async queue(batch, env) {
    await recordMatches(batch, env.DB); // a D1 binding
  },
} satisfies ExportedHandler<Env, MatchResult>;
```

```jsonc
// wrangler.jsonc, in addition to the Durable Objects
"queues": {
  "producers": [{ "binding": "MATCHES", "queue": "matches" }],
  "consumers": [{ "queue": "matches" }]
},
"d1_databases": [{ "binding": "DB", "database_name": "my-game", "database_id": "..." }],
"r2_buckets": [{ "binding": "REPLAYS", "bucket_name": "my-game-replays" }]
```

- The message is `{ id, room, endedAt, players, result, replayKey? }`. `result` is whatever you passed.
- The announcement is saved with the room in the same step as the hook's other changes, and sent afterwards. If the queue or bucket is unavailable it is sent on the room's next event, and meanwhile does not hold up anything else the room has to deliver. A hook that rejects announces nothing.
- `recordMatches` creates its table, `tickflare_matches`, on first use (the SQL is exported as `MATCHES_SCHEMA` if you prefer migrations), and stores a match once however often its message is delivered. `recentMatches(db, limit)` reads them back.
- Do your own post-match work in the same consumer: ratings, achievements, notifications.

### Worlds across rooms

One room is one thread with a limited amount of memory, so a large world is cut into cells with a room each. A room hands a player to the next one when they cross a border.

```ts
import { Room, shardFor, type Player } from "tickflare";

const CELL = 480;

export class Zone extends Room<State, Command, Env> {
  protected override onTick(dt: number): void {
    // ...move things...
    for (const [id, unit] of Object.entries(this.state.units)) {
      const home = shardFor(unit.worldX, unit.worldY, CELL, "overworld");
      if (home === this.roomId) continue;
      delete this.state.units[id];
      this.movePlayer(id, home, unit); // `unit` travels with the player
    }
  }

  // How to reach another room. Runs after the hook has committed.
  protected override async handOver(roomId: string, playerId: string, carry: unknown) {
    const rooms = this.env.ZONES;
    await rooms.get(rooms.idFromName(roomId)).arrive(roomId, playerId, carry);
  }

  // The other side: a player handed over by a neighbour takes their seat.
  protected override onArrive(player: Player, carry: unknown): void {
    this.state.units[player.id] = carry as Unit;
  }
}
```

- `shardFor(x, y, cellSize, world)` names the room for a position, e.g. `overworld_3_-2`. `cellOf(id, world)` reads the cell back.
- `movePlayer` gives up the seat as part of the hook's commit. The handover itself is saved with the room and delivered afterwards; if the other room cannot be reached it is tried again on the next event. Only then is the connection closed, with `4004` and the new room's id.
- The client follows by itself: it reconnects to the same URL with the new room id and calls `onMoved(roomId)`. From the game's point of view `onState` just starts delivering the new room's state.
- A player who was handed over is always admitted, even if the room is full or reserved.
- A player who is not connected when they are handed over is sent on, with the same `4004`, when they next connect to the room they left. So is one who comes back within half a minute of being told, in case the news never reached them. After that, connecting there is an ordinary join again.

#### Seeing across a border

Rooms can send each other messages, which is how a player near an edge sees what is on the other side:

```ts
protected override onTick(): void {
  // ...a few times a second, tell the room to the east what is near the shared border.
  this.signal(eastRoomId, { units: unitsNearEastBorder }, { onlyIfWatched: true });
}

protected override async relay(roomId: string, data: unknown) {
  const rooms = this.env.ZONES;
  return rooms.get(rooms.idFromName(roomId)).hear(this.roomId!, data);
}

protected override onSignal(fromRoomId: string, data: unknown): void {
  this.state.beyond[fromRoomId] = data; // part of the state, so players get it like anything else
}
```

- `signal` goes out once after the hook commits. It is not saved and not retried, which suits snapshots that the next one replaces.
- With `onlyIfWatched`, a room that reports nobody connected is left alone for two seconds at a time, so an empty neighbour is not kept awake.
- The arena example does exactly this for dots within 60 units of a wall.

### What the kernel does for you

- **Rollback.** If a hook calls `reject()` or throws, everything it did is undone: changes to `this.state`, timers it set or cleared, players it removed, and anything it wrote to the room's database itself. The same happens if the result cannot be saved, for instance a match result that is not JSON.
- **Persistence.** Every accepted change is written to the room's SQLite storage before anyone hears about it. A room that hibernates, restarts or is redeployed picks up where it left off, timers included.
- **Timers.** Any number of named timers share the object's single alarm. Each fires once; one whose hook throws is spent, not retried.
- **Ordering.** Each change gets the next `seq`. In event mode the sender's `ack` arrives after the `state` frame it caused, so when `send()` resolves the client already shows the result.
- **Seats and resume.** A player who drops keeps their seat until they leave, you remove them, or `seatTimeoutMs` runs out. When they reconnect they get the current state in the `welcome` frame; there is nothing to replay.
- **One connection per player.** A newer connection for the same player closes the older one.
- **Hidden information.** With `view()`, each player receives only their own projection of the state.
- **Rate limiting.** Each player may send `maxCommandsPerSecond` frames a second, with a burst of the same size. Frames over the limit are refused with `rate_limited` before they reach your code. The allowance belongs to the player, not the connection, so reconnecting does not refill it, and every frame counts, including the ones that cannot be read.

### Rules for hooks

- Hooks are **synchronous**. A hook that returns a promise is refused with `internal_error`, because the kernel cannot save or roll back work that finishes later.
- `this.state` must be **JSON-serializable**. It is stored and sent as JSON, in one database row, which Cloudflare limits to 2 MB.
- Change the state **only inside hooks**. What `onHttp` changes, or what a refused hook's promise changes later, is discarded.
- Identity is **established at the gateway**. Rooms trust the id your `authenticate` function returns; see [Identity](#identity). An `authenticate` that returns nothing is answered with 401.

## Protocol

JSON text frames over one WebSocket per player.

| Direction | Frame | Meaning |
| --- | --- | --- |
| client → room | `{ t: "cmd", id, data }` | A command. `id` is echoed in the answer |
| client → room | `{ t: "leave", id }` | Give up the seat. Answered like a command, then the room closes the connection |
| client → room | `ping` (plain text) | Keepalive. Answered with `pong` without waking the room |
| room → client | `{ t: "welcome", v, you, seq, tick, tickRate, state, players }` | First frame on every connection |
| room → client | `{ t: "state", seq, state }` | The state changed: the player's whole view |
| room → client | `{ t: "patch", seq, tick, p }` | The state changed during a tick: only the difference |
| room → client | `{ t: "presence", players }` | Someone joined, dropped or came back |
| room → client | `{ t: "ack", id, seq }` | Command or leave applied |
| room → client | `{ t: "reject", id, reason }` | Command or leave refused, state unchanged |
| room → client | `{ t: "error", reason }` | The frame could not be read |

A patch mirrors the shape of the state. For each key it holds a nested patch to go deeper, `[value]` to set the key, or `0` to delete it: `{ "units": { "u7": { "x": [12.5] }, "u3": 0 } }` moves one unit and removes another.

Close codes: `4000` replaced by a newer connection, `4001` room full, `4002` refused by `onJoin`, `4003` the seat is gone (the close reason is `left`, or whatever was passed to `removePlayer`). The client does not reconnect after these. `4004` means the player was handed to another room, named in the close reason; the client reconnects there.

## Not there yet

- In event mode the state is sent whole on every change.
- The client has no prediction helpers: in state sync a player sees their own input one round trip later.
- A ticking room keeps one tick per timer fire: if the object falls behind, the simulation slows down instead of catching up.
- Lockstep clients load the whole recording on every (re)connect and simulate it from turn 1. There are no snapshots to shortcut a long match yet.
- Lockstep hashes show that a desync happened and at which turn, not which player is wrong.
- Seeing across a border is a recipe built on `signal`, not something a room does by itself, and what arrives that way is a picture: a room cannot act on a neighbour's units.
- Handover is for rooms in event mode and state sync. A lockstep client does not follow a move.
- The matchmaker is first come, first served: no skill ratings.
- Match history is one table keyed by match, without a per-player index. Leaderboards are built from stats, not from matches.
- Accounts have no password reset: a player who forgets theirs needs you to set a new one with `setPassword`.
- What a room owes (a finished match, a handover) and could not deliver is tried again on the room's next event, not on a timer of its own. Delivery is at least once: after a crash at the wrong moment a handover or a match message can arrive twice.
- A replay passes through a row of the room's database on its way to R2, so it is limited to 2 MB as well.
- Rooms are never deleted. A room's storage, a lockstep recording included, stays until you remove it.
- A lockstep recording can be read by anyone the gateway lets through, seated or not.
- Players dropped by a deploy are not reported: `onDisconnect` is not called for them, though their seat timeout still starts.
- Join tokens scoped to a name are valid for the room and for the queue of that name.

## Roadmap

1. **Room kernel, event mode, TypeScript client** (done)
2. **State sync: a fixed-rate authoritative simulation with delta snapshots and visibility rules** (done)
3. **Lockstep: the room orders inputs, clients simulate deterministically; replays from the input log** (done)
4. **Matchmaking and the services around a room (D1, R2, Queues)** (done)
5. **World shards: large worlds split across rooms, with handoff between them** (first version: handover, naming and seeing across a border)

## Development

```sh
npm test            # runs the suite inside workerd via @cloudflare/vitest-plugin
npm run typecheck
npm run build       # emits dist/ for the tickflare and tickflare/client entry points
npm run dev         # the tic-tac-toe example on http://localhost:8787
npm run dev:arena   # the arena example
npm run dev:skirmish  # the skirmish example
npm run dev:ranked    # the ranked example
```

Every push runs the typecheck, the tests and the build in GitHub Actions ([`ci.yml`](.github/workflows/ci.yml)).

The tests in [`test/`](test) drive a fixture Worker over real WebSockets, including eviction of the room while sockets are open and timers are pending.

When you test your own rooms, `runDurableObjectAlarm(stub)` from `cloudflare:test` fires the room's earliest pending timer straight away, so you do not have to wait for the clock.

## Deploying the examples

[`deploy.yml`](.github/workflows/deploy.yml) deploys the examples to your Cloudflare account. Add two repository secrets under Settings → Secrets and variables → Actions:

- `CLOUDFLARE_API_TOKEN`: an API token created from the "Edit Cloudflare Workers" template.
- `CLOUDFLARE_ACCOUNT_ID`: the account to deploy to.

Then run "Deploy examples" from the Actions tab. Each example becomes a Worker named `tickflare-<example>` on your `workers.dev` subdomain.

The ranked example also uses a D1 database and a Queue, which the workflow creates. For that the token needs two more permissions than the template gives it: "D1: Edit" and "Queues: Edit". Without them the other three still deploy. The workflow replaces the development join-token secret from the config with one derived from your API token.

To deploy by hand instead: `npx wrangler deploy --config examples/arena/wrangler.jsonc --var JOIN_SECRET:<a long random value>`.

## Licence

[MIT](LICENSE)

---

Tickflare is an independent project and is not affiliated with Cloudflare.
