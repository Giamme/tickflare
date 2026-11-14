# Tickflare

[![CI](https://github.com/Giamme/tickflare/actions/workflows/ci.yml/badge.svg)](https://github.com/Giamme/tickflare/actions/workflows/ci.yml)

A multiplayer game framework for Cloudflare Workers and Durable Objects.

Each room is one Durable Object: a single-threaded, authoritative server with its own storage, placed on Cloudflare's network. Tickflare gives that object a game-shaped API. You write the rules; it handles connections, persistence, reconnects and what each player is allowed to see.

It is aimed at turn-based, card, co-op, `.io`-style and strategy games. Games that need UDP and rollback netcode (shooters, fighting games, sim racing) are out of scope.

**[Read the documentation](docs/guide/introduction.md)** · [Getting started](docs/guide/getting-started.md) · [Changelog](CHANGELOG.md)

The guides read fine on GitHub. The API reference is generated from the doc comments, so it is only on the built site: `npm run docs:dev` serves it locally.

## A room

```ts
import { Room, reject, type Player } from "tickflare";

interface State {
  count: number;
  lastBy: string | null;
}
type Command = { type: "increment" };

export class Counter extends Room<State, Command> {
  protected override maxPlayers = 8;

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
// In the browser
import { AccountClient, RoomClient } from "tickflare/client";

const accounts = new AccountClient();
const room = new RoomClient(`wss://${location.host}/rooms/lobby`, { token: accounts.tokenSource });
room.on("state", (state) => render(state));
await room.send({ type: "increment" }); // resolves once applied; rejects with the reason if refused
```

The room saves every change before anyone hears about it, rolls back what `reject()` refuses, keeps seats for players who drop, and sends everyone what changed. [Getting started](docs/guide/getting-started.md) builds this into a working game in about ten minutes.

## What's in it

- **Three sync modes** on one room kernel: [event mode](docs/guide/rooms.md) for turn-based games, [state sync](docs/guide/state-sync.md) for real-time ones, [lockstep](docs/guide/lockstep.md) for strategy games with many units.
- **Patches, not snapshots**: a player is sent what changed in their own [view](docs/guide/state-and-views.md) of the state, after a move as after a tick.
- **[Lockstep snapshots](docs/guide/lockstep.md#snapshots)**: a player who joins or reloads late starts from a simulation the other players' clients saved and agreed on, not from the first turn.
- **[Rooms that end](docs/guide/rooms.md#when-a-room-is-over)**: a hook for when the last player is gone, rooms that delete themselves with their storage, and matches that [play on](docs/guide/state-sync.md#playing-on-with-nobody-connected) with nobody connected.
- **[Identity](docs/guide/identity.md)** decided once, at the gateway, with signed join tokens.
- **[Accounts](docs/guide/accounts.md)** on D1: guests, sign-up, sessions, player data, stats and leaderboards.
- **[Matchmaking](docs/guide/matchmaking.md)** that reserves a room near its players, and **[match results](docs/guide/match-results.md)** through a Queue into D1, with replays in R2.
- **[Worlds across rooms](docs/guide/worlds.md)**: handover between rooms and seeing across borders.
- **[A client](docs/guide/client.md)** for browsers and Node that reconnects on its own.

## Install

Tickflare is at 0.1 and not on npm yet. Install it from GitHub; it builds on install:

```sh
npm install github:Giamme/tickflare
```

## Examples

Four complete games live in [`examples/`](examples): tic-tac-toe (event mode), an arena (state sync and handover), a skirmish (lockstep) and ranked tic-tac-toe (matchmaking and results). See [Examples](docs/guide/examples.md).

```sh
npm install
npm run dev   # tic-tac-toe on http://localhost:8787
```

## Development

```sh
npm test            # the suite, inside workerd via @cloudflare/vitest-plugin
npm run typecheck
npm run build       # dist/ for the tickflare and tickflare/client entry points
npm run docs:dev    # the documentation site on http://localhost:5173
```

The documentation lives in [`docs/`](docs): guides in Markdown, and an API reference generated from the doc comments in `src/`. Every export needs a doc comment, or the docs build fails. [`docs.yml`](.github/workflows/docs.yml) builds the site on every change and deploys it to Cloudflare from `main`.

## Licence

[MIT](LICENSE)

---

Tickflare is an independent project and is not affiliated with Cloudflare.
