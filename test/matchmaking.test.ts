import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { CloseCode, type MatchFound } from "../src/protocol.js";
import { connect, sleep, upgrade } from "./helpers.js";

const waiting: WebSocket[] = [];
afterEach(() => {
  for (const ws of waiting.splice(0)) {
    try {
      ws.close(1000, "test_done");
    } catch {
      // Already closed.
    }
  }
});

let queues = 0;
const freshQueue = () => `queue-${Date.now()}-${queues++}`;

/** Start waiting in a queue. */
async function enqueue(queue: string, player: string) {
  const response = await upgrade(`/matchmaking/${queue}?player=${player}`);
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  let match: MatchFound | undefined;
  ws.addEventListener("message", (event) => {
    match = JSON.parse(event.data as string) as MatchFound;
  });
  const closed = new Promise<{ code: number; reason: string; match?: MatchFound }>((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason, match }));
  });
  ws.accept();
  waiting.push(ws);
  return { ws, closed, found: () => match };
}

describe("matchmaker", () => {
  it("sends players to the same new room once enough are waiting", async () => {
    const queue = freshQueue();
    const a = await enqueue(queue, "a");
    await sleep(50);
    expect(a.found()).toBeUndefined();

    const b = await enqueue(queue, "b");
    const [forA, forB] = await Promise.all([a.closed, b.closed]);
    expect(forA).toMatchObject({ code: 1000, reason: "matched" });
    expect(forA.match).toMatchObject({ t: "match", players: ["a", "b"] });
    expect(forA.match!.room).toMatch(/^[0-9a-f-]{36}$/);
    expect(forB.match).toEqual(forA.match);

    // The next pair gets a room of its own.
    const c = await enqueue(queue, "c");
    const d = await enqueue(queue, "d");
    const forC = await c.closed;
    expect((await d.closed).match).toEqual(forC.match);
    expect(forC.match!.players).toEqual(["c", "d"]);
    expect(forC.match!.room).not.toBe(forA.match!.room);
  });

  it("reserves the room for the matched players", async () => {
    const queue = freshQueue();
    const a = await enqueue(queue, "a");
    const b = await enqueue(queue, "b");
    const { room } = (await a.closed).match!;
    await b.closed;

    const stranger = await connect(room, "x");
    expect(await stranger.closed).toEqual({ code: CloseCode.JoinRejected, reason: "not_invited" });

    const seated = await connect(room, "a");
    expect((await seated.next("welcome")).you).toBe("a");
  });

  it("keeps separate queues apart", async () => {
    const a = await enqueue(freshQueue(), "a");
    const b = await enqueue(freshQueue(), "b");
    await sleep(80);
    expect(a.found()).toBeUndefined();
    expect(b.found()).toBeUndefined();
  });

  it("lets a player wait only once", async () => {
    const queue = freshQueue();
    const first = await enqueue(queue, "a");
    const second = await enqueue(queue, "a");
    expect(await first.closed).toMatchObject({ code: CloseCode.Replaced, reason: "replaced" });
    await sleep(50);
    expect(second.found()).toBeUndefined();
  });

  it("only accepts identified WebSocket upgrades on a valid queue name", async () => {
    expect((await upgrade("/matchmaking/ranked")).status).toBe(401);
    expect((await upgrade("/matchmaking/not%20ok?player=a")).status).toBe(400);
    expect((await exports.default.fetch("https://tickflare.test/matchmaking/ranked?player=a")).status).toBe(426);
  });
});
