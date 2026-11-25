# Tickflare

[![CI](https://github.com/Giamme/tickflare/actions/workflows/ci.yml/badge.svg)](https://github.com/Giamme/tickflare/actions/workflows/ci.yml)

A multiplayer game framework for Cloudflare Workers and Durable Objects.

Each room is one Durable Object: a single-threaded, authoritative server with its own storage, placed on Cloudflare's network. Tickflare gives that object a game-shaped API. You write the rules; it handles connections, persistence, reconnects and what each player is allowed to see.

It is aimed at turn-based, card, co-op, `.io`-style and strategy games. Games that need UDP and rollback netcode (shooters, fighting games, sim racing) are out of scope.

**[Documentation](https://tickflare.gridpaper.dev)** · [Getting started](https://tickflare.gridpaper.dev/guide/getting-started) · [Examples to play](https://tickflare.gridpaper.dev/guide/examples) · [Changelog](CHANGELOG.md)

The guides are also in [`docs/guide`](docs/guide/introduction.md) and read fine on GitHub; the API reference is only on the site.

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
- **Patches, not snapshots**: a player is sent what changed in their own [view](docs/guide/state-and-views.md) of the state, after a move as after a tick, and a room can [simulate more often than it sends](docs/guide/state-sync.md#sending-less-often-than-you-simulate).
- **[Lockstep snapshots](docs/guide/lockstep.md#snapshots)**: a player who joins or reloads late starts from a simulation the other players' clients saved and agreed on, not from the first turn.
- **[Rooms that end](docs/guide/rooms.md#when-a-room-is-over)**: a hook for when the last player is gone, rooms that delete themselves with their storage, and matches that [play on](docs/guide/state-sync.md#playing-on-with-nobody-connected) with nobody connected.
- **[Spectators](docs/guide/spectators.md)**: connections that watch without a seat, with a view of their own, kept as many seconds behind the players as the room says.
- **[Identity](docs/guide/identity.md)** decided once, at the gateway, with signed join tokens.
- **[Accounts](docs/guide/accounts.md)** on D1: guests, sign-up, sessions, password recovery, player data, stats and leaderboards.
- **[Matchmaking](docs/guide/matchmaking.md)** by skill and region, with parties and teams, which reserves a room near its players, and **[match results](docs/guide/match-results.md)** through a Queue into D1, with replays in R2.
- **[Worlds across rooms](docs/guide/worlds.md)**: handover between rooms and seeing across borders.
- **[A report of what each room cost](docs/guide/costs.md#checking-what-you-are-billed-for)**, from Cloudflare's own analytics, which marks rooms that stayed awake with nobody in them.
- **[Clients for Godot and Unity](docs/guide/engines.md)**, with the browser client's interpolation and prediction, and **[a written-down protocol](docs/reference/protocol.md)** for other engines, with binary patches for those whose WebSocket is not compressed.
- **[A client](docs/guide/client.md)** for browsers and Node that reconnects on its own, with [no command lost or applied twice](docs/guide/client.md#when-the-connection-drops) on the way, and **[prediction](docs/guide/state-sync.md#showing-a-players-own-moves-at-once)**: a player's own move shows on the click and is corrected by the room. For shots, the room can [judge a command by the tick its player was looking at](docs/guide/state-sync.md#judging-a-command-by-what-its-player-saw).
- **[Measured on Cloudflare](docs/guide/limits.md#the-same-rooms-on-cloudflare)**: what a room holds, such as five hundred players who each see their own part of the world at ten ticks a second, with every run written down, the ones that fell short included.

## Install

```sh
npm install tickflare
npm install --save-dev wrangler
```

Tickflare is at 0.1: expect the API to change before 1.0. The [changelog](CHANGELOG.md) says how versions work until then, and what to change when one breaks something.

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

[`bench/`](bench) holds a room in which everything moves on every tick and the scripts that load it; the *Measure on Cloudflare* workflow deploys it under a key made for the run, measures, can ask Cloudflare for a CPU profile of a room, and deletes it.

Releases are automatic: each change that lands on `main` with a [changelog fragment](CONTRIBUTING.md#what-a-pull-request-needs) is released to npm, with its section in the changelog and a GitHub release.

The documentation lives in [`docs/`](docs): guides in Markdown, and an API reference generated from the doc comments in `src/`. Every export needs a doc comment, or the docs build fails. [`docs.yml`](.github/workflows/docs.yml) builds the site on every change and deploys it to Cloudflare from `main`.

## Licence

[MIT](LICENSE)

---

Tickflare is an independent project and is not affiliated with Cloudflare.
