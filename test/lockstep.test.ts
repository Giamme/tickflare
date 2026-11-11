import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runReplay, seededRandom, type LockstepView, type Replay, type TurnEntry } from "../src/lockstep.js";
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
      if (entry.i) sim.total += entry.i.n;
      sim.trail += `${turn}:${entry.p}:${entry.e ?? entry.i?.n};`;
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
  [...player.history.values()].flatMap((view) => view.entries.map((entry) => `${view.turn}:${entry.p}:${entry.e ?? entry.i?.n}`));

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
    expect(replay).toMatchObject({ v: 1, seed: p1.state!.seed, turnRate: 50 });
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
    p1.send({ k: "h", n: 20, h: "same" });
    p2.send({ k: "h", n: 20, h: "same" });
    await until(() => p2.of("ack").length === 1);
    const before = p1.tick;
    await until(() => p1.tick >= before + 3);
    expect(p1.state!.desync).toBeNull();

    p1.send({ k: "h", n: 40, h: "one" });
    p2.send({ k: "h", n: 40, h: "other" });
    await until(() => p1.state!.desync !== null && p2.state!.desync !== null, "the desync flag");
    expect(p1.state!.desync).toEqual({ turn: 40 });
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
});
