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

- **Tests.** A fix comes with a test that fails without it. Tests run in workerd through `@cloudflare/vitest-plugin`, against real Durable Objects; `test/worker.ts` has the rooms they use.
- **Docs, in the same pull request.** A change that a user can see changes the guide page that describes it, and, if it applies, the [limits](docs/guide/limits.md) and [costs](docs/guide/costs.md) pages, the [protocol](docs/reference/protocol.md), the README and the home page (`docs/index.md`). Every export needs a doc comment: the docs build fails without one, and on dead links.
- **A changelog entry** under `## Unreleased` at the top of [CHANGELOG.md](CHANGELOG.md) (add the heading if it is not there). Say what changed and, if it breaks something, what to change. The changelog is also a page of the docs, so link to the site (`https://tickflare.gridpaper.dev/...`) rather than to files in the repository.
- **The protocol stays readable by old clients.** A change to what goes over the wire raises `PROTOCOL_VERSION` and keeps answering clients that ask for an older one, and comes with test vectors in `test/vectors/` if it touches binary patches or prediction.

Write the docs plainly: short sentences, what a thing does and when to use it, numbers where there are numbers. Measured claims say how they were measured.

## Measuring on Cloudflare

The *Measure on Cloudflare* workflow deploys `bench/` to a Cloudflare account, loads it, and deletes it. It needs the repository's Cloudflare secrets, so it runs only here; if your change affects performance, say so in the pull request and it can be measured.

## Reporting a security problem

Not in an issue: see [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is released under the [MIT licence](LICENSE), like the rest of the project.
