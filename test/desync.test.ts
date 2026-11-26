import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockstepClient } from "../src/client/index.js";
import { differences, type CatchUp, type Desync, type LockstepView, type TurnEntry } from "../src/lockstep.js";
import { follow, freshRoom, until } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";
import type { TurnInput } from "./worker.js";

/**
 * A desync that says where: the two players whose hashes differed send the
 * room what their simulations had saved at that turn, and the room names
 * the places where the two differ.
 */
type View = LockstepView<TurnInput>;
const join = (room: string, player: string) => follow<View>("/turns", room, player);
const explain = (room: string, player: string, turn: number, body: string) =>
  exports.default.fetch(`https://tickflare.test/turns/${room}/desync?player=${player}&turn=${turn}`, { method: "POST", body });

describe("differences", () => {
  it("names each place where two values differ, down to what cannot be taken apart", () => {
    const one = { turn: 40, units: { a: { x: 1, y: 2 }, b: { x: 3.5, y: 0 } }, random: 123 };
    const other = { turn: 40, units: { a: { x: 1, y: 2 }, b: { x: 3.25, y: 0 } }, random: 456 };
    expect(differences(one, other)).toEqual([
      { path: "units.b.x", values: ["3.5", "3.25"] },
      { path: "random", values: ["123", "456"] },
    ]);
    expect(differences(one, structuredClone(one))).toEqual([]);
  });

  it("says where one has something the other has not, in objects and in lists", () => {
    expect(differences({ a: 1, gone: true }, { a: 1, added: "x" })).toEqual([
      { path: "gone", values: ["true", "undefined"] },
      { path: "added", values: ["undefined", '"x"'] },
    ]);
    expect(differences({ list: [1, 2, 3] }, { list: [1, 5] })).toEqual([
      { path: "list.1", values: ["2", "5"] },
      { path: "list.2", values: ["3", "undefined"] },
    ]);
  });

  it("gives things of different kinds whole, and cuts what is long", () => {
    expect(differences({ at: [1, 2] }, { at: { x: 1, y: 2 } })).toEqual([{ path: "at", values: ["[1,2]", '{"x":1,"y":2}'] }]);
    expect(differences(1, "1")).toEqual([{ path: "", values: ["1", '"1"'] }]);
    expect(differences({ at: null }, { at: {} })).toEqual([{ path: "at", values: ["null", "{}"] }]);
    const [long] = differences({ name: "x".repeat(300) }, { name: 1 });
    expect(long!.values[0]).toHaveLength(100);
    expect(long!.values[0].endsWith("…")).toBe(true);
  });

  it("stops at as many as were asked for", () => {
    const one = Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`k${n}`, n]));
    const other = Object.fromEntries(Array.from({ length: 50 }, (_, n) => [`k${n}`, -n - 1]));
    expect(differences(one, other)).toHaveLength(8);
    expect(differences(one, other, 3).map((found) => found.path)).toEqual(["k0", "k1", "k2"]);
  });
});

describe("a lockstep room told what two simulations had when they differed", () => {
  /** Two players who have reported different hashes for turn 6. */
  async function disagreed() {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    const p3 = await join(room, "p3");
    await until(() => p1.state!.turn >= 6 && p2.state!.turn >= 6, "six turns");
    p1.send({ k: "h", n: 6, h: "one" });
    await until(() => p1.of("ack").length === 1);
    p2.send({ k: "h", n: 6, h: "other" });
    await until(() => p3.state!.desync !== null, "the desync flag");
    return { room, p1, p2, p3 };
  }

  it("says whose simulations differed", async () => {
    const { p3 } = await disagreed();
    expect(p3.state!.desync).toEqual({ turn: 6, players: ["p1", "p2"] });
  });

  it("says where, once both have sent what they saved, and tells everyone", async () => {
    const { room, p1, p3 } = await disagreed();
    expect((await explain(room, "p2", 6, JSON.stringify({ gold: { p1: 10, p2: 12 }, wave: 3 }))).status).toBe(202);
    expect(p3.state!.desync!.differs).toBeUndefined();
    expect((await explain(room, "p1", 6, JSON.stringify({ gold: { p1: 10, p2: 7 }, wave: 3 }))).status).toBe(201);

    const explained: Desync = { turn: 6, players: ["p1", "p2"], differs: [{ path: "gold.p2", values: ["7", "12"] }] };
    await until(() => p3.state!.desync!.differs !== undefined && p1.state!.desync!.differs !== undefined, "the comparison");
    expect(p3.state!.desync).toEqual(explained);
    expect(p1.state!.desync).toEqual(explained);
    // It is settled: nothing more is taken.
    expect((await explain(room, "p1", 6, "{}")).status).toBe(409);
  });

  it("finds nothing to name when what they saved is the same", async () => {
    const { room, p3 } = await disagreed();
    await explain(room, "p1", 6, JSON.stringify({ wave: 3 }));
    await explain(room, "p2", 6, JSON.stringify({ wave: 3 }));
    await until(() => p3.state!.desync!.differs !== undefined, "the comparison");
    expect(p3.state!.desync!.differs).toEqual([]);
  });

  it("takes it only from the two players, for that turn, as JSON", async () => {
    const { room, p3 } = await disagreed();
    expect((await explain(room, "p3", 6, "{}")).status).toBe(409);
    expect((await explain(room, "stranger", 6, "{}")).status).toBe(409);
    expect((await explain(room, "p1", 5, "{}")).status).toBe(409);
    expect((await explain(room, "p1", 6, "not json")).status).toBe(400);
    // The same player twice is still one player.
    expect((await explain(room, "p1", 6, "{}")).status).toBe(202);
    expect((await explain(room, "p1", 6, '{"a":1}')).status).toBe(202);
    expect(p3.state!.desync!.differs).toBeUndefined();
    expect((await explain(room, "p2", 6, '{"a":2}')).status).toBe(201);
    await until(() => p3.state!.desync!.differs !== undefined, "the comparison");
    expect(p3.state!.desync!.differs).toEqual([{ path: "a", values: ["1", "2"] }]);

    // And only when two players have disagreed.
    const calm = freshRoom();
    await join(calm, "p1");
    expect((await explain(calm, "p1", 6, "{}")).status).toBe(409);
  });
});

describe("LockstepClient, when its simulation differs from another's", () => {
  beforeEach(() => {
    WorkerSocket.all = [];
    vi.stubGlobal("WebSocket", WorkerSocket);
  });
  const clients: LockstepClient<TurnInput, Sim>[] = [];
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    vi.unstubAllGlobals();
  });

  type Sim = { turns: number; units: Record<string, { x: number; hp: number }> };
  /** A simulation that goes wrong for `faulty` from turn 9 on: one unit is a little off. */
  function play(room: string, player: string, faulty: boolean, options: { hash?: (sim: Sim) => number; explainDesyncs?: boolean } = {}) {
    const seen = { desyncs: [] as Desync[], explained: [] as Desync[], posts: [] as string[] };
    const client = new LockstepClient<TurnInput, Sim>(`wss://tickflare.test/turns/${room}?player=${player}`, {
      create: () => ({ turns: 0, units: { scout: { x: 0, hp: 10 }, tank: { x: 0, hp: 50 } } }),
      step(sim: Sim, _entries: TurnEntry<TurnInput>[], turn: number) {
        sim.turns = turn;
        sim.units.scout!.x += 2;
        sim.units.tank!.x += faulty && turn === 9 ? 1.5 : 1;
      },
      save: (sim) => sim,
      load: (saved) => saved as Sim,
      ...options,
      bufferTurns: 0,
      hashEvery: 7,
      onDesync: (_turn, desync) => seen.desyncs.push(desync),
      onDesyncExplained: (desync) => seen.explained.push(desync),
      loadReplay: async (url) => (await (await exports.default.fetch(url)).json()) as CatchUp<TurnInput>,
      sendSnapshot: (url, data) => {
        seen.posts.push(new URL(url).pathname.split("/").at(-1)!);
        return exports.default.fetch(url, { method: "POST", body: data });
      },
    });
    clients.push(client);
    return seen;
  }

  it("sends what it had saved at that turn, and is told where the two differ", async () => {
    const room = freshRoom();
    const right = play(room, "p1", false);
    const wrong = play(room, "p2", true);
    await until(() => right.explained.length > 0 && wrong.explained.length > 0, "the comparison");

    // Turn 14 is the first hashed turn after the fault. Whoever reported first is named first.
    const desync = right.explained[0]!;
    expect(desync.turn).toBe(14);
    expect([...desync.players!].sort()).toEqual(["p1", "p2"]);
    const values = desync.players![0] === "p1" ? ["14", "14.5"] : ["14.5", "14"];
    expect(desync.differs).toEqual([{ path: "units.tank.x", values }]);
    expect(wrong.explained[0]).toEqual(desync);
    // Each was told of the desync once, before it was explained, and sent its simulation once.
    expect(right.desyncs).toEqual([{ turn: 14, players: desync.players }]);
    expect(right.posts.filter((path) => path === "desync")).toHaveLength(1);
    expect(wrong.posts.filter((path) => path === "desync")).toHaveLength(1);
  });

  it("keeps nothing to send when the game hashes for itself, unless asked to", async () => {
    const hash = (sim: Sim) => sim.units.tank!.x * 1000 + sim.units.scout!.x;
    const quiet = freshRoom();
    const one = play(quiet, "p1", false, { hash });
    const two = play(quiet, "p2", true, { hash });
    await until(() => one.desyncs.length > 0 && two.desyncs.length > 0, "the desync");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect([one.posts, two.posts, one.explained]).toEqual([[], [], []]);

    const asked = freshRoom();
    const first = play(asked, "p1", false, { hash, explainDesyncs: true });
    const second = play(asked, "p2", true, { hash, explainDesyncs: true });
    await until(() => first.explained.length > 0 && second.explained.length > 0, "the comparison");
    expect(first.explained[0]!.differs!.map((found) => found.path)).toEqual(["units.tank.x"]);
  });
});
