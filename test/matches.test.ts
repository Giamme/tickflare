import { createExecutionContext, createMessageBatch, getQueueResult, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Replay } from "../src/lockstep.js";
import type { MatchResult } from "../src/protocol.js";
import { recentMatches, type MatchRecord } from "../src/server/matches.js";
import worker from "./worker.js";
import { follow, freshRoom, sleep, twoPlayers, until } from "./helpers.js";

/** Waits for the queue consumer to have stored the match of `room`. */
async function stored(room: string): Promise<MatchRecord> {
  for (let waited = 0; waited < 8000; waited += 100) {
    const match = (await recentMatches(env.DB, 100)).find((m) => m.room === room);
    if (match) return match;
    await sleep(100);
  }
  throw new Error(`No match was stored for ${room}`);
}

const outbox = (room: string) =>
  runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(room)), (_instance, state) =>
    state.storage.sql.exec("SELECT id FROM tickflare_outbox").toArray().length,
  );

describe("finished matches", () => {
  it("travel from the room through the queue into D1", async () => {
    const { room, p1 } = await twoPlayers();
    p1.command({ type: "add", n: 4 });
    await p1.next("state");
    await p1.next("ack");
    p1.command({ type: "finish" });
    await p1.next("ack");

    const match = await stored(room);
    expect(match).toMatchObject({
      room,
      players: ["p1", "p2"],
      result: { winner: "p1", total: 4 },
      replayKey: null,
    });
    expect(match.endedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(await outbox(room)).toBe(0);

    const listed = (await (await exports.default.fetch("https://tickflare.test/matches")).json()) as MatchRecord[];
    expect(listed.some((m) => m.id === match.id)).toBe(true);
  });

  it("are not announced when the hook rejects afterwards", async () => {
    const { room, p1 } = await twoPlayers();
    p1.command({ type: "finishThenReject" });
    await p1.next("reject");

    expect(await outbox(room)).toBe(0);
    await sleep(1500);
    expect((await recentMatches(env.DB, 100)).some((m) => m.room === room)).toBe(false);
  });

  it("carry the recording of a lockstep room, stored in R2", async () => {
    const room = freshRoom();
    const p1 = await follow<{ seed: number; turn: number }>("/turns", room, "p1");
    p1.send({ k: "i", d: { type: "add", n: 9 } });
    await until(() => p1.of("ack").length === 1 && p1.tick >= 3);
    p1.ws.send(JSON.stringify({ t: "leave", id: 77 }));

    const match = await stored(room);
    expect(match.result).toEqual({ reason: "everyone_left" });
    expect(match.replayKey).toBe(`replays/${match.id}.json`);

    const object = await env.REPLAYS.get(match.replayKey!);
    const replay = (await object!.json()) as Replay<{ type: "add"; n: number }>;
    expect(replay.seed).toBe(p1.state!.seed);
    expect(replay.turns.flatMap(([, entries]) => entries)).toEqual([
      { p: "p1", e: "join" },
      { p: "p1", i: { type: "add", n: 9 } },
    ]);
  });
});

describe("recordMatches", () => {
  it("stores a match once, however often it is delivered", async () => {
    const body: MatchResult = {
      id: crypto.randomUUID(),
      room: "redelivered",
      endedAt: Date.now(),
      players: ["a", "b"],
      result: { winner: "a" },
    };
    for (const attempts of [1, 2]) {
      const batch = createMessageBatch<MatchResult>("tickflare-test-matches", [
        { id: "m1", timestamp: new Date(), attempts, body },
      ]);
      const ctx = createExecutionContext();
      await worker.queue(batch, env);
      const result = await getQueueResult(batch, ctx);
      expect(result.explicitAcks).toEqual(["m1"]);
      expect(result.retryMessages).toEqual([]);
    }

    const matches = (await recentMatches(env.DB, 100)).filter((m) => m.id === body.id);
    expect(matches).toEqual([{ ...body, replayKey: null }]);
  });
});
