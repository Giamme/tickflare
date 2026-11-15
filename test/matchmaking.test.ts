import { listDurableObjectIds, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloseCode, type MatchFound } from "../src/protocol.js";
import { createJoinToken } from "../src/server/tokens.js";
import { connect, sleep, upgrade } from "./helpers.js";
import { TEST_SECRET } from "./worker.js";

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
async function enqueue(queue: string, player: string, prefix = "/matchmaking") {
  const response = await upgrade(`${prefix}/${queue}?player=${player}`);
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
    const welcome = await seated.next("welcome");
    expect(welcome.you).toBe("a");
    // The room knows whom it was reserved for, so it can tell when everyone is there.
    expect((welcome.state as { log: string[] }).log).toEqual(["join:a", "invited:a,b"]);
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

  it("starts with fewer players once the longest wait is over, if there are enough", async () => {
    const queue = freshQueue();
    const started = Date.now();
    const a = await enqueue(queue, "a", "/patient");
    await sleep(300);
    const b = await enqueue(queue, "b", "/patient");
    const arrived = Date.now();
    // Not yet: the first has not waited the limit. (Unless the machine is so slow that it has.)
    if (arrived - started < 500) expect(a.found()).toBeUndefined();

    const forA = await a.closed;
    // Counted from when the first player started waiting, not from when the second arrived: the
    // second has waited about half the limit, not all of it.
    expect(Date.now() - started).toBeGreaterThanOrEqual(590);
    if (arrived - started < 500) expect(Date.now() - arrived).toBeLessThan(590);
    expect(forA.match!.players).toEqual(["a", "b"]);
    expect((await b.closed).match).toEqual(forA.match);
  });

  it("keeps a lone player waiting past the limit, and fills a full match at once", async () => {
    const queue = freshQueue();
    const a = await enqueue(queue, "a", "/patient");
    await sleep(750);
    expect(a.found()).toBeUndefined();

    // Already overdue, so the second player completes a match straight away.
    const b = await enqueue(queue, "b", "/patient");
    expect((await b.closed).match!.players).toEqual(["a", "b"]);

    const four = await Promise.all(["c", "d", "e", "f"].map((p) => enqueue(queue, p, "/patient")));
    const matches = await Promise.all(four.map((waiting) => waiting.closed));
    // They arrived together, so their order within the match is not defined.
    expect([...matches[0]!.match!.players].sort()).toEqual(["c", "d", "e", "f"]);
    expect(new Set(matches.map((m) => m.match!.room)).size).toBe(1);
  });

  it("only accepts identified WebSocket upgrades on a valid queue name", async () => {
    expect((await upgrade("/matchmaking/ranked")).status).toBe(401);
    expect((await upgrade("/matchmaking/not%20ok?player=a")).status).toBe(400);
    expect((await exports.default.fetch("https://tickflare.test/matchmaking/ranked?player=a")).status).toBe(426);
  });
});

describe("matchmaker by rating", () => {
  it("matches players who are close, and keeps the others waiting", async () => {
    const queue = freshQueue();
    const low = await enqueue(queue, "low&rating=1000", "/ranked");
    const high = await enqueue(queue, "high&rating=1500", "/ranked");
    await sleep(80);
    expect(low.found()).toBeUndefined();
    expect(high.found()).toBeUndefined();

    // Third in line, and the first to have someone close enough.
    const near = await enqueue(queue, "near&rating=1050", "/ranked");
    expect((await near.closed).match!.players).toEqual(["low", "near"]);
    expect((await low.closed).reason).toBe("matched");
    await sleep(50);
    expect(high.found()).toBeUndefined();

    // Exactly the gap apart is close enough.
    const top = await enqueue(queue, "top&rating=1600", "/ranked");
    expect((await top.closed).match!.players).toEqual(["high", "top"]);
  });

  it("matches a player without a rating with anyone", async () => {
    const queue = freshQueue();
    const rated = await enqueue(queue, "rated&rating=2400", "/ranked");
    const unrated = await enqueue(queue, "unrated", "/ranked");
    expect((await unrated.closed).match!.players).toEqual(["rated", "unrated"]);
    await rated.closed;

    // A rating that could not be looked up is no rating: the player still gets to play.
    const lost = await enqueue(queue, "lost&rating=boom", "/ranked");
    const other = await enqueue(queue, "other&rating=10", "/ranked");
    expect((await other.closed).match!.players).toEqual(["lost", "other"]);
    await lost.closed;
  });

  it("builds a match around the one who has waited longest, from those near them", async () => {
    const queue = freshQueue();
    const a = await enqueue(queue, "a&rating=1000", "/trios");
    const far = await enqueue(queue, "far&rating=1700", "/trios");
    const b = await enqueue(queue, "b&rating=1080", "/trios");
    await sleep(60);
    expect(a.found()).toBeUndefined();

    const c = await enqueue(queue, "c&rating=940", "/trios");
    expect((await c.closed).match!.players).toEqual(["a", "b", "c"]);
    await Promise.all([a.closed, b.closed]);
    expect(far.found()).toBeUndefined();
  });

  it("widens the gap as a player waits, with nobody arriving", async () => {
    const queue = freshQueue();
    const started = Date.now();
    const a = await enqueue(queue, "a&rating=1000", "/widening");
    const b = await enqueue(queue, "b&rating=1400", "/widening");
    const arrived = Date.now();
    // 300 too far apart, at 100 more for every 100 ms the first has waited.
    if (arrived - started < 200) {
      await sleep(100);
      expect(a.found()).toBeUndefined();
    }
    const forA = await a.closed;
    expect(Date.now() - started).toBeGreaterThanOrEqual(295);
    expect(forA.match!.players).toEqual(["a", "b"]);
    expect((await b.closed).match).toEqual(forA.match);
  });

  it("takes the nearer of two players the wait has made acceptable", async () => {
    const queue = freshQueue();
    const a = await enqueue(queue, "a&rating=1000", "/widening");
    // Each too far from the others to match at once; b is the nearer to a, though it came last.
    const c = await enqueue(queue, "c&rating=1800", "/widening");
    const b = await enqueue(queue, "b&rating=1400", "/widening");
    expect((await a.closed).match!.players).toEqual(["a", "b"]);
    await b.closed;
    expect(c.found()).toBeUndefined();
  });
});

describe("matchmaker by region", () => {
  it("matches within a region first, and across regions once a player has waited", async () => {
    const queue = freshQueue();
    const started = Date.now();
    const europe = await enqueue(queue, "europe&region=weur", "/regional");
    const america = await enqueue(queue, "america&region=enam", "/regional");
    const arrived = Date.now();
    if (arrived - started < 300) {
      await sleep(80);
      expect(europe.found()).toBeUndefined();
    }

    const forEurope = await europe.closed;
    expect(Date.now() - started).toBeGreaterThanOrEqual(395);
    expect(forEurope.match!.players).toEqual(["europe", "america"]);
    await america.closed;
  });

  it("does not make a player wait for someone who is there", async () => {
    const queue = freshQueue();
    const america = await enqueue(queue, "america&region=enam", "/regional");
    const europe = await enqueue(queue, "europe&region=weur", "/regional");
    const second = await enqueue(queue, "second&region=weur", "/regional");
    expect((await second.closed).match!.players).toEqual(["europe", "second"]);
    await europe.closed;
    expect(america.found()).toBeUndefined();

    // Someone whose region is not known suits anyone.
    const somewhere = await enqueue(queue, "somewhere", "/regional");
    expect((await somewhere.closed).match!.players).toEqual(["america", "somewhere"]);
  });
});

describe("matchmaker with parties", () => {
  it("keeps a party together, and matches it only once all of it is there", async () => {
    const queue = freshQueue();
    const a = await enqueue(queue, "a", "/parties");
    const p1 = await enqueue(queue, "p1&party=friends:2", "/parties");
    const b = await enqueue(queue, "b", "/parties");
    const c = await enqueue(queue, "c", "/parties");
    // Four are waiting, but one of them is half of a party: no match yet.
    await sleep(80);
    expect(a.found()).toBeUndefined();

    const p2 = await enqueue(queue, "p2&party=friends:2", "/parties");
    const match = (await p2.closed).match!;
    expect(match.players).toEqual(["a", "p1", "b", "p2"]);
    expect((await p1.closed).match).toEqual(match);
    await Promise.all([a.closed, b.closed]);
    expect(c.found()).toBeUndefined();
  });

  it("goes without the members who did not come, once the first has waited long enough", async () => {
    const queue = freshQueue();
    const started = Date.now();
    const p1 = await enqueue(queue, "p1&party=trio:3", "/parties");
    const p2 = await enqueue(queue, "p2&party=trio:3", "/parties");
    const x = await enqueue(queue, "x", "/parties");
    const y = await enqueue(queue, "y", "/parties");
    const match = (await x.closed).match!;
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    expect([...match.players].sort()).toEqual(["p1", "p2", "x", "y"]);
    await Promise.all([p1.closed, p2.closed, y.closed]);
  });

  it("never splits a party, and matches one that fills a match by itself, whoever came first", async () => {
    const queue = freshQueue();
    const alone = await enqueue(queue, "alone", "/parties");
    const four = await Promise.all(["m1", "m2", "m3", "m4"].map((player) => enqueue(queue, `${player}&party=squad:4`, "/parties")));
    const match = (await four[0]!.closed).match!;
    expect([...match.players].sort()).toEqual(["m1", "m2", "m3", "m4"]);
    await sleep(50);
    expect(alone.found()).toBeUndefined();
  });

  it("takes the party from a join token, and not from a header the client sends", async () => {
    // A token says so: two of a party of two wait for each other, and are matched with two more.
    const queue = freshQueue();
    const token = (player: string) => createJoinToken(TEST_SECRET, { player, scope: queue, party: { id: "duo", size: 2 } });
    const d1 = await enqueue(queue, `d1&token=${await token("d1")}`, "/partytokens");
    const solo = await enqueue(queue, `s1&token=${await createJoinToken(TEST_SECRET, { player: "s1", scope: queue })}`, "/partytokens");
    const solo2 = await enqueue(queue, `s2&token=${await createJoinToken(TEST_SECRET, { player: "s2", scope: queue })}`, "/partytokens");
    await sleep(80);
    expect(d1.found()).toBeUndefined();
    const d2 = await enqueue(queue, `d2&token=${await token("d2")}`, "/partytokens");
    expect([...(await d2.closed).match!.players].sort()).toEqual(["d1", "d2", "s1", "s2"]);
    await Promise.all([d1.closed, solo.closed, solo2.closed]);

    // A header the client sent is dropped at the gateway: these four are players alone, and are matched at once.
    const forged = freshQueue();
    const response = await upgrade(`/forged/${forged}?player=f1`, { "x-tickflare-party": "4:mine" });
    const f1 = response.webSocket!;
    f1.accept();
    waiting.push(f1);
    const others = await Promise.all(["f2", "f3", "f4"].map((player) => enqueue(forged, player, "/forged")));
    expect([...(await others[0]!.closed).match!.players].sort()).toEqual(["f1", "f2", "f3", "f4"]);
  });
});

describe("matchmaker with teams", () => {
  it("splits a match into even teams, keeps a party on one, and tells the room", async () => {
    const queue = freshQueue();
    const p1 = await enqueue(queue, "p1&rating=1000&party=pair:2", "/teams");
    const p2 = await enqueue(queue, "p2&rating=1000&party=pair:2", "/teams");
    const strong = await enqueue(queue, "strong&rating=1400", "/teams");
    const weak = await enqueue(queue, "weak&rating=600", "/teams");
    const match = (await weak.closed).match!;
    expect(match.teams).toEqual([
      ["p1", "p2"],
      ["strong", "weak"],
    ]);
    for (const waiting of [p1, p2, strong]) expect((await waiting.closed).match).toEqual(match);

    const seated = await connect(match.room, "p1");
    expect((await seated.next("welcome")).state).toMatchObject({ log: ["join:p1", `invited:${match.players.join(",")}`, "teams:p1,p2|strong,weak"] });
  });

  it("evens out the ratings of players alone", async () => {
    const queue = freshQueue();
    const players = [
      ["r1000", 1000],
      ["r900", 900],
      ["r1100", 1100],
      ["r1200", 1200],
    ] as const;
    const waiting = [];
    for (const [player, rating] of players) waiting.push(await enqueue(queue, `${player}&rating=${rating}`, "/teams"));
    const { teams } = (await waiting[3]!.closed).match!;
    const sums = teams!.map((team) => team.reduce((sum, player) => sum + Number(player.slice(1)), 0));
    expect(sums).toEqual([2100, 2100]);
  });

  it("turns away a party larger than a team", async () => {
    const queue = freshQueue();
    const big = await enqueue(queue, "b1&party=crowd:3", "/teams");
    expect(await big.closed).toMatchObject({ code: CloseCode.JoinRejected, reason: "party_too_large" });
  });
});

describe("matchmaker while a room is being reserved", () => {
  /** The rooms the slow lobby has reserved, as "a+b". */
  const reservations = (queue: string) =>
    runInDurableObject(env.SLOW.get(env.SLOW.idFromName(queue)), async (_instance, state) =>
      [...(await state.storage.list<string[]>({ prefix: "reserved:" })).values()].map((players) => players.join("+")),
    );

  it("reserves one room per match when more players arrive meanwhile", async () => {
    const queue = freshQueue();
    const a = await enqueue(queue, "a", "/slow");
    const [b, c] = await Promise.all([enqueue(queue, "b", "/slow"), enqueue(queue, "c", "/slow")]);
    await sleep(500);

    const sentTo = [a, b, c].map((waiting) => waiting.found()?.players.join("+") ?? "waiting");
    expect(sentTo).toEqual(["a+b", "a+b", "waiting"]);
    expect(await reservations(queue)).toEqual(["a+b"]);
  });

  it("makes two rooms for five players who arrive almost at once", async () => {
    const queue = freshQueue();
    const before = (await listDurableObjectIds(env.ROOMS)).length;
    const a = await enqueue(queue, "a");
    const rest = await Promise.all(["b", "c", "d", "e"].map((player) => enqueue(queue, player)));
    await sleep(300);

    const found = [a, ...rest].map((waiting) => waiting.found());
    expect(found.filter((match) => match === undefined)).toHaveLength(1);
    expect(new Set(found.map((match) => match?.room).filter(Boolean)).size).toBe(2);
    expect((await listDurableObjectIds(env.ROOMS)).length - before).toBe(2);
  });

  it("puts the others back in the queue when one of the group gives up meanwhile", async () => {
    const queue = freshQueue();
    const a = await enqueue(queue, "a", "/slow");
    const bJoining = enqueue(queue, "b", "/slow"); // starts reserving a room for a and b, which takes 100 ms
    await sleep(30);
    a.ws.close(1000, "gave_up");
    await sleep(20);
    const c = await enqueue(queue, "c", "/slow");
    const b = await bJoining;

    const [forB, forC] = await Promise.all([b.closed, c.closed]);
    expect(forB.match?.players).toEqual(["b", "c"]);
    expect(forC.match).toEqual(forB.match);
  });

  it("tries again by itself after a reservation fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const queue = freshQueue();
    const a = await enqueue(queue, "a", "/flaky");
    const b = await enqueue(queue, "b", "/flaky");
    await sleep(100);
    expect([a.found(), b.found()]).toEqual([undefined, undefined]);

    // Nobody else arrives. The retry is the matchmaker's own.
    const [forA, forB] = await Promise.all([a.closed, b.closed]);
    error.mockRestore();
    expect(forA.match?.players).toEqual(["a", "b"]);
    expect(forB.match).toEqual(forA.match);
  });
});
