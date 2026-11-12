---
layout: home
title: Tickflare
titleTemplate: Multiplayer rooms on Cloudflare
---

<HomeHero />

<div class="tf-home">

<section class="tf-section">

## The code behind the demo

<p class="tf-lede">The demo above is this counter. A room with its rules, a Worker that lets players in, and a page. Nothing else: no servers to run, no database to set up by hand.</p>

::: code-group

```ts [src/counter.ts]
import { Room, reject, type Player } from "tickflare";

interface State {
  count: number;
  lastBy: string | null;
}

type Command = { type: "increment" };

export class Counter extends Room<State, Command> {
  protected override maxPlayers = 8;
  // A player whose tab closes keeps their seat for a minute.
  protected override seatTimeoutMs = 60_000;

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

```ts [src/index.ts]
import { Accounts, routeToRoom } from "tickflare";
export { Counter } from "./counter";

interface Env {
  ROOMS: DurableObjectNamespace;
  DB: D1Database;
  JOIN_SECRET: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const accounts = new Accounts(env.DB, { secret: env.JOIN_SECRET });
    return (
      // Guest identities, sign-up and sign-in, under /api/accounts.
      (await accounts.route(request)) ??
      // WebSockets on /rooms/<room id>, let in only with a valid identity.
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate: accounts.authenticate })) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
```

```html [public/index.html]
<!doctype html>
<meta charset="utf-8" />
<title>Counter</title>
<p><button id="add" disabled>+1</button> <span id="count">…</span></p>
<p id="who"></p>
<script type="module">
  import { AccountClient, RoomClient } from "./tickflare-client.js";

  const accounts = new AccountClient();
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const room = new RoomClient(`${scheme}://${location.host}/rooms/lobby`, {
    // Asked for a join token before every connection attempt.
    token: accounts.tokenSource,
  });

  room.on("state", (state) => {
    document.querySelector("#count").textContent = state.count;
  });
  room.on("presence", (players) => {
    const online = players.filter((player) => player.connected).length;
    document.querySelector("#who").textContent = `${online} online`;
  });
  room.on("status", (status) => {
    document.querySelector("#add").disabled = status !== "open";
  });

  document.querySelector("#add").addEventListener("click", async () => {
    try {
      await room.send({ type: "increment" });
    } catch (error) {
      alert(error.reason); // e.g. wait_for_someone_else
    }
  });
</script>
```

```jsonc [wrangler.jsonc]
{
  "name": "counter",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",
  "assets": { "directory": "./public" },
  "durable_objects": {
    "bindings": [{ "name": "ROOMS", "class_name": "Counter" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Counter"] }],
  "d1_databases": [{ "binding": "DB", "database_name": "counter" }],
  // For local development only. Use `wrangler secret put JOIN_SECRET` for a deployed Worker.
  "vars": { "JOIN_SECRET": "local-development-only-secret" }
}
```

:::

### Run it

<ol class="tf-steps">
<li>

Install Tickflare and Wrangler.

```sh
npm install github:Giamme/tickflare
npm install -D wrangler esbuild
```

</li>
<li>

Bundle the client for the page.

```sh
npx esbuild tickflare/client --bundle --format=esm --outfile=public/tickflare-client.js
```

</li>
<li>

Run it, and open it in two tabs.

```sh
npx wrangler dev
```

</li>
</ol>

</section>

<section class="tf-section">

## Three ways to keep players in step

<p class="tf-lede">Every room has the same kernel: seats, timers, saving and identity work the same way. What changes is when your code runs and what goes over the wire. Here is one second of it, for one player.</p>

<SyncModes />

</section>

<section class="tf-section">

## Add what your game needs

<p class="tf-lede">Each of these is a few lines on top of the counter, and has a guide of its own.</p>

<div class="tf-recipe">
<div>

### Real-time movement

Set a tick rate and the room runs a simulation, sending each player only what changed. [State sync](/guide/state-sync)

</div>
<div>

```ts
export class Arena extends Room<State, Command> {
  protected override tickRate = 20; // onTick runs 20 times a second

  protected override onTick(dt: number): void {
    for (const dot of Object.values(this.state.dots)) {
      dot.x += dot.vx * dt;
      dot.y += dot.vy * dt;
    }
  }
}
```

</div>
</div>

<div class="tf-recipe">
<div>

### Hidden information

Each player receives their own view of the state. Hands, fog of war and secret roles never reach the wrong screen. [State and views](/guide/state-and-views)

</div>
<div>

```ts
export class Poker extends Room<State, Command> {
  protected override view(player: Player) {
    return {
      table: this.state.table,
      hand: this.state.hands[player.id] ?? [],
    };
  }
}
```

</div>
</div>

<div class="tf-recipe">
<div>

### Accounts and leaderboards

Guests play at once and sign up later without losing anything. Data, stats and leaderboards live in D1. [Accounts](/guide/accounts)

</div>
<div>

```ts
// In the Worker
const accounts = new Accounts(env.DB, { secret: env.JOIN_SECRET });
await accounts.addStats(winner, { wins: 1 });

// In the page
const me = new AccountClient();
await me.register({ name: "Ada", password: "correct horse battery" });
const top = await me.leaderboard("wins");
```

</div>
</div>

<div class="tf-recipe">
<div>

### Matchmaking

A queue pairs waiting players and reserves a room for them, near where they are. [Matchmaking](/guide/matchmaking)

</div>
<div>

```ts
export class Lobby extends Matchmaker<Env> {
  protected override matchSize = 2;
  protected override rooms = this.env.ROOMS;
}

// In the page
const { room } = await findMatch(`wss://${location.host}/matchmaking/ranked`);
```

</div>
</div>

<div class="tf-recipe">
<div>

### Match results

A finished match goes through a Queue into D1, with its replay in R2, once however often it is delivered. [Match results](/guide/match-results)

</div>
<div>

```ts
export class Duel extends Room<State, Command, Env> {
  protected override matchQueue = this.env.MATCHES;

  protected onCommand(player: Player, command: Command): void {
    // ...
    if (this.state.won) this.finishMatch({ winner: player.id });
  }
}

// In the Worker's queue handler
await recordMatches(batch, env.DB);
```

</div>
</div>

<div class="tf-recipe">
<div>

### Worlds bigger than a room

Cut the world into cells. Players are handed from room to room as they cross a border. [Worlds across rooms](/guide/worlds)

</div>
<div>

```ts
export class Zone extends Room<State, Command, Env> {
  protected override rooms = this.env.ZONES;

  protected override onTick(dt: number): void {
    // ...when a unit walks into another cell:
    this.movePlayer(id, shardFor(unit.x, unit.y, 480), unit);
  }
}
```

</div>
</div>

</section>

<div class="tf-closing">

<p>Build your first room in about ten minutes.</p>

<div class="tf-closing-actions">
<a class="tf-button" href="/guide/getting-started">Get started</a>
<a class="tf-button tf-quiet" href="/guide/examples">See the examples</a>
</div>

</div>

</div>
