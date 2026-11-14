# Plan: the next seven improvements

Written on 2026-11-14 for whoever implements it. It assumes no memory of the conversations that led here: everything needed is in this file or in the repository.

Delete each section when it is done, and delete the file when all are.

## Decisions the owner has to make first

These change what gets built. Ask before starting the item they belong to.

| # | Question | Needed for | Suggested answer |
| --- | --- | --- | --- |
| A | Is the Cloudflare account on the free or the paid Workers plan? | Item 1 | Free allows about 28 room-hours of ticking a day in total; the soak below is sized for 10. |
| B | A wake alarm for ticking rooms costs about 2% more per room-hour. Acceptable as a default? | Item 2 | Yes. |
| C | Can a Unity licence be put in the repository's secrets, or will the owner test in the editor by hand? | Item 4 | By hand, once, is enough to start. |
| D | When does the repository go public, and under which npm name? | Item 7 | Nothing in item 7 is done before the owner says so. |

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

2, then 1, then 6, 3, 5, 4, 7.

Item 2 comes first because item 1's soak test needs its fix and its diagnostics. Item 6 is small and reuses what item 1 teaches about the analytics. Item 7 waits for the owner. Tell the owner what was found after each item; do not batch the news.

---

## 1. Find out why two rooms stayed awake

**What happened.** In the first measurement on Cloudflare, two rooms (20,000 units with 20 players; 1,000 units with 100 players at 30 ticks) were still counted as active, and as sending messages, nine minutes after every player had disconnected. They stopped when the Worker was deleted. It has not happened in three runs since, nor locally.

**What is known.**

- In later runs, rooms that were restarted by Cloudflare (for memory) lost most of their connections, and the clients of the lost ones were never told: their `close()` got no answer. So connections can die on one side only.
- The message count of the two rooms grew at about one tick a second times their socket count, which fits a room restarted with default settings and still holding sockets it believed open.
- In the later runs the load script asked each room how it was two seconds after its players left. That request is itself an event, which makes the room look at its connections again. It may have hidden the problem.
- Since then a ticking room closes connections that are silent for `silentAfterMs` (two minutes). That bounds the damage. It does not explain it.

**Leading guess, unproven.** A room is restarted while its players are leaving. The new instance finds sockets still attached, takes them for connected, and resumes ticking. The closes that would have told it otherwise were delivered to the old instance, or never.

**Steps.**

1. Give the benchmark room (`bench/worker.ts`) a log it keeps in its own SQLite table, capped at a few hundred rows: instance started, simulation started and stopped, each connection closed with its code, each silent connection closed. Serve it from the existing `how` request with `?log=1`.
2. Add a command to the benchmark room that makes it restart itself (`this.ctx.abort()`), so a restart can be caused on purpose.
3. Add a `soak` scenario to `bench/load.mjs`: about 10 rooms of 20 to 100 players, for 30 to 45 minutes, in cycles. In each cycle the players join, play for 20 to 60 seconds, and go in one of these ways, chosen at random: a clean close; `terminate()` with no close frame; a clean close sent in the same moment as the restart command; a restart with the players staying. Record for every room when its last player went.
4. Do not ask the rooms how they are during the soak. Watch from outside: keep the Worker (`keep=yes`), wait 15 minutes, and ask the analytics by room (`mode=analytics`). A room whose active time is much longer than the time it had players is a hit. Only then read its log.
5. Run the soak twice: once with `silentAfterMs = 0` in the benchmark room, to let the problem show, and once with the default, to confirm the safeguard ends it within about two minutes.
6. Raise the workflow's timeout for this scenario and delete the Worker afterwards.

**Done when** either the cause is found, fixed, and covered by a test in `test/`, or the limits page says how many room-hours were run without it happening and that the cause is still unknown. Replace the paragraph "One thing from those runs is not explained" in `docs/guide/limits.md` either way.

**Cost.** Ten rooms for 45 minutes is 7.5 room-hours, under five cents on a paid plan. See question A.

---

## 2. A match resumes after Cloudflare restarts its room

**The suspected gap.** A room's simulation is a `setInterval` in memory. If Cloudflare restarts the room and the players' connections survive, nothing calls the new instance until a player sends a command: keepalives are answered by the runtime without waking the room. The players would look at a frozen game. `#load()` in `src/server/room.ts` already welcomes everyone again and resumes when it is called; the question is what calls it.

A room that ticks with nobody connected already has an answer: it keeps an alarm 20 seconds ahead of itself (`AWAKE_TIMER`, `#stayAwake()`). A room with players connected does not.

**This is unverified.** On a deploy Cloudflare closes the connections, the clients reconnect, and that wakes the room. Whether connections survive other restarts is not known; in the measurements, memory restarts dropped most of them.

**Steps.**

1. Write the failing test first, in `test/restarts.test.ts`: a ticking room, one client that only sends keepalives, restart the room (`abortAllDurableObjects`, or `ctx.abort()` through `runInDurableObject`), wait, and expect ticks to arrive again. If the local runtime closes the connection on abort, the test cannot show the gap: then test the mechanism instead (the alarm is set while ticking, and firing it on a fresh instance resumes the simulation).
2. Fix on the server, not in the clients: keep the awake alarm whenever the simulation should be running, not only when the room is alone. To limit the cost, arm it further ahead (60 seconds) and re-arm it when it is half used, at the moment the room saves anyway. That is about 120 alarm writes an hour next to the 720 state saves a ticking room already makes.
3. In the alarm handler nothing new is needed: `alarm()` calls `#load()`, which resumes.
4. Put the extra writes in the costs page's arithmetic (`docs/guide/costs.md` and its estimator in `docs/.vitepress/theme`), and in "Restarts and deploys" on the limits page say how long a match can stand still after a restart: up to the alarm's lead.
5. Confirm on Cloudflare during item 1's soak, with the restart command and players who stay.

**Considered and set aside.** A watchdog in the clients, which sends a frame when ticks stop arriving. It costs nothing while things work, but it needs a protocol change in three clients and does nothing for clients people write themselves.

**Done when** the test passes, the cost is on the costs page, and the soak shows a restarted room ticking again with its players.

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

## 4. Finish the engine clients

**Where they are.** Both connect, reconnect, keep the state from JSON and binary patches, send commands, and follow presence and room hand-over. Neither has interpolation, prediction or lockstep. The Unity client has never run inside the Unity editor, and has no socket for WebGL builds.

**Steps, in this order.**

1. **Interpolation.** Port `src/client/interpolate.ts` (60 lines) to GDScript and C#. It is small and self-contained.
2. **Prediction.** Port `src/client/predict.ts`. One real difference: the TypeScript client never changes a state object, it makes new ones (`produce` in `src/client/draft.ts`), while the engine clients change the state in place. So the engine predictor has to keep the room's state and the predicted one apart: a deep copy of the room's state, with the unconfirmed commands applied to the copy, redone when a frame arrives or a command is sent, not on every rendered frame. Use the `c` field of frames and the `tick` of acks as the protocol reference describes.
3. **Shared test cases.** As for binary patches, generate cases from the TypeScript tests into `test/vectors/`: a list of frames and commands in, the states a player is shown out. All three clients run the same cases. This is what keeps three implementations the same.
4. **Unity in the editor.** Needs the owner (question C). At the least: install the package from the git URL in a real project, put `TickflareRunner` on an object, connect to a deployed example. Write down the result in `clients/unity/README.md`, which today says it is untested.
5. **Unity on WebGL.** An `ITickflareSocket` on the browser's WebSocket: a `.jslib` file and a small C# class. It cannot be tested without Unity either; ship it marked as untested until the owner has run it.
6. **Lockstep, last, and only after checking it is possible.** Lockstep needs every client to compute the same simulation and the same hash. The hash in `src/lockstep.ts` is the SHA-256 of the state as JSON, so two engines agree only if they write numbers as text identically, and floating-point results can differ between engines anyway. Before porting, decide and document: lockstep between clients of the same engine only, with a hash the game supplies. If that is not good enough, do not build it.

**Done when** items 1 to 3 pass in CI for both engines and `docs/guide/engines.md` no longer lists them as missing. Items 4 to 6 are each done or listed there as still open, truthfully.

---

## 5. Parties and teams in matchmaking

**Where it is.** `src/server/matchmaker.ts` matches single players, by rating and region if asked. It does not keep friends together and does not say who is on which side.

**Parties.**

1. A hook like `ratingOf`: `partyOf(player, request)`, returning a party id and its size, or nothing. Who is in a party has to be something the server can trust: by default read it from the join token (see what `src/server/tokens.ts` can carry and extend it if needed), not from the query string.
2. The matchmaker holds a party's members until all of them are waiting, or until a time limit, after which those who came are matched as a smaller party.
3. A party is matched as one unit: it takes as many places as it has members, it is never split, and its rating is its members' average.
4. Tests in `test/matchmaking.test.ts`, with test matchmakers in `test/worker.ts` as for rating and region.

**Teams.**

1. A setting, `teams = 1` by default. With more, the matchmaker splits each match into that many sides: parties stay together, and the sides' rating totals are made as equal as a simple greedy split can.
2. The `match` message gains `teams`, a list of lists of player ids, and the reserved room can read it next to `this.invited`. That is a change to the matchmaking part of the protocol: document it.
3. Tests, the matchmaking guide (it has a section "What is not there yet" to shrink), the `ranked` example, the home page recipe.

**Done when** two friends who queue together always land in the same match on the same side, in a test, and the guide says how.

---

## 6. A tool that shows which rooms are awake

**Why.** A room that stays awake is billed, and today the only way to see it is Cloudflare's dashboard. `bench/analytics.mjs` already asks Cloudflare's analytics for active time, CPU time, billed duration and connections by room; it only needs pointing at a real Worker.

**Steps.**

1. Turn it into `tools/rooms-report.mjs`: arguments for the Worker's name and a period (`--since 24h`); it finds the Worker's Durable Object namespaces itself, as the measure workflow does; it prints one line per room with active time, what that cost, and the most connections it had, sorted by cost, and marks rooms that were awake with nobody connected or awake for hours.
2. It needs an API token that may read account analytics. The token in the repository's secrets could on 2026-11-14. Run from a laptop it takes the token from the environment; never from an argument.
3. Document it on the costs page under a heading such as "Checking what you are billed for", with what the numbers mean. The dataset and its fields are printed by `node bench/analytics.mjs --describe` (mode `describe` of the workflow).
4. For Force Projection, a small workflow started by hand that runs the report on the game's Worker, as a pull request against `dev`. Mask the account's address in its output as the measure workflow does.

**Done when** the report runs against a deployed Worker and the costs page shows a sample of its output.

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
