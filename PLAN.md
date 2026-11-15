# Plan: the next seven improvements

Written on 2026-11-14 for whoever implements it. It assumes no memory of the conversations that led here: everything needed is in this file or in the repository.

Delete each section when it is done, and delete the file when all are.

## Decisions the owner made (2026-11-15)

| # | Question | Answer |
| --- | --- | --- |
| A | Free or paid Workers plan? | Paid. The full soak in item 1 is fine. |
| B | A wake alarm for ticking rooms, about 2% more per room-hour, on by default? | Yes, on by default. Done. |
| C | Unity licence in the secrets, or testing in the editor by hand? | Neither for now: skip editor testing; the docs keep saying it is untested in the editor. |
| D | Start item 7, going public? | Not yet. Leave item 7 untouched. |

## Rules that hold for all of it

**Tickflare** (`Giamme/tickflare`, this repository)

- Commit straight to `main`. No pull requests, no tags, no releases until the owner says the repository goes public.
- Breaking API changes are fine before 1.0. Say so in the changelog.
- The cost of running on Cloudflare with default settings is a priority. A change that adds storage writes, alarms or awake time has to say how much, on the costs page.
- Every change updates, in the same commit or the next: the guide pages it touches, `docs/guide/limits.md`, `docs/guide/costs.md` if cost changes, `docs/reference/protocol.md` if the wire changes, the home page (`docs/index.md`), `README.md` and `CHANGELOG.md` (under "Unreleased").
- `CHANGELOG.md` is included in `docs/reference/upgrading.md`, so it must not contain links relative to the repository root: the docs build fails on them.
- The docs are written plainly, in short sentences, with the limits stated. Read two pages before writing one.
- End commit messages with the attribution lines the session gives.

**Checks before every push**

```sh
npm run typecheck
npx vitest run                      # about 90 s; 494 tests on 2026-11-14
cd docs && npm run build            # fails on dead links and undocumented exports
```

Tests that depend on timing have failed on slow CI runners before. For a new test with a wait in it, run it three times with the machine loaded (`for n in 1 2 3 4 5 6; do (yes > /dev/null &); done`, then `pkill yes`) and make it pass.

`evictDurableObject` hangs on a room that is ticking. Stop the simulation first, or use `abortAllDurableObjects`.

**Engine clients** (`clients/godot`, `clients/unity`)

Neither engine runs in the development workspace: Godot may not be executed there and .NET cannot be installed. Both are tested only in CI (`godot-client` and `unity-client` in `.github/workflows/ci.yml`), against the Worker in `clients/test-server`. Write the test first, push, read the job log with `gh api repos/Giamme/tickflare/actions/jobs/<id>/logs`, and iterate. Make each test report every failure in one run.

**Measuring on Cloudflare**

- Credentials exist only as repository secrets. Never print them, never ask for them.
- Use the workflow *Measure on Cloudflare* (`.github/workflows/measure.yml`), started with `gh api -X POST repos/Giamme/tickflare/actions/workflows/measure.yml/dispatches -f ref=main -f "inputs[mode]=measure" -f "inputs[scenarios]=rates"`. Modes: `measure`, `analytics`, `describe`, `delete`.
- The account's workers.dev address and the per-run key are masked in the logs. Keep them masked in anything new.
- A run deletes its Worker at the end. With `keep=yes` it does not: delete it afterwards with `mode=delete`, and check the log says `Deleted`. A Worker left behind with rooms awake is billed.
- Logs of a job are only readable once the job has ended.
- Cloudflare's analytics lag by 10 to 15 minutes and fill in gradually. A room's row can be incomplete for a while.

**Force Projection** (`Giamme/force-projection`, the game built on Tickflare)

- Work goes in pull requests against `dev`. The owner merges them. A merge deploys to production.
- Tickflare is vendored: `scripts/vendor-tickflare.sh ../tickflare`.
- Browser tests are paused in CI. Run them locally: `rm -rf server/.wrangler/state && E2E_TIER=smoke npx playwright test -c playwright.local.config.ts`.
- PR #39 (open on 2026-11-14) vendors Tickflare `cc1a53a`. After items 1 to 3, open a new PR with the newer version rather than growing that one, unless it is still unmerged.

## Order

3, 7. Item 6 is done: `tools/rooms-report.mjs` (`tickflare-rooms`), a sample of its output on the costs page, and a workflow for it in Force Projection's PR #39. Item 4 is done: interpolation and prediction in both engine clients, checked against `test/vectors/prediction.json`; a WebGL socket for Unity, compiled and never run; lockstep not ported, and `docs/guide/engines.md` says why. Unity in the editor stays untested (decision C). Item 1 is done: two 40-minute soaks on Cloudflare (510 rooms, 11 room-hours, `soak` in `bench/load.mjs`) found no room awake past its last player, and the limits page says the cause of the first run's two rooms is still unknown. Item 5 is done: parties come from join tokens (`JoinTokenClaims.party`), and `Matchmaker.teams` splits matches into sides. Item 2 is done: a running simulation keeps an alarm 30 seconds ahead (`AWAKE_MS` in `src/server/room.ts`), which also keeps Cloudflare from evicting a room whose players send nothing but keepalives. Item 7 waits for the owner. Tell the owner what was found after each item; do not batch the news.

---

## 3. Cheaper views for many players

**The limit.** On Cloudflare, 1,000 players who each see their own part of 1,000 units got 1.3 ticks a second out of 10. Five hundred got 9.8. A thousand who all see the same thing got 9.5. So the cost is the per-player work: `#broadcastTick()` in `src/server/room.ts` calls `view()` for every connection on every tick, and `DeltaSender.send` in `src/server/delta.ts` compares each result with what that player was last sent.

**Steps.**

1. Measure before designing. Run the benchmark room locally with 1,000 players by sight (`BENCH_TABLE='[{"units":1000,"sight":100,"players":1000,"rate":10}]' ... node bench/load.mjs rates` against `wrangler dev --config bench/wrangler.jsonc`) and time the parts of a tick: the game's `view()`, the comparison, turning the patch into JSON, and `send`. Local clocks work inside a Worker under `wrangler dev`; on Cloudflare they do not advance during computation, so this can only be done locally. Write the split down in the commit message.
2. Choose by what the measurement says. The candidates, cheapest first:
   - **Players who share a view.** A new optional hook, `viewKey(player)`, returning a string. Players with the same key get one `view()` call, one comparison and one piece of JSON per tick. This is what teams and spectators need. Connections only share while they hold the same thing: one that has just been welcomed goes its own way for a tick, then joins its group.
   - **Sending some players less often.** A hook that says a player's view is sent every n-th tick. Linear saving, simple, and wrong for players in the middle of the action, so it is the game's call.
   - **The benchmark's own `view()`** filters 1,000 units for each of 1,000 players, a million checks a tick. If that is where the time goes, the fix is advice for games (keep units in a grid), not a change to Tickflare: say so in the guide and change the benchmark to do it.
3. Tests for whatever is built: every player receives exactly their own view, through joins, leaves, reconnects and a room restart. `test/delta.test.ts` has mirrors that replay what a client holds; extend those.
4. Measure again on Cloudflare (`scenarios=rates`) and replace the row in the limits page.

**Done when** the 1,000-player row with a view each is at 8 ticks a second or better on Cloudflare, or the limits page explains from measurement why it is not and what a game can do. No other row gets worse.

---

## 7. Getting ready to go public

**Nothing here starts before the owner says so** (question D). Until then: no version tags, no publishing.

**For the owner to decide:** the npm name and whether it is free; where the docs are hosted; whether the engine clients are also published where their users look (Godot's asset library, OpenUPM); a contact for security reports that is not a private address.

**Before the repository is made public.**

1. **Look for what should not be public.** Search the files and the whole git history for the Cloudflare account's address, account ids, email addresses, and the game's production URL. Then the Actions logs: on a public repository the logs of old workflow runs are public too. The measure runs mask the account's address, but check, and delete old runs if in doubt.
2. `package.json`: remove `"private": true`, check `files` and `exports`, add `repository`, `homepage`, `keywords`.
3. A release workflow: on a version tag, build, test, publish to npm with provenance.
4. `CHANGELOG.md`: turn "Unreleased" into the first version, and say how versions will work before 1.0.
5. `README.md` and the getting-started guide: install from npm. The examples: depend on the published package.
6. `CONTRIBUTING.md`, `SECURITY.md`, issue templates.
7. The limits page's "How far it has been tested" section, read once more as a stranger would.

**After publishing.** In Force Projection, replace the vendored copy with the npm dependency, as a pull request against `dev`, and delete `scripts/vendor-tickflare.sh`.

**Done when** `npm install tickflare` in an empty project followed by the getting-started guide leads to a running room, and the owner has made the repository public.
