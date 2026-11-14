import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { fingerprint, runReplay, seededRandom, stepThrough, type LockstepView, type Replay, type TurnEntry } from "../src/lockstep.js";
import { follow, freshRoom, until } from "./helpers.js";
import type { TurnInput } from "./worker.js";

type View = LockstepView<TurnInput>;
const join = (room: string, player: string) => follow<View>("/turns", room, player);
const input = (n: number) => ({ k: "i", d: { type: "add", n } });

/** An order-sensitive simulation: any difference in the turn stream shows up in it. */
type Sim = { seed: number; turns: number; total: number; trail: string };
const simulation = {
  create: (seed: number): Sim => ({ seed, turns: 0, total: 0, trail: "" }),
  step(sim: Sim, entries: TurnEntry<TurnInput>[], turn: number) {
    sim.turns += 1;
    for (const entry of entries) {
      if (entry.input) sim.total += entry.input.n;
      sim.trail += `${turn}:${entry.player}:${entry.event ?? entry.input?.n};`;
    }
  },
};

/** The simulation a connected player ends up with by applying every turn it was sent, up to `upTo`. */
function live(player: Awaited<ReturnType<typeof join>>, upTo: number, from = simulation.create(player.state!.seed), after = 0) {
  for (let turn = after + 1; turn <= upTo; turn++) {
    const view = player.history.get(turn);
    if (!view) throw new Error(`turn ${turn} was never received`);
    simulation.step(from, view.entries, turn);
  }
  return from;
}

async function replayOf(room: string): Promise<Replay<TurnInput>> {
  const response = await exports.default.fetch(`https://tickflare.test/turns/${room}/replay?player=p1`);
  expect(response.status).toBe(200);
  return response.json();
}

const happened = (player: Awaited<ReturnType<typeof join>>) =>
  [...player.history.values()].flatMap((view) => view.entries.map((entry) => `${view.turn}:${entry.player}:${entry.event ?? entry.input?.n}`));

describe("lockstep", () => {
  it("cuts inputs into turns that every player receives in the same order", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    p1.send(input(1));
    p2.send(input(2));
    p1.send(input(3));
    await until(() => happened(p1).length >= 5 && happened(p2).length >= 4, "the inputs");

    const mine = happened(p1);
    expect(mine.map((line) => line.split(":").slice(1).join(":")).sort()).toEqual(
      ["p1:1", "p1:3", "p1:join", "p2:2", "p2:join"].sort(),
    );
    expect(mine.indexOf(mine.find((line) => line.endsWith("p1:1"))!)).toBeLessThan(
      mine.indexOf(mine.find((line) => line.endsWith("p1:3"))!),
    );
    // p2 joined later, so it sees a suffix of what p1 saw: same turns, same order.
    expect(mine.slice(-happened(p2).length)).toEqual(happened(p2));
    expect(JSON.stringify(p1.frames)).not.toContain("pending");
  });

  it("puts players coming and going into the stream", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    p2.ws.close(1000, "bye");
    await until(() => happened(p1).some((line) => line.endsWith("p2:disconnect")), "the disconnect");
    const back = await join(room, "p2");
    await until(() => happened(p1).some((line) => line.endsWith("p2:reconnect")), "the reconnect");
    back.ws.send(JSON.stringify({ t: "leave", id: 99 }));
    await until(() => happened(p1).some((line) => line.endsWith("p2:leave")), "the leave");

    expect(happened(p1).map((line) => line.split(":").slice(1).join(":"))).toEqual([
      "p1:join",
      "p2:join",
      "p2:disconnect",
      "p2:reconnect",
      "p2:leave",
    ]);
  });

  it("records the match, and replaying the recording gives the live result", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    for (const n of [5, 7]) p1.send(input(n));
    p2.send(input(11));
    await until(() => happened(p1).length >= 5 && p1.tick >= 8, "the inputs and some quiet turns");

    const replay = await replayOf(room);
    expect(replay).toMatchObject({ v: 2, seed: p1.state!.seed, turnRate: 50 });
    // Only turns in which something happened are stored.
    expect(replay.turns.length).toBeLessThan(replay.turn);
    expect(replay.turns.every(([, entries]) => entries.length > 0)).toBe(true);

    await until(() => p1.tick >= replay.turn);
    const replayed = runReplay(replay, simulation);
    expect(replayed.total).toBe(23);
    expect(replayed.turns).toBe(replay.turn);
    expect(replayed).toEqual(live(p1, replay.turn));
  });

  it("lets a late joiner catch up from the recording and carry on live", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    p1.send(input(4));
    await until(() => p1.tick >= 10);

    const late = await join(room, "late");
    const replay = await replayOf(room);
    p1.send(input(6));
    await until(() => happened(late).some((line) => line.endsWith("p1:6")), "the later input");
    const end = late.tick;
    await until(() => p1.tick >= end);

    const caughtUp = live(late, end, runReplay(replay, simulation), replay.turn);
    expect(caughtUp.total).toBe(10);
    expect(caughtUp).toEqual(live(p1, end));
  });

  it("flags the match when two players report different hashes for a turn", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    await until(() => p1.state!.turn >= 6 && p2.state!.turn >= 6, "six turns");
    p1.send({ k: "h", n: 3, h: "same" });
    p2.send({ k: "h", n: 3, h: "same" });
    await until(() => p2.of("ack").length === 1);
    const before = p1.tick;
    await until(() => p1.tick >= before + 3);
    expect(p1.state!.desync).toBeNull();

    p1.send({ k: "h", n: 6, h: "one" });
    p2.send({ k: "h", n: 6, h: "other" });
    await until(() => p1.state!.desync !== null && p2.state!.desync !== null, "the desync flag");
    expect(p1.state!.desync).toEqual({ turn: 6 });
  });

  it("needs two players to disagree, about a turn that has happened", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    await until(() => p1.state!.turn >= 4 && p2.state!.turn >= 4, "four turns");

    // One player changing their mind proves nothing.
    p1.send({ k: "h", n: 2, h: "one" });
    p1.send({ k: "h", n: 2, h: "other" });
    // Nor does a claim about a turn nobody has seen yet.
    p1.send({ k: "h", n: 1_000_000, h: "one" });
    p2.send({ k: "h", n: 1_000_000, h: "other" });
    await until(() => p1.of("ack").length === 3 && p2.of("ack").length === 1);
    const before = p1.tick;
    await until(() => p1.tick >= before + 3);
    expect(p1.state!.desync).toBeNull();
  });

  it("refuses malformed inputs and more inputs than a turn allows", async () => {
    const p1 = await join(freshRoom(), "p1");
    p1.send({ k: "i", d: { type: "add", n: "lots" } });
    p1.send({ k: "nope" });
    await until(() => p1.of("reject").length === 2);
    expect(p1.of("reject").map((f) => f.reason)).toEqual(["bad_input", "invalid_command"]);

    for (let i = 0; i < 12; i++) p1.send(input(1));
    await until(() => p1.of("ack").length + p1.of("reject").length === 14, "all answers");
    expect(p1.of("reject").some((f) => f.reason === "too_many_inputs")).toBe(true);
  });

  it("serves the recording only to identified callers, and nothing else", async () => {
    const room = freshRoom();
    await join(room, "p1");
    const get = (path: string, init?: RequestInit) => exports.default.fetch(`https://tickflare.test${path}`, init);

    expect((await get(`/turns/${room}/replay`)).status).toBe(401);
    expect((await get(`/turns/${room}/other?player=p1`)).status).toBe(404);
    expect((await get(`/turns/${room}/replay?player=p1`, { method: "POST" })).status).toBe(404);
  });
});

describe("seededRandom", () => {
  it("gives the same sequence for the same seed, and a different one for another", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    const c = seededRandom(8);
    const first = Array.from({ length: 50 }, () => a());

    expect(Array.from({ length: 50 }, () => b())).toEqual(first);
    expect(Array.from({ length: 50 }, () => c())).not.toEqual(first);
    expect(first.every((n) => n >= 0 && n < 1)).toBe(true);
  });

  it("carries on from its state, which is one whole number", () => {
    const random = seededRandom(7);
    for (let i = 0; i < 20; i++) random();
    const saved = JSON.parse(JSON.stringify({ random: random.state })) as { random: number };
    expect(Number.isSafeInteger(saved.random)).toBe(true);
    const resumed = seededRandom(saved.random);

    expect(Array.from({ length: 50 }, () => resumed())).toEqual(Array.from({ length: 50 }, () => random()));
    expect(resumed.state).toBe(random.state);
  });
});

describe("stepThrough", () => {
  it("takes a simulation from any turn of a recording to any later one", () => {
    const replay: Replay<TurnInput> = {
      v: 2,
      seed: 3,
      turnRate: 10,
      turn: 12,
      turns: [[2, [{ player: "a", input: { type: "add", n: 1 } }]], [7, [{ player: "b", input: { type: "add", n: 5 } }]], [8, [{ player: "a", event: "leave" }]]],
    };
    const whole = runReplay(replay, simulation);
    for (const at of [0, 1, 2, 6, 7, 8, 12]) {
      const sim = runReplay(replay, simulation, at);
      stepThrough(sim, replay, simulation, at);
      expect(sim, `from turn ${at}`).toEqual(whole);
    }
    // The end of a recording is enough to carry on from where it starts.
    const half = runReplay(replay, simulation, 7);
    stepThrough(half, { ...replay, turns: replay.turns.slice(2) }, simulation, 7, 10);
    expect(half).toEqual(runReplay(replay, simulation, 10));
  });
});

describe("fingerprint", () => {
  /** The same digest from the runtime's own SHA-256. */
  async function reference(value: unknown): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value) ?? ""));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  }

  it("is the start of the SHA-256 of the value's JSON, whatever its length", async () => {
    const values: unknown[] = [undefined, null, 0, "", "abc", { units: [{ x: 1, y: -2.5 }], name: "é😀" }];
    // Lengths either side of every edge of a 64-byte block.
    for (const length of [53, 54, 55, 56, 57, 61, 62, 63, 64, 65, 117, 118, 119, 120, 121, 1000, 70_001]) values.push("x".repeat(length));
    for (const value of values) {
      expect(fingerprint(value), JSON.stringify(value)?.slice(0, 40)).toBe(await reference(value));
    }
    expect(fingerprint("abc")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("tells apart simulations that differ anywhere, and not ones that are the same", () => {
    const sim = { units: [{ x: 1, y: 2 }, { x: 3, y: 4 }], random: 12345 };
    expect(fingerprint(structuredClone(sim))).toBe(fingerprint(sim));
    expect(fingerprint({ ...sim, random: 12346 })).not.toBe(fingerprint(sim));
    expect(fingerprint({ ...sim, units: [sim.units[1], sim.units[0]] })).not.toBe(fingerprint(sim));
  });
});
