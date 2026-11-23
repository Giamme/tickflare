# Examples

The repository has four complete games in [`examples/`](https://github.com/Giamme/tickflare/tree/main/examples). Each is a Worker with its rooms and a single page, and each is deployed, to play in two tabs or with someone else:

- [Tic-tac-toe](https://tickflare-tic-tac-toe.gridpaper.dev)
- [Arena](https://tickflare-arena.gridpaper.dev)
- [Skirmish](https://tickflare-skirmish.gridpaper.dev)
- [Ranked tic-tac-toe](https://tickflare-ranked.gridpaper.dev)

To run them yourself, from a clone of the repository:

```sh
git clone https://github.com/Giamme/tickflare && cd tickflare
npm install
npm run dev           # tic-tac-toe
npm run dev:arena     # arena
npm run dev:skirmish  # skirmish
npm run dev:ranked    # ranked tic-tac-toe
```

Then open <http://localhost:8787> in two tabs, or more: each tab is another player.

## Tic-tac-toe: event mode

[Play it](https://tickflare-tic-tac-toe.gridpaper.dev) · [`examples/tic-tac-toe`](https://github.com/Giamme/tickflare/tree/main/examples/tic-tac-toe)

Two players, one board. Reload a tab mid-game and it resumes. Each move is on a 30-second clock, and a tab that stays closed for 30 seconds loses its seat.

Shows: commands and `reject()`, seats and `seatTimeoutMs`, a turn clock with `setTimer` and the deadline in the state, join tokens for guests.

## Arena: state sync and worlds

[Play it](https://tickflare-arena.gridpaper.dev) · [`examples/arena`](https://github.com/Giamme/tickflare/tree/main/examples/arena)

A real-time room at 20 ticks a second: click to move a dot and eat pellets. Your own dot sets off on the click, ahead of the room's answer. It is also a row of rooms: walk into the left or right wall and the dot is handed to the arena next door, and dots near a wall are visible from the other side.

Shows: `tickRate` and `onTick`, patches, `Interpolator`, `BufferedInterpolator`, `Predictor`, `movePlayer` and `onArrive`, `signal` and `onSignal`.

## Skirmish: lockstep

[Play it](https://tickflare-skirmish.gridpaper.dev) · [`examples/skirmish`](https://github.com/Giamme/tickflare/tree/main/examples/skirmish)

Each tab commands a squad and simulates the whole battle itself, at 10 turns a second. A fingerprint on screen shows the tabs agree.

Shows: `LockstepRoom` and `parseInput`, `LockstepClient`, `seededRandom`, `save` and `load` for snapshots and desync detection, catching up on reload.

## Ranked tic-tac-toe: matchmaking and results

[Play it](https://tickflare-ranked.gridpaper.dev) · [`examples/ranked`](https://github.com/Giamme/tickflare/tree/main/examples/ranked)

The tic-tac-toe of the first example with what surrounds a room: a matchmaker pairs players and reserves their room, and every finished game travels through a Queue into D1 and shows up in the lobby.

Shows: `Matchmaker` and `findMatch`, reserved rooms, `finishMatch`, `recordMatches` and `recentMatches`.

## Deploying the examples

The repository's [`deploy.yml`](https://github.com/Giamme/tickflare/blob/main/.github/workflows/deploy.yml) workflow deploys the examples to your Cloudflare account. Add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as repository secrets, then run "Deploy examples" from the Actions tab. Each example becomes a Worker named `tickflare-<example>` on your `workers.dev` subdomain. To serve them from a domain of yours on the same account instead, set the repository variable `SITE_DOMAIN` to it: with `example.com`, the arena is at `tickflare-arena.example.com`. The ranked example also needs "D1: Edit" and "Queues: Edit" on the token.
