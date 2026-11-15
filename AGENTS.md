# Notes for coding agents

- **Changelog:** this repository keeps its changelog in `.changelog/`, with the [changelogger](https://github.com/Giamme/changelogger) skill. Each user-visible change gets a fragment in `.changelog/unreleased/` in the same commit (`python3 .changelog/changelogger.py new --type <type> --text "<what changed, for a user>"`). Never edit `CHANGELOG.md` by hand. A commit no user would notice starts with `test:`, `ci:`, `refactor:`, `docs:` or `chore:`, or says `[skip changelog]`.
- **Every push to `main` with a fragment is a release**, published to npm by `.github/workflows/release.yml`. Group work that belongs in one release on a branch, and merge it once.
- **Docs move with the code:** a change users can see updates its guide page in `docs/guide/`, and, where they apply, the limits and costs pages, the protocol reference, the README and the home page (`docs/index.md`).
- `CONTRIBUTING.md` has the rest: setting up, tests, and what a pull request needs.
