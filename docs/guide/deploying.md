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

Changing a room's code doesn't need a migration. Rooms keep the state the old code saved, so if you change its shape, handle the old shape where you read it.

### When rooms get new code

Not all at once. Cloudflare gives a room that is asleep the new code at its next event, with its players still connected. A room that is awake, which a room is for as long as it ticks, keeps the code it has until it sleeps or until five minutes have passed, and is then restarted: it picks up its saved state, seats and timers, and its players reconnect on their own.

The five minutes are yours to set, from none to a day. A game played in matches of twenty minutes might let them finish:

```jsonc
"durable_objects": {
  "bindings": [{ "name": "ROOMS", "class_name": "Duel" }],
  "code_update_strategy": { "mode": "deferred", "max_delay": 1500 } // seconds
}
```

And a fix that cannot wait for them goes out with `npx wrangler deploy --durable-objects-code-update-mode immediate`. Until a room has the new code, the Worker in front of it and the page your players load are a version ahead of it. [Restarts and deploys](./limits#restarts-and-deploys) has what that asks of your code and what a restart costs a match. This is how Cloudflare [documents it](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/) since October 2026; we have not measured it yet.

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
