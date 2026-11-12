# Deploying

A Tickflare game is an ordinary Cloudflare Worker with Durable Objects, deployed with Wrangler. This page covers the configuration a game needs, secrets, and deploying from CI.

## Wrangler configuration

A complete configuration for a game with rooms, matchmaking, accounts and match results:

```jsonc
// wrangler.jsonc
{
  "name": "my-game",
  "main": "src/index.ts",
  "compatibility_date": "2026-11-01",

  // Static files for your pages, served before the Worker runs.
  "assets": { "directory": "./public" },

  "durable_objects": {
    "bindings": [
      { "name": "ROOMS", "class_name": "Duel" },
      { "name": "LOBBY", "class_name": "Lobby" }
    ]
  },
  // Every Durable Object class Tickflare uses needs SQLite storage.
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Duel", "Lobby"] }],

  // Accounts and match records. Created on first deploy if it doesn't exist.
  "d1_databases": [{ "binding": "DB", "database_name": "my-game" }],

  // Finished matches, from rooms to your queue consumer.
  "queues": {
    "producers": [{ "binding": "MATCHES", "queue": "my-game-matches" }],
    "consumers": [{ "queue": "my-game-matches" }]
  },

  // Replays.
  "r2_buckets": [{ "binding": "REPLAYS", "bucket_name": "my-game-replays" }]
}
```

Only the Durable Object binding and its migration are required. Add the rest as you use [accounts](./accounts), [matchmaking](./matchmaking) and [match results](./match-results).

### Migrations

Cloudflare needs a migration entry whenever a Durable Object class is added, renamed or deleted. Add new entries; never edit one that has been deployed:

```jsonc
"migrations": [
  { "tag": "v1", "new_sqlite_classes": ["Duel", "Lobby"] },
  { "tag": "v2", "new_sqlite_classes": ["Tournament"] }
]
```

Changing a room's code doesn't need a migration. A redeploy restarts rooms with the new code, and they pick up their saved state, seats and timers. Players reconnect on their own. Rooms keep the state the old code saved, so if you change its shape, handle the old shape where you read it.

### Types

`npx wrangler types` writes a `worker-configuration.d.ts` with an `Env` type for your bindings. `Room`'s `Env` type parameter defaults to it, so `this.env.MATCHES` is typed without further work.

## Secrets

Join tokens and account sessions are signed with a secret. Never commit it, and never deploy the development value:

```sh
npx wrangler secret put JOIN_SECRET
```

Use a long random value, for example from `openssl rand -hex 32`. Changing it invalidates every join token and guest token, and guests become new players, so set it once.

For local development, put the development value in `.dev.vars` (and add that file to `.gitignore`):

```sh
# .dev.vars
JOIN_SECRET=local-development-only-secret
```

## Deploying

```sh
npx wrangler deploy
```

The first deploy creates the D1 database if needed. Create queues and buckets once beforehand:

```sh
npx wrangler queues create my-game-matches
npx wrangler r2 bucket create my-game-replays
```

## Deploying from GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm test
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Create the API token in the Cloudflare dashboard from the "Edit Cloudflare Workers" template, and add "D1: Edit" and "Queues: Edit" if you use them. Store it and your account id as repository secrets. Set `JOIN_SECRET` once with `wrangler secret put`; deploys keep it.

## Where rooms run

Cloudflare creates each Durable Object near the request that first used it, and it stays there. Rooms that players reach directly are created near the first player to connect. Rooms a [matchmaker](./matchmaking) reserves are created near most of their players. Everyone else connects to wherever the room lives, through Cloudflare's network.

## What it costs

A room costs under a cent for each hour it runs and nothing while it sleeps, so a turn-based game runs on the $5 plan and a real-time game costs by the match. [What it costs](./costs) has an estimator for your own numbers, the prices, three worked examples and a comparison with renting servers.
