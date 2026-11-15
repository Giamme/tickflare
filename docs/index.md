---
layout: home
title: Tickflare
titleTemplate: Multiplayer rooms on Cloudflare
---

<script setup>
import { mode } from "./.vitepress/theme/demo/shared";
</script>

<HomeHero />

<div class="tf-home">

<section class="tf-code">

:::: details See the code for this demo

<div v-show="mode === 'event'">

The real thing is about as long as the demo is small: a room with the rules, a Worker that lets players in, and a page. The room sets no tick rate, so it runs only when a move or its timer wakes it.

::: code-group

<<< @/snippets/turns/src/duel.ts [src/duel.ts]

<<< @/snippets/turns/src/index.ts [src/index.ts]

<<< @/snippets/turns/public/index.html [public/index.html]

<<< @/snippets/turns/wrangler.jsonc [wrangler.jsonc]

:::

</div>
<div v-show="mode === 'sync'">

The real thing is about as long as the demo is small: a room with its rules, a Worker that lets players in, and a page. No servers to run and no database to set up by hand.

::: code-group

<<< @/snippets/arena/src/arena.ts [src/arena.ts]

<<< @/snippets/arena/src/index.ts [src/index.ts]

<<< @/snippets/arena/public/index.html [public/index.html]

<<< @/snippets/arena/wrangler.jsonc [wrangler.jsonc]

:::

</div>
<div v-show="mode === 'lockstep'">

The room is a dozen lines, because it never runs the game. The game is `sim.js`, which every player's browser runs over the same turns; after a reload the client starts from the room's latest snapshot and the turns since.

::: code-group

<<< @/snippets/lockstep/src/skirmish.ts [src/skirmish.ts]

<<< @/snippets/lockstep/public/sim.js [public/sim.js]

<<< @/snippets/lockstep/public/index.html [public/index.html]

<<< @/snippets/lockstep/src/index.ts [src/index.ts]

<<< @/snippets/lockstep/wrangler.jsonc [wrangler.jsonc]

:::

</div>

To run it yourself:

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

::::

</section>

<section class="tf-section">

## Three ways to keep players in step

<p class="tf-lede">Every room has the same kernel: seats, timers, saving and identity work the same way. What changes is when your code runs and what goes over the wire. Here is one second of it, for one player.</p>

<SyncModes />

</section>

<section class="tf-section">

## What runs where on Cloudflare

<p class="tf-lede">A Tickflare game is one Worker and the services it is bound to. There are no servers to size, patch or restart, and each service is billed for what it does.</p>

<CloudflareStack />

</section>

<section class="tf-section">

## What it costs

<p class="tf-lede">A room costs under a cent for each hour it runs, and nothing while it sleeps: between turns, between matches, or when it is empty. Bandwidth is free. So a game played in sessions is billed by the match, not by the server: at the size of a new game that is $5 a month, or nothing. Pick an example or put in your own numbers.</p>

<CostEstimator />

<p class="tf-more"><a href="/guide/costs">How these figures are worked out</a>, <a href="/guide/costs#designing-a-game-that-costs-less">how to design a game that costs less</a>, and <a href="/guide/costs#checking-what-you-are-billed-for">how to see what each of your rooms actually cost</a>.</p>

</section>

<section class="tf-section">

## Add what your game needs

<p class="tf-lede">Each of these is a few lines on top of a room like the ones above, and has a guide of its own.</p>

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

### Moves that show on the click

The page applies a player's own command before the room has answered, and the room's state corrects it when it arrives. A refused move is taken back. [Prediction](/guide/state-sync#showing-a-player-s-own-moves-at-once)

</div>
<div>

```ts
const predicted = new Predictor(room, {
  // What the room's onCommand does, for this player.
  apply(state, command, you) {
    Object.assign(state.dots[you], { tx: command.x, ty: command.y });
  },
  // What its onTick does to their own dot.
  tick: (state, you) => walk(state.dots[you], 1 / 20),
});

canvas.onclick = (e) => predicted.send({ type: "move", x: e.offsetX, y: e.offsetY });
draw(predicted.state);
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

Guests play at once and sign up later without losing anything. A forgotten password is set again with a recovery code or a link by email. Data, stats and leaderboards live in D1. [Accounts](/guide/accounts)

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

A queue puts waiting players together, by skill and by region if you like, keeps friends who queue together in one match and on one side, and reserves a room for them near where they are. [Matchmaking](/guide/matchmaking)

</div>
<div>

```ts
export class Lobby extends Matchmaker<Env> {
  protected override matchSize = 2;
  protected override rooms = this.env.ROOMS;
  // Within 150 rating points, and 10 more a second waited.
  protected override ratingGap = 150;
  protected override ratingGapPerSecond = 10;
  protected override ratingOf(player: string) {
    return rating(this.env, player);
  }
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

### Matches that finish without their players

A match that counts plays on when everyone has closed the tab, through deploys too, so it has a result whoever is still watching. [Playing on with nobody connected](/guide/state-sync#playing-on-with-nobody-connected)

</div>
<div>

```ts
export class Ranked extends Room<State, Command> {
  protected override tickRate = 10;

  protected override shouldTick(): boolean {
    return this.state.winner === null;
  }

  protected override ticksWhileEmpty(): boolean {
    return true;
  }
}
```

</div>
</div>

<div class="tf-recipe">
<div>

### Rooms that clean up after themselves

Say what becomes of a room when its last player is gone. A room that deletes itself takes its storage with it, and leaves nothing in your account. [When a room is over](/guide/rooms#when-a-room-is-over)

</div>
<div>

```ts
export class Match extends Room<State, Command> {
  protected override onEmpty(): void {
    if (this.state.over) this.deleteRoom();
    else this.setTimer("abandoned", 10 * 60_000); // time to come back
  }

  protected override onTimer(name: string): void {
    if (name === "abandoned" && this.players.length === 0) this.deleteRoom();
  }
}
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

<div class="tf-recipe">
<div>

### Godot and Unity

Both have a client: connect, reconnect, the state kept up to date, commands with the room's answer, and the browser client's interpolation and prediction. They ask for their patches in binary, a little over a third of the size, because an engine's WebSocket is not compressed. For other engines the protocol is written down, with test vectors. [Godot and Unity](/guide/engines)

</div>
<div>

```txt
wss://my-game.example/rooms/lobby?token=…&patches=b1

{"t":"patch","seq":2,"tick":2,"p":{"score":[8]}}   48 bytes
b1 00 02 02 00 01 01 03 08                          9 bytes
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
