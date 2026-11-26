# Contributing

Thank you for wanting to help. Bug reports, questions about something the docs leave unclear, and pull requests are all welcome.

## Before you start

For anything bigger than a fix, open an issue first and say what you have in mind, so that we can agree on the shape of it before you spend time on code. Tickflare is at 0.x: the API can still change, but each change has to earn its place in the [changelog](CHANGELOG.md), with what users have to do about it.

Games that need UDP and rollback netcode are out of scope; so is anything that only works off Cloudflare.

## Setting up

You need Node 22 or later.

```sh
git clone https://github.com/Giamme/tickflare && cd tickflare
npm install
npm test            # the suite, inside workerd, Cloudflare's runtime
npm run typecheck
npm run docs:dev    # the documentation site on http://localhost:5173
npm run dev         # the tic-tac-toe example on http://localhost:8787
```

The Godot and Unity clients have tests of their own in `clients/`, which CI runs in Godot and on .NET. You need neither to change the TypeScript side, but a change to the protocol has to keep them passing.

## What a pull request needs

- **Tests.** A fix comes with a test that fails without it. Tests run in workerd through `@cloudflare/vitest-plugin`, against real Durable Objects; `test/worker.ts` has the rooms they use. `test/random.test.ts` drops connections and restarts rooms in an order drawn from a seed, and checks that no command is lost or applied twice. After a change to how rooms and clients reconnect, search further than the six seeds CI runs: `RANDOM_RUNS=200 npx vitest run test/random.test.ts` takes about five minutes. A run that fails prints its seed, and `RANDOM_SEEDS=72` runs that one again.
- **Docs, in the same pull request.** A change that a user can see changes the guide page that describes it, and, if it applies, the [limits](docs/guide/limits.md) and [costs](docs/guide/costs.md) pages, the [protocol](docs/reference/protocol.md), the README and the home page (`docs/index.md`). Every export needs a doc comment: the docs build fails without one, and on dead links.
- **A changelog fragment** for each change a user can see: a small Markdown file in [`.changelog/unreleased/`](.changelog/README.md), in the same commit as the change. Don't edit `CHANGELOG.md`; fragments are compiled into it when the version is released. Make one with `python3 .changelog/changelogger.py new --type fixed --text "Rooms saved by an older version load."`, or write the file yourself:

  ```
  ---
  type: fixed        # added | changed | deprecated | removed | fixed | security
  breaking: false    # true if users have to change something; then say what in the text
  ---
  Rooms saved by an older version load.
  ```

  Write it for someone using Tickflare: what changed for them, and what to do if it breaks something. The changelog is also a page of the docs, so link to the site (`https://tickflare.gridpaper.dev/...`) rather than to files in the repository. The home page lists the latest version's fragments under *New in*: the first sentence of each, and a link to the last page of the site it names. So make the first sentence say the change by itself, and end with `See [the guide's section](https://tickflare.gridpaper.dev/guide/...)`. A commit nobody using Tickflare would notice (tests, CI, a refactor) needs no fragment if its message starts with `test:`, `ci:`, `refactor:`, `docs:` or `chore:`, or says `[skip changelog]`. CI checks every pull request for this.
- **The protocol stays readable by old clients.** A change to what goes over the wire raises `PROTOCOL_VERSION` and keeps answering clients that ask for an older one, and comes with test vectors in `test/vectors/` if it touches binary patches or prediction.
- **Two versions run at once.** Cloudflare [defers code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/) to Durable Objects: after a deploy a busy room stays on the old code for minutes, or for as long as the game has asked, behind a Worker that has the new, and a room that slept through the deploy wakes on the new code with the sockets, the storage and the alarm the old code left it. So whatever passes between them is a format, and changes the way the protocol does, readable both ways: the gateway's headers, what rooms and matchmakers call on each other (`RoomCall`), the tags and the attachment on a socket, and what is in a room's storage. A room on older code must never do worse with a request it does not know than turn it away.

CI runs the typecheck, the tests, the build and both clients on every pull request, and the check **CI passed** has to be green before it can be merged. A pull request that only changes documentation (`docs/`, Markdown files, changelog fragments) skips the tests; the docs build and the changelog check still run.

Write the docs plainly: short sentences, what a thing does and when to use it, numbers where there are numbers. Measured claims say how they were measured.

## Releases

Releases go through a pull request of their own. When a change with a fragment lands on `main`, the *Release* workflow picks the version from the fragments (before 1.0, a breaking change or a new feature makes the next 0.x, anything else a patch), updates `CHANGELOG.md` and the version, runs the tests, and opens the pull request *chore(release): v…* from the branch `release`. Every later change to `main` updates it, so it always holds everything unreleased. Merging it tags the version, publishes it to npm and makes its GitHub release.

The site follows a release without anyone editing it. The docs are built and deployed from `main` on every change, and again when a version is published. The changelog page is `CHANGELOG.md`. The version in the navigation and on the home page, and the home page's *New in* list, are read from `package.json` and `.changelog/changelog.json` when the site is built ([`docs/.vitepress/release.ts`](docs/.vitepress/release.ts)). So no page states the version in words, and none should. What a release cannot write is a row under *Add what your game needs* on the home page: a feature someone would choose Tickflare for gets one in the pull request that adds it.

## Measuring on Cloudflare

The *Measure on Cloudflare* workflow deploys `bench/` to a Cloudflare account, loads it, and deletes it. It needs the repository's Cloudflare secrets, so it runs only here; if your change affects performance, say so in the pull request and it can be measured.

## Reporting a security problem

Not in an issue: see [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is released under the [MIT licence](LICENSE), like the rest of the project.
