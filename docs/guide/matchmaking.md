# Matchmaking

A `Matchmaker` is a Durable Object that players wait in. When enough are waiting, it picks a new room id, reserves that room for them, and tells each of them where to go. Each queue name is its own object, so `ranked` and `casual` fill separately.

## The server

```ts
// src/lobby.ts
import { Matchmaker } from "tickflare";

export class Lobby extends Matchmaker<Env> {
  protected override matchSize = 2;
  // Where the rooms for matches are created.
  protected override rooms = this.env.ROOMS;
}
```

```ts
// src/index.ts
import { routeToMatchmaker, routeToRoom, tokenAuth } from "tickflare";
export { Duel } from "./duel";
export { Lobby } from "./lobby";

export default {
  async fetch(request, env): Promise<Response> {
    const authenticate = tokenAuth({ secret: env.JOIN_SECRET });
    return (
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate })) ??
      (await routeToMatchmaker(request, { matchmakers: env.LOBBY, authenticate })) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
```

Add the matchmaker class to your Wrangler config like a room:

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "ROOMS", "class_name": "Duel" },
    { "name": "LOBBY", "class_name": "Lobby" }
  ]
},
"migrations": [{ "tag": "v1", "new_sqlite_classes": ["Duel", "Lobby"] }]
```

## The client

```ts
import { RoomClient, findMatch } from "tickflare/client";

const { room } = await findMatch(`wss://${location.host}/matchmaking/ranked`, {
  token: accounts.tokenSource,
});
const client = new RoomClient(`wss://${location.host}/rooms/${room}`, {
  token: accounts.tokenSource,
});
```

`findMatch` holds a WebSocket open in the queue and resolves with `{ room, players }` once a match is ready. Pass an `AbortSignal` as `signal` to stop waiting; the promise then rejects with the signal's reason.

## What the matchmaker does

- **Reserved seats.** Only the matched players can take a seat in the new room. Anyone else is closed with `CloseCode.JoinRejected` and `not_invited`.
- **One match at a time.** Reserving a room takes a moment. Players who arrive meanwhile wait for the next match. If one of the group gives up meanwhile, the others go back in the queue instead of into a room that will never fill.
- **Retries.** A reservation that fails is tried again by itself, a little later each time. The players keep waiting.
- **Placement.** The gateway works out roughly where each player is from Cloudflare's `request.cf`, and the matchmaker creates the room near most of them. Locally there is no `request.cf`, so there is no hint.
- **Cost.** The queue is the set of open WebSockets, so a matchmaker hibernates while people wait.

## Starting short

By default a match starts only when `matchSize` players are waiting. To avoid keeping people waiting for ever, let a smaller match start once the longest-waiting player has waited long enough:

```ts
export class Lobby extends Matchmaker<Env> {
  protected override rooms = this.env.ROOMS;
  protected override matchSize = 8;
  protected override minPlayers = 2;
  protected override maxWaitMs = 20_000;
}
```

This fills a lobby of eight when it can, but never keeps two or more players waiting longer than twenty seconds.

## Doing more when a match is made

Override `reserveRoom` to do something before the room is reserved, such as writing the match down. Call `super.reserveRoom` from it:

```ts
protected override async reserveRoom(roomId: string, players: string[], hint?: DurableObjectLocationHint) {
  await this.env.DB.prepare("INSERT INTO matches (room, players) VALUES (?, ?)")
    .bind(roomId, JSON.stringify(players))
    .run();
  await super.reserveRoom(roomId, players, hint);
}
```

If it throws, the players keep waiting and the match is tried again shortly.

## In the room

A reserved room knows whom it was reserved for: `this.invited` lists the matched players, or is `null` for a room no matchmaker reserved. Start the match once all of them have joined:

```ts
protected override onJoin(player: Player): void {
  const expected = this.invited?.length ?? 2;
  if (this.players.length === expected) this.startMatch();
  else if (this.players.length === 1) this.state.startsBy = this.setTimer("no-shows", 30_000);
}

protected override onTimer(name: string): void {
  // Someone never showed up: start with whoever is here, or call it off.
  if (name === "no-shows" && this.state.phase === "waiting") this.startMatch();
}
```

## What is not there yet

The matchmaker is first come, first served. There is no skill-based matching yet; separate queues (`/matchmaking/bronze`, `/matchmaking/gold`) are the way to split players for now.
