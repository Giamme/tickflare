# Plan: the next seven improvements

Written on 2026-11-14 for whoever implements it. It assumes no memory of the conversations that led here: everything needed is in this file or in the repository.

Delete each section when it is done, and delete the file when all are. Items 1 to 6 are done; their sections are gone, and what they found is under Order.

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

Only item 7 is left, and it waits for the owner. Item 3 is done as far as measurement allows: the per-tick work that grew with the square of the players is gone, binary patches are encoded once for players who share them, and the limits page has every Cloudflare run, including the ones that fell short (a thousand players with a view each hold ten ticks a second in about half the runs; binary patches with a view each are slower than JSON there, for reasons local profiling does not show). `viewKey` was not built: rooms where everyone sees the same are already at ten ticks a second. Item 6 is done: `tools/rooms-report.mjs` (`tickflare-rooms`), a sample of its output on the costs page, and a workflow for it in Force Projection's PR #39. Item 4 is done: interpolation and prediction in both engine clients, checked against `test/vectors/prediction.json`; a WebGL socket for Unity, compiled and never run; lockstep not ported, and `docs/guide/engines.md` says why. Unity in the editor stays untested (decision C). Item 1 is done: two 40-minute soaks on Cloudflare (510 rooms, 11 room-hours, `soak` in `bench/load.mjs`) found no room awake past its last player, and the limits page says the cause of the first run's two rooms is still unknown. Item 5 is done: parties come from join tokens (`JoinTokenClaims.party`), and `Matchmaker.teams` splits matches into sides. Item 2 is done: a running simulation keeps an alarm 30 seconds ahead (`AWAKE_MS` in `src/server/room.ts`), which also keeps Cloudflare from evicting a room whose players send nothing but keepalives.

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
