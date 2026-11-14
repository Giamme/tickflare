# Accounts and player data

`Accounts` is a small player backend on D1. It covers what most games need around their rooms:

- guests who can play at once, and sign up later without losing what they earned
- accounts with a name and a password, and sessions
- two ways back in for a player who forgot their password
- per-player data, with a policy for who may read and write each key
- stats that only your server writes, and a leaderboard for every stat
- public profiles
- a player's right to download or delete everything stored about them

It is one class on the server and one on the client.

## Setting it up

`Accounts` needs a D1 database and the same secret you use for join tokens.

```jsonc
// wrangler.jsonc
"d1_databases": [{ "binding": "DB", "database_name": "my-game" }]
```

```ts
// src/index.ts
import { Accounts, routeToRoom } from "tickflare";

function accountsFor(env: Env): Accounts {
  return new Accounts(env.DB, {
    secret: env.JOIN_SECRET,
    data: {
      avatar: { read: "public", write: "owner" }, // on the profile; players set it themselves
      settings: { write: "owner" },               // private; players set it themselves
      rating: { read: "public" },                 // on the profile; only your server sets it
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const accounts = accountsFor(env);
    return (
      (await accounts.route(request)) ?? // the HTTP API, under /api/accounts
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate: accounts.authenticate })) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
```

`Accounts` holds no state of its own, so make one per request. Its tables are prefixed `tickflare_` and created on first use. `ACCOUNTS_SCHEMA` has the SQL if you prefer to apply it as a migration.

## In the browser

```ts
import { AccountClient, RoomClient } from "tickflare/client";

const accounts = new AccountClient();
await accounts.restore(); // signed in from an earlier visit?

// Signed-in players connect as their account, everyone else as a guest.
const room = new RoomClient(`wss://${location.host}/rooms/lobby`, { token: accounts.tokenSource });

// Later, when they want to keep their progress:
await accounts.register({ name: "Ada", password: "correct horse battery" });
```

- `accounts.account` is the signed-in account, or `null`. `accounts.onChange(listener)` tells you when it changes.
- `accounts.playerId` is the id the player is connecting under, account or guest.
- Errors are `AccountRequestError`s with a `code` such as `name_taken`, `invalid_credentials` or `weak_password`. The full list is in the [HTTP API reference](../reference/accounts-http#errors).

## Guests

A visitor without an account gets a guest identity: a player id and a join token for it, from `POST /api/accounts/guest`. `tokenSource` fetches one on first use, keeps it in `localStorage`, and renews it for the same id once it is half way to expiring (30 days by default). A guest who stays away until it has expired starts over as a new player.

When a guest registers, `AccountClient` sends their guest token along, and the new account keeps the guest's player id. Everything stored under that id (data, stats, seats in rooms, match records) carries over.

Guests can have data and stats like anyone else. Leaderboards and profiles only list accounts. To keep guests out of a room or a queue, use `accounts.requireAccount` instead of `accounts.authenticate` in the gateway.

## Sessions

Signing in creates a session that lasts 30 days since it was last used (`sessionTtlMs`).

- **In browsers** the session is an `HttpOnly` cookie that the page's scripts never see. WebSocket connections carry it too, so a signed-in player connects as their account without a join token.
- **Elsewhere** (Node, native apps, bots) the session token comes back in the response, and the client sends it as `Authorization: Bearer`. `AccountClient` picks this mode by itself outside browsers. Pass `session` to start from a stored token and `onSession` to store a new one.

Changing the password ends every other session of the account.

### Other origins

Requests that would act as the player are refused from other sites' pages, cookie-carrying WebSocket connections included. That is what stops another site from using a player's session. If your pages are served from another origin than the Worker, list it in `allowedOrigins`; it then gets CORS headers, and the cookie is made usable there.

```ts
new Accounts(env.DB, { secret: env.JOIN_SECRET, allowedOrigins: ["https://play.my-game.example"] });
```

The cookie is `SameSite=Lax` by default, which keeps players signed in when they follow a link to your game. `sameSite: "Strict"` is tighter: the cookie isn't sent on that first page load.

## Names and passwords

- Names are 3 to 24 letters, digits, spaces, dots, dashes and underscores, starting and ending with a letter or digit. They are unique regardless of case, spaces, dots, dashes and underscores, so `Ada_L` and `ada l` can't both exist. `normalizeName` replaces these rules with your own.
- Passwords are 8 to 256 characters. They are hashed with PBKDF2-SHA256 at 100,000 iterations, the most the Workers runtime allows.
- Sessions are stored as hashes, so a leaked database doesn't sign anyone in.
- After ten failed sign-ins for one name, or fifty from one address, sign-ins are refused with `too_many_attempts` for up to fifteen minutes.
- An email address is optional and is not verified. It is where a [password reset](#by-email) is sent, if you set that up.

## A forgotten password

There are two ways back into an account, and a game can offer either or both.

### With a recovery code

A recovery code needs nothing but Tickflare. A signed-in player asks for one, writes it down, and can later set a new password with it:

```ts
// Signed in: show this to the player once. Only its hash is stored.
const code = await accounts.createRecoveryCode(password); // "7K2QF-M0XTR-9DJ4W-B6HNA"

// Later, signed out, with the password forgotten:
await accounts.recover("Ada", code, "a new password");
```

- A code is twenty letters and digits, typed in any case, with or without the dashes.
- It works once. Using it sets the new password, ends every session of the account, and signs the player in; they can then make a new code.
- Making a code replaces the one the account had. `account.recoveryCode` says whether there is one, so the page can remind a player who has none.
- Wrong codes are counted like wrong passwords: ten for one name and no more are taken for up to fifteen minutes.

Offer it right after sign-up, while the player still has their password in hand.

### By email

Tickflare makes the reset token and checks it; sending the email is yours, with whichever service you use. Give `Accounts` a `sendPasswordReset`:

```ts
const accounts = new Accounts(env.DB, {
  secret: env.JOIN_SECRET,
  async sendPasswordReset(reset) {
    // Your mail service: Cloudflare Email Service, Resend, Postmark...
    await sendEmail(env, {
      to: reset.email,
      subject: "Set a new password",
      text: `Hello ${reset.name}. Set a new password here, within the hour:\n` +
        `https://my-game.example/reset#${reset.token}`,
    });
  },
});
return (await accounts.route(request, ctx)) ?? new Response("Not found", { status: 404 });
```

```ts
// On the sign-in page
await accounts.forgotPassword({ name: "Ada" }); // or { email: "ada@example.com" }

// On the page the link opens
await accounts.resetPassword(location.hash.slice(1), "a new password");
```

- `forgotPassword` resolves whether or not there is such an account, so the page cannot be used to find out who plays your game. Pass the Worker's `ctx` to `route`, as above: the email is then sent after the answer, which takes as long either way.
- Asked for by email address, every account with that address is sent a link of its own, with its name in it. A player who forgot their name finds it there.
- A token lasts an hour (`passwordResetTtlSeconds`) and works once. A newer one replaces it, and so does changing the password. Using it ends every session of the account and signs the player in.
- One account, or one address, is sent three links in fifteen minutes at most.
- Put the token after a `#` in the link, as above, so that it does not reach your logs or anyone else's.

## Player data

Data is a JSON value per key, per player: settings, an avatar, unlocked items, a saved game. Each key has a policy:

| Policy | Default | Meaning |
| --- | --- | --- |
| `read: "owner"` | yes | Only the player (and your server) can read it |
| `read: "public"` | | It appears on the player's public profile |
| `write: "server"` | yes | Only your server can set it |
| `write: "owner"` | | The player can set it from the client |

Keys you don't list in `data` are private and server-written. Your server code can read and write every key, whatever its policy.

```ts
// Client: only keys with write: "owner".
await accounts.setData("settings", { music: false });
const settings = await accounts.getData<Settings>("settings");

// Server: any key.
await accountsFor(env).setData(playerId, "rating", 1520);
```

A value is at most 64 KiB of JSON (`maxDataBytes`), and a player has at most 100 keys (`maxDataKeys`).

## Stats and leaderboards

Stats are numbers that only your server writes: wins, games played, best score. Every stat is a leaderboard.

```ts
const accounts = accountsFor(env);
await accounts.addStats(winner, { wins: 1, games: 1 });     // add to what is there
await accounts.addStats(loser, { games: 1 });
await accounts.maxStats(winner, { bestStreak: streak });    // keep the higher value
await accounts.setStats(winner, { rating: 1520 });          // overwrite
```

When several players' stats come from one match, write them with `awardStats`, keyed by something unique such as the match id. It writes everything or nothing, and a second call with the same key changes nothing and returns `false`, so code that retries after a failure can't count a result twice:

```ts
await accounts.awardStats(`match:${match.id}`, [
  { player: winner, add: { wins: 1, games: 1 } },
  { player: loser, add: { games: 1 } },
]);
```

Reading:

```ts
// Server
await accounts.leaderboard("wins", { limit: 20, offset: 0 }); // { stat, entries, total }
await accounts.rank("wins", playerId);                        // { rank, value } or null
await accounts.statsOf([id1, id2], ["wins", "rating"]);      // Map of player id to stats

// Client
const top = await accounts.leaderboard("wins");
```

Players with the same value share a rank. `GET /api/accounts/leaderboards/<stat>` is public and cached for ten seconds.

## Profiles

`GET /api/accounts/players/<id>` returns a player's public profile: name, creation date, public data keys and stats. `accounts.profile(id)` on either side reads one, and `accounts.names(ids)` on the server resolves many player ids to names at once, for match histories and lists.

## A player's own data

- `GET /api/accounts/export` (`accounts.exportData()` on the client) gives a player everything stored about them as a JSON download, including matches recorded by [`recordMatches`](./match-results).
- `DELETE /api/accounts/me` with their password (`accounts.deleteAccount(password)`) deletes their account, sessions, data and stats. Match records keep the id, but it no longer resolves to a name.

## From server code

Everything the HTTP API does is also a method, for your own routes, rooms and queue consumers: `register`, `signIn`, `rename`, `setEmail`, `setPassword`, `createRecoveryCode`, `recoverWithCode`, `startPasswordReset`, `resetPassword`, `createSession`, `deleteAccount`, `exportAccount`, `ownAccount`, `profile`, `names`, the data and stats methods above, and `identify(request)`, which tells you who is behind any request. See the [`Accounts` API reference](../api/tickflare/classes/Accounts).

## Moving from another service

`importAccount` takes an account with its id and its old password hash. Give `Accounts` a `verifyImportedPassword` that understands those hashes, and imported players sign in with their old passwords. On their first sign-in the hash is replaced with one of Tickflare's own.

```ts
import bcrypt from "bcryptjs";

const accounts = new Accounts(env.DB, {
  secret: env.JOIN_SECRET,
  verifyImportedPassword: (hash, password) => hash.startsWith("$2") && bcrypt.compare(password, hash),
});

for (const old of exported) {
  await accounts.importAccount({ id: old.id, name: old.identifier, passwordHash: old.password });
}
```

## Not included

Email verification, social sign-in, analytics events and remote config are left out on purpose. Each needs a service of its own, and they are easy to add next to `Accounts` in your Worker.
