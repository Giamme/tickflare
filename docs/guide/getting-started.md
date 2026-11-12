# Getting started

This page builds a small shared counter from an empty folder: a room that players connect to, a Worker in front of it, and a web page. Anyone with the page open can press the button, and everyone sees the count change. It takes about ten minutes.

You need Node 22 or later. A Cloudflare account is only needed to deploy at the end.

## Install

Tickflare is not on npm yet. Install it from GitHub, together with Wrangler, Cloudflare's command-line tool:

```sh
mkdir counter && cd counter
npm init -y
npm install github:Giamme/tickflare
npm install --save-dev wrangler esbuild
```

The package builds itself on install. It has two entry points:

- `tickflare` is the server side, for your Worker.
- `tickflare/client` is the client side, for the page.

## Write the room

A room is a class that extends `Room`. It has a state, a way to read commands from players, and the rules for applying them.

```ts
// src/counter.ts
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

A few things are happening here that you don't see:

- `onCommand` changes `this.state` in place. When it returns, the room saves the new state to its storage and sends it to every connected player.
- `reject()` refuses the command. Anything the hook changed before calling it is rolled back, and the player who sent the command gets the reason.
- The room remembers who holds a seat. A player who reloads the page comes back to the same seat and gets the current state.

## Put a Worker in front

Players don't connect to the room directly. They connect to your Worker, which works out who they are and forwards the connection to the right room.

```ts
// src/index.ts
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

`Accounts` gives every visitor a guest identity they can later turn into an account. Rooms trust only the player id that `authenticate` returns, so a player can't pretend to be someone else. [Identity and join tokens](./identity) explains this, and other ways to do it.

## Configure Wrangler

```jsonc
// wrangler.jsonc
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

- The Durable Object binding is how the Worker reaches rooms.
- The migration tells Cloudflare that `Counter` is a class with SQLite storage, which is what rooms use.
- The D1 database holds accounts. Wrangler creates it when you first deploy.

::: tip Types in your editor
Run `npx wrangler types` to generate `worker-configuration.d.ts`, with the Workers runtime types and your bindings, and point a `tsconfig.json` at it with `"types": ["./worker-configuration.d.ts"]`. Wrangler runs your TypeScript without one; this is only for checking it.
:::

## Write the page

```html
<!-- public/index.html -->
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

`room.send()` resolves once the room has applied the command, and rejects with the reason if the room refused it. The client reconnects on its own if the connection drops.

The page imports the client as one file. Bundle it with esbuild:

```sh
npx esbuild tickflare/client --bundle --format=esm --outfile=public/tickflare-client.js
```

## Run it

```sh
npx wrangler dev
```

Open <http://localhost:8787> in two tabs and press the button in each. Reload a tab and the count is still there; close both and come back later, and it still is.

## Deploy

```sh
npx wrangler login
npx wrangler secret put JOIN_SECRET   # a long random value
npx wrangler deploy
```

Wrangler creates the D1 database and the Durable Object namespace on the first deploy and prints your Worker's URL. Remove the `vars` block from `wrangler.jsonc` first, so the development secret isn't deployed. [Deploying](./deploying) covers secrets, environments and CI.

## Where to go next

- [Rooms and hooks](./rooms): every hook, and what the room does around them.
- [State and views](./state-and-views): hidden information, so each player sees only their part.
- [State sync](./state-sync) and [Lockstep](./lockstep), for real-time games.
- [Examples](./examples): four complete games in the repository.
