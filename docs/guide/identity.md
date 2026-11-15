# Identity and join tokens

A room has to know who is connecting, and it can't take the client's word for it. In Tickflare that question is answered in one place: the `authenticate` function you give the gateway. Rooms trust whatever it returns and nothing else.

## The gateway

`routeToRoom` is the gateway for rooms. Call it from your Worker's `fetch`:

```ts
import { routeToRoom } from "tickflare";

export default {
  async fetch(request, env): Promise<Response> {
    return (
      (await routeToRoom(request, {
        rooms: env.ROOMS,
        authenticate: (request, roomId) => whoIsThis(request, roomId),
      })) ?? new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
```

It handles two kinds of request under its prefix (`/rooms` by default):

- WebSocket upgrades on `/rooms/<roomId>`: a player connecting.
- Plain HTTP requests on `/rooms/<roomId>/...`, which reach the room's [`onHttp`](./timers-messages-async#http-requests).

Both are authenticated first. For any other URL it returns `null`, so you can chain your other routes after it with `??`.

## What authenticate returns

`authenticate(request, roomId)` receives the request and the id of the room being opened, and returns one of:

- **a player id**, as a string;
- **`{ id, name }`**, a player id with a display name, which rooms see as `player.name`;
- **a `Response`**, to turn the request away with it, e.g. a 401.

It may be async. A function that returns nothing is answered with 401, so forgetting a case fails closed. Player ids are 1 to 128 printable ASCII characters; names are up to 64 characters without control characters.

The gateway passes the identity to the room in headers of its own, replacing anything the client sent under the same names. A client can't set its own player id.

## Join tokens

The usual way to answer "who is this?" is a **join token**: a short signed statement from your backend that says "this connection is player X". Your backend signs one once it knows who the player is, the client presents it when connecting, and `tokenAuth` checks it at the gateway.

```ts
import { createJoinToken, routeToRoom, tokenAuth } from "tickflare";

// 1. Your backend knows who the player is (a login, a session) and signs a token for them.
const token = await createJoinToken(env.JOIN_SECRET, { player: user.id, name: user.name, expiresIn: 3600 });

// 2. The gateway lets in only connections that present a valid one.
await routeToRoom(request, {
  rooms: env.ROOMS,
  authenticate: tokenAuth({ secret: env.JOIN_SECRET }),
});
```

```ts
// 3. The client asks for a token before every connection attempt.
const room = new RoomClient(`wss://my-game.example/rooms/lobby`, {
  token: (roomId) => getJoinToken(roomId), // yours: return the one you have, or fetch a fresh one
});
```

How tokens work:

- A token is an HMAC-SHA256 signature over the player id, the name if any, an optional scope and an expiry. It can't be forged or altered without the secret.
- The client sends it as the `token` query parameter. For plain HTTP requests, `Authorization: Bearer <token>` works too.
- Tokens expire (`expiresIn`, in seconds; one hour by default). A client reconnects for as long as the page is open, which can be longer than any one token. That is why the client takes a function rather than a token: it is called for the first connection, for every reconnect and when the room hands the player to another room, each time with the id of the room being connected to. Return the token you have while it is still good, and get a new one when it isn't.
- `scope: roomId` makes a token that only opens one room, or one matchmaking queue of that name. The room id the client's `token` function receives is what to ask your backend for.
- `verifyJoinToken(secret, token, scope?)` checks a token in your own code and returns what it says, or `null`.

Keep the secret out of your repository. Store it with `wrangler secret put JOIN_SECRET`. It must be at least 16 characters; use a long random value.

## Using Accounts

If you don't have a backend that knows your players yet, [Accounts](./accounts) is one. It gives visitors a guest identity, lets them sign up, and plugs straight into the gateway:

```ts
const accounts = new Accounts(env.DB, { secret: env.JOIN_SECRET });

return (
  (await accounts.route(request)) ??
  (await routeToRoom(request, { rooms: env.ROOMS, authenticate: accounts.authenticate }))
);
```

`accounts.authenticate` lets in signed-in players (by their session cookie or bearer token) and anyone with a valid join token, guests included, and passes the account name on to rooms. `accounts.requireAccount` does the same but turns guests away. On the client, `AccountClient.tokenSource` is a ready-made `token` function.

## Writing authenticate yourself

Any function with the same contract works. For example, reading your own session cookie:

```ts
async function authenticate(request: Request): Promise<Authenticated | Response> {
  const session = parseCookie(request.headers.get("Cookie"))["session"];
  const user = session ? await lookUpSession(env.DB, session) : null;
  if (!user) return new Response("Sign in first", { status: 401 });
  return { id: user.id, name: user.displayName };
}
```

::: warning Cookies and WebSockets
Browsers send cookies with WebSocket connections from any site, and WebSockets aren't covered by CORS. If you authenticate WebSockets by cookie, check the `Origin` header against your own origin, or another site's page could connect as your player. `Accounts` does this for you.
:::

## Matchmaking queues

`routeToMatchmaker` is the gateway for [matchmaking](./matchmaking) queues, with the same `authenticate` contract. The second argument is the queue name instead of a room id.

```ts
await routeToMatchmaker(request, { matchmakers: env.MATCHMAKERS, authenticate });
```

A join token can also say which [party](./matchmaking#parties) the player queues with: `createJoinToken(secret, { player, scope: "ranked", party: { id, size } })`. `tokenAuth` and `Accounts.authenticate` pass it on to the matchmaker. Make these tokens only on your server, after checking who is in the party.
