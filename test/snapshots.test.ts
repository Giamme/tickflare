import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockstepClient } from "../src/client/index.js";
import {
  runReplay,
  seededRandom,
  type CatchUp,
  type LockstepView,
  type Replay,
  type SeededRandom,
  type TurnEntry,
} from "../src/lockstep.js";
import { follow, freshRoom, sleep, until } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";
import type { TurnInput } from "./worker.js";

type View = LockstepView<TurnInput>;

/** A simulation in which order, randomness and every turn count: any difference shows. */
type Sim = { turns: number; total: number; trail: string; random: SeededRandom };
const simulation = {
  create: (seed: number): Sim => ({ turns: 0, total: 0, trail: "", random: seededRandom(seed) }),
  step(sim: Sim, entries: TurnEntry<TurnInput>[], turn: number) {
    sim.turns += 1;
    sim.total += Math.floor(sim.random() * 5);
    for (const entry of entries) {
      if (entry.input) sim.total += entry.input.n;
      sim.trail += `${turn}:${entry.player}:${entry.event ?? entry.input?.n};`;
    }
  },
  save: (sim: Sim) => ({ ...sim, random: sim.random.state }),
  load: (saved: unknown): Sim => {
    const from = saved as Omit<Sim, "random"> & { random: number };
    return { ...from, random: seededRandom(from.random) };
  },
  hash(sim: Sim) {
    let h = 0;
    for (const char of JSON.stringify(simulation.save(sim))) h = (Math.imul(h, 31) + char.charCodeAt(0)) | 0;
    return h;
  },
};
const text = (sim: Sim) => JSON.stringify(simulation.save(sim));

const get = (path: string) => exports.default.fetch(`https://tickflare.test${path}`);
const post = (prefix: string, room: string, player: string, turn: number, hash: string, body: string) =>
  exports.default.fetch(`https://tickflare.test${prefix}/${room}/snapshot?player=${player}&turn=${turn}&hash=${hash}`, {
    method: "POST",
    body,
  });
/** What a client with no simulation, which can load snapshots, is sent. */
async function catchUp(prefix: string, room: string, query = "since=0&snapshot=0"): Promise<CatchUp<TurnInput>> {
  const response = await get(`${prefix}/${room}/replay?player=watcher&${query}`);
  expect(response.status).toBe(200);
  return response.json();
}
const recording = (prefix: string, room: string) => catchUp(prefix, room, "") as Promise<Replay<TurnInput>>;
/** Like `until`, for a condition that has to ask the room. */
async function eventually(condition: () => Promise<boolean>, what: string): Promise<void> {
  for (const started = Date.now(); !(await condition()); ) {
    if (Date.now() - started > 4000) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}
/** The latest turn a snapshot could be of. */
const snapshotTurn = (turn: number) => Math.floor(turn / 10) * 10;

/** The real client, playing in a room of the worker under test. */
function play(prefix: string, room: string, player: string) {
  // With the players' clock the game gives no hash: the client fingerprints what `save` returns.
  const { hash, ...unhashed } = simulation;
  const game = prefix === "/askedsnaps" ? unhashed : { ...unhashed, hash };
  const seen = {
    /** Every turn `step` ran for, in order. */
    stepped: [] as number[],
    /** The simulation after each live turn. */
    after: new Map<number, string>(),
    /** What the room was asked when catching up, and what it answered. */
    asked: [] as { url: URL; answer: CatchUp<TurnInput> }[],
    desyncs: 0,
    client: undefined as unknown as LockstepClient<TurnInput, Sim>,
  };
  seen.client = new LockstepClient<TurnInput, Sim>(`wss://tickflare.test${prefix}/${room}?player=${player}`, {
    ...game,
    step(sim, entries, turn) {
      seen.stepped.push(turn);
      simulation.step(sim, entries, turn);
    },
    bufferTurns: 0,
    hashEvery: 7,
    onTurn: (sim, turn) => seen.after.set(turn, text(sim)),
    onDesync: () => (seen.desyncs += 1),
    async loadReplay(url) {
      const answer = (await (await exports.default.fetch(url)).json()) as CatchUp<TurnInput>;
      seen.asked.push({ url: new URL(url), answer });
      return answer;
    },
    sendSnapshot: (url, data) => exports.default.fetch(url, { method: "POST", body: data }),
  });
  clients.push(seen.client);
  return seen;
}
const clients: LockstepClient<TurnInput, Sim>[] = [];

describe("lockstep snapshots", () => {
  beforeEach(() => {
    WorkerSocket.all = [];
    vi.stubGlobal("WebSocket", WorkerSocket);
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    vi.unstubAllGlobals();
  });

  describe.each([
    { clock: "the room's clock", prefix: "/snaps" },
    { clock: "the players asking for the turns", prefix: "/askedsnaps" },
  ])("with $clock", ({ prefix }) => {
    it("starts a late joiner from the latest snapshot, in step with everyone else", async () => {
      const room = freshRoom();
      const first = play(prefix, room, "p1");
      await until(() => first.client.ready, "the first player");
      await first.client.input({ type: "add", n: 5 });
      await eventually(async () => ((await catchUp(prefix, room)).snapshot?.turn ?? 0) >= 20, "a second snapshot");
      await first.client.input({ type: "add", n: 9 });

      const late = play(prefix, room, "p2");
      await until(() => late.client.ready, "the late joiner");
      const { answer } = late.asked[0]!;
      expect(answer.snapshot!.turn).toBeGreaterThanOrEqual(20);
      expect(answer.from).toBe(answer.snapshot!.turn);
      // Nothing before the snapshot is sent, or run.
      expect(answer.turns.every(([turn]) => turn > answer.from!)).toBe(true);
      await until(() => late.stepped.length > 0, "a turn after the snapshot");
      expect(late.stepped[0]).toBe(answer.from! + 1);

      // From here both report hashes, and a snapshot is kept only when they agree.
      const joinedAt = late.client.turn;
      await late.client.input({ type: "add", n: 2 });
      await eventually(async () => ((await catchUp(prefix, room)).snapshot?.turn ?? 0) >= joinedAt + 10, "a snapshot both vouch for");
      const turn = Math.min(first.client.turn, late.client.turn);
      await until(() => first.after.has(turn) && late.after.has(turn));
      expect(late.after.get(turn)).toBe(first.after.get(turn));
      // And it is what the whole recording comes to.
      expect(text(runReplay(await recording(prefix, room), simulation, turn))).toBe(first.after.get(turn));
      expect(first.desyncs + late.desyncs).toBe(0);
    });

    it("carries on from the snapshot after a restart, as the recording says", async () => {
      const room = freshRoom();
      const player = play(prefix, room, "p1");
      await until(() => player.client.ready, "the player");
      await player.client.input({ type: "add", n: 3 });
      await eventually(async () => ((await catchUp(prefix, room)).snapshot?.turn ?? 0) >= 10, "a snapshot");

      await abortAllDurableObjects();
      for (const socket of WorkerSocket.all) socket.drop();
      await until(() => player.asked.length >= 2 && player.client.ready, "the player back");
      const { answer, url } = player.asked.at(-1)!;
      // The room it knew is gone: what it has may not be what the new one resumed from.
      expect(answer.from).toBe(answer.snapshot!.turn);
      expect(url.searchParams.get("epoch")).not.toBe(answer.epoch);

      await player.client.input({ type: "add", n: 4 });
      const from = player.client.turn;
      await until(() => player.client.turn >= from + 12, "turns after the restart");
      const turn = player.client.turn;
      expect(text(runReplay(await recording(prefix, room), simulation, turn))).toBe(player.after.get(turn));
    });
  });

  it("sends a client that kept its simulation only the turns it missed", async () => {
    const room = freshRoom();
    const player = play("/snaps", room, "p1");
    await until(() => player.client.ready && player.client.turn >= 15, "fifteen turns");
    await player.client.input({ type: "add", n: 6 });
    await until(() => player.after.get(player.client.turn)?.includes(":p1:6") === true, "the input");

    WorkerSocket.all.at(-1)!.drop();
    const at = player.client.turn;
    await until(() => player.asked.length === 2 && player.client.ready, "the reconnect");
    const { url, answer } = player.asked[1]!;
    expect(url.searchParams.get("since")).toBe(String(at));
    expect(url.searchParams.get("epoch")).toBe(player.asked[0]!.answer.epoch);
    expect(answer.from).toBe(at);
    expect(answer.snapshot).toBeUndefined();
    expect(answer.turns.every(([turn]) => turn > at)).toBe(true);

    await until(() => player.client.turn >= at + 5, "turns after the reconnect");
    // Every turn once, in order: nothing was run again.
    expect(player.stepped).toEqual(player.stepped.map((_, index) => index + 1));
    const turn = player.client.turn;
    expect(text(runReplay(await recording("/snaps", room), simulation, turn))).toBe(player.after.get(turn));
  });

  it("keeps a snapshot only once every other connected player has reported its hash", async () => {
    const room = freshRoom();
    const p1 = await follow<View>("/snaps", room, "p1");
    const p2 = await follow<View>("/snaps", room, "p2");
    const p3 = await follow<View>("/snaps", room, "p3");
    await until(() => p1.tick >= 10 && p3.tick >= 10, "ten turns");

    // The snapshot first: it waits for the other players, all of them.
    let turn = snapshotTurn(p1.tick);
    expect((await post("/snaps", room, "p1", turn, "abc", '{"held":1}')).status).toBe(202);
    p2.send({ k: "h", n: turn, h: "abc" });
    await until(() => p2.of("ack").length === 1);
    expect((await catchUp("/snaps", room)).snapshot).toBeUndefined();
    p3.send({ k: "h", n: turn, h: "abc" });
    await eventually(async () => (await catchUp("/snaps", room)).snapshot !== undefined, "the snapshot");
    expect((await catchUp("/snaps", room)).snapshot).toEqual({ turn, hash: "abc", data: '{"held":1}' });

    // A player who is away is not waited for. The others' hashes first: the snapshot is kept as it arrives.
    p3.ws.close(1000, "away");
    await until(() => p1.state!.entries.some((entry) => entry.player === "p3" && entry.event === "disconnect") || p1.tick >= turn + 10);
    await until(() => p2.tick >= turn + 10);
    turn = snapshotTurn(p2.tick);
    p2.send({ k: "h", n: turn, h: "def" });
    await until(() => p2.of("ack").length === 2);
    expect((await post("/snaps", room, "p1", turn, "def", '{"kept":2}')).status).toBe(201);
    expect((await catchUp("/snaps", room)).snapshot).toEqual({ turn, hash: "def", data: '{"kept":2}' });

    // A hash the other player does not share: refused, and the one before stays.
    await until(() => p2.tick >= turn + 10);
    const disputed = snapshotTurn(p2.tick);
    p2.send({ k: "h", n: disputed, h: "theirs" });
    await until(() => p2.of("ack").length === 3);
    expect((await post("/snaps", room, "p1", disputed, "mine", '{"wrong":3}')).status).toBe(409);
    expect((await catchUp("/snaps", room)).snapshot!.turn).toBe(turn);
  });

  it("does not take one player's word for it while the others are away", async () => {
    const room = freshRoom();
    const p1 = await follow<View>("/snaps", room, "p1");
    const p2 = await follow<View>("/snaps", room, "p2");
    p2.ws.close(1000, "away");
    await until(() => p1.tick >= 10 && p1.frames.some((frame) => JSON.stringify(frame).includes('"disconnect"')), "p2 away");
    const turn = snapshotTurn(p1.tick);
    expect((await post("/snaps", room, "p1", turn, "abc", "{}")).status).toBe(202);
    await sleep(50);
    expect((await catchUp("/snaps", room)).snapshot).toBeUndefined();
  });

  it("drops a snapshot that was waiting when the players turn out to disagree", async () => {
    const room = freshRoom();
    const p1 = await follow<View>("/snaps", room, "p1");
    const p2 = await follow<View>("/snaps", room, "p2");
    await until(() => p1.tick >= 10 && p2.tick >= 10, "ten turns");
    const turn = snapshotTurn(p1.tick);
    expect((await post("/snaps", room, "p1", turn, "same", "{}")).status).toBe(202);
    // They differ about an earlier turn, so what they agree on about this one is worth nothing.
    p1.send({ k: "h", n: turn - 3, h: "mine" });
    p2.send({ k: "h", n: turn - 3, h: "theirs" });
    await until(() => p1.state!.desync !== null, "the desync flag");
    p2.send({ k: "h", n: turn, h: "same" });
    await until(() => p2.of("ack").length === 2);

    expect((await catchUp("/snaps", room)).snapshot).toBeUndefined();
    // A match whose simulations differ takes no more snapshots: nobody can say whose is right.
    await until(() => p1.tick >= turn + 10);
    expect((await post("/snaps", room, "p1", snapshotTurn(p1.tick), "any", "{}")).status).toBe(409);
  });

  it("takes a player who is alone in the room at their word, and nobody else", async () => {
    const room = freshRoom();
    const p1 = await follow<View>("/snaps", room, "p1");
    await until(() => p1.tick >= 10, "ten turns");
    const turn = snapshotTurn(p1.tick);

    expect((await post("/snaps", room, "stranger", turn, "abc", "{}")).status).toBe(403);
    expect((await post("/snaps", room, "p1", turn + 3, "abc", "{}")).status).toBe(400); // not a snapshot turn
    expect((await post("/snaps", room, "p1", turn, "", "{}")).status).toBe(400); // no hash
    expect((await post("/snaps", room, "p1", turn + 5000, "abc", "{}")).status).toBe(409); // has not happened
    expect((await post("/snaps", room, "p1", turn, "abc", "")).status).toBe(400);
    expect((await post("/snaps", room, "p1", turn, "abc", "x".repeat(3_000_001))).status).toBe(413);
    expect((await catchUp("/snaps", room)).snapshot).toBeUndefined();

    expect((await post("/snaps", room, "p1", turn, "abc", '{"n":1}')).status).toBe(201);
    // One for a turn it has one for already, or an earlier one, is of no use.
    expect((await post("/snaps", room, "p1", turn, "abc", '{"n":2}')).status).toBe(409);
    expect((await catchUp("/snaps", room)).snapshot).toEqual({ turn, hash: "abc", data: '{"n":1}' });

    // A client that cannot load one, or has found this one wanting, is not sent it.
    expect((await catchUp("/snaps", room, "since=0")).snapshot).toBeUndefined();
    expect((await catchUp("/snaps", room, `since=0&snapshot=${turn}`)).snapshot).toBeUndefined();
    expect((await catchUp("/snaps", room, `since=0&snapshot=${turn}`)).from).toBeUndefined();
    // And the plain recording is the whole match, as before.
    const whole = await recording("/snaps", room);
    expect(Object.keys(whole).sort()).toEqual(["seed", "turn", "turnRate", "turns", "v"]);
    expect(whole.turns[0]![1][0]).toEqual({ player: "p1", event: "join" });
  });

  it("stores a snapshot longer than one row, and replaces it whole", async () => {
    const room = freshRoom();
    const stub = env.SNAPS.get(env.SNAPS.idFromName(room));
    const rows = () =>
      runInDurableObject(stub, (_instance, state) => state.storage.sql.exec("SELECT part FROM tickflare_snapshot").toArray().length);
    const p1 = await follow<View>("/snaps", room, "p1");
    await until(() => p1.tick >= 10, "ten turns");
    let turn = snapshotTurn(p1.tick);
    const long = JSON.stringify({ units: "é".repeat(1_200_000) });
    expect((await post("/snaps", room, "p1", turn, "big", long)).status).toBe(201);
    expect(await rows()).toBe(2);
    expect((await catchUp("/snaps", room)).snapshot).toEqual({ turn, hash: "big", data: long });

    await until(() => p1.tick >= turn + 10);
    turn = snapshotTurn(p1.tick);
    expect((await post("/snaps", room, "p1", turn, "small", "{}")).status).toBe(201);
    expect(await rows()).toBe(1);
    expect((await catchUp("/snaps", room)).snapshot).toEqual({ turn, hash: "small", data: "{}" });
  });

  it("resumes at the snapshot's turn when the saved turn counter is behind it", async () => {
    const room = freshRoom();
    const p1 = await follow<View>("/snaps", room, "p1");
    await until(() => p1.tick >= 20, "twenty turns");
    const turn = snapshotTurn(p1.tick);
    expect((await post("/snaps", room, "p1", turn, "abc", "{}")).status).toBe(201);

    // Nothing has happened since the join, so the room's own save still says turn 1 or so.
    await abortAllDurableObjects();
    const answer = await catchUp("/snaps", room);
    expect(answer.snapshot!.turn).toBe(turn);
    expect(answer.turn).toBeGreaterThanOrEqual(turn);
    const back = await follow<View>("/snaps", room, "p1");
    // No turn the snapshot covers is handed out again.
    await sleep(60);
    const turns = back.frames.flatMap((frame) => (frame.t === "welcome" || frame.t === "state" ? [frame.state.turn] : []));
    expect(Math.min(...turns)).toBeGreaterThanOrEqual(turn);
    expect(back.state!.turn).toBeGreaterThan(turn);
  });

  it("takes none when the room is set to keep none", async () => {
    const room = freshRoom();
    const p1 = await follow<View>("/asked", room, "p1");
    expect(p1.state).not.toHaveProperty("snapshotEvery");
    expect((await post("/asked", room, "p1", 10, "abc", "{}")).status).toBe(404);
    const snaps = await follow<View>("/snaps", freshRoom(), "p1");
    expect(snaps.state!.snapshotEvery).toBe(10);
  });
});
