# Match results and replays

When a match ends, call `this.finishMatch(result)` from a hook. The room puts a message on a Cloudflare Queue, and a queue consumer in your Worker stores it, by default in D1. A replay, if you give one, goes to R2 first and the message carries its key.

Going through a queue keeps the room's hook fast and the result safe: the announcement is saved with the room in the same step as the hook's other changes, and delivered afterwards, retried until it gets through.

## Announcing the end of a match

```ts
export class Duel extends Room<State, Command, Env> {
  protected override matchQueue = this.env.MATCHES;  // a Queue binding
  protected override matchBucket = this.env.REPLAYS; // optional: an R2 binding, for replays

  protected onCommand(player: Player, command: Command): void {
    // ...apply the move...
    if (this.state.winner) {
      this.finishMatch({ winner: this.state.winner, moves: this.state.moves.length });
    }
  }
}
```

`result` is yours to define: the winner, scores, the reason a match ended. The queue receives a `MatchResult`:

```ts
interface MatchResult {
  id: string;            // unique per finished match, the same on every redelivery
  room: string | null;   // the room id
  endedAt: number;       // epoch milliseconds
  players: string[];     // everyone who held a seat when it ended
  result: Record<string, unknown>; // what you passed
  replayKey?: string;    // where the replay is in R2, if there is one
}
```

Pass a replay as the second argument, `this.finishMatch(result, replay)`, to have it written to `matchBucket` as JSON under `replays/<match id>.json`. [Lockstep rooms](./lockstep) do this by themselves: with `matchBucket` set, `finishMatch(result)` stores the match's recording.

## Storing results

```ts
import { recordMatches, recentMatches, type MatchResult } from "tickflare";

export default {
  async fetch(request, env): Promise<Response> {
    if (new URL(request.url).pathname === "/api/matches") {
      return Response.json(await recentMatches(env.DB, 20));
    }
    // ...the gateway, as usual
  },

  async queue(batch, env): Promise<void> {
    await recordMatches(batch, env.DB);
  },
} satisfies ExportedHandler<Env, MatchResult>;
```

```jsonc
// wrangler.jsonc, in addition to the Durable Objects
"queues": {
  "producers": [{ "binding": "MATCHES", "queue": "my-game-matches" }],
  "consumers": [{ "queue": "my-game-matches" }]
},
"d1_databases": [{ "binding": "DB", "database_name": "my-game" }],
"r2_buckets": [{ "binding": "REPLAYS", "bucket_name": "my-game-replays" }]
```

- `recordMatches` stores each match in the table `tickflare_matches`, once however often its message is delivered. It creates the table on first use; `MATCHES_SCHEMA` has the SQL if you prefer migrations.
- `recentMatches(db, limit)` reads the latest matches back as `MatchRecord`s, newest first.
- Create the queue once with `npx wrangler queues create my-game-matches`, and the bucket with `npx wrangler r2 bucket create my-game-replays`.

## Doing more after a match

The queue consumer is the place for post-match work that shouldn't slow the room down: ratings, achievements, notifications. Do it in the same handler:

```ts
async queue(batch, env): Promise<void> {
  await recordMatches(batch, env.DB);
  const accounts = new Accounts(env.DB, { secret: env.JOIN_SECRET });
  for (const message of batch.messages) {
    const { id, players, result } = message.body;
    const winner = result.winner as string | undefined;
    await accounts.awardStats(`match:${id}`, players.map((player) => ({
      player,
      add: { games: 1, wins: player === winner ? 1 : 0 },
    })));
  }
}
```

Keying `awardStats` by the match id means a message delivered twice still counts once. See [Stats and leaderboards](./accounts#stats-and-leaderboards).

## Delivery guarantees

- A hook that rejects announces nothing.
- The announcement is saved before it is sent. If the queue or the bucket can't be reached, it is sent again on the room's next event, without holding up anything else the room has to deliver.
- Delivery is at least once. After a crash at the wrong moment a message can arrive twice, with the same `id`: use it as a key.
- A replay passes through a row of the room's database on its way to R2, so it is limited to 2 MB.
