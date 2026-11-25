import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferedInterpolator, RoomClient } from "../src/client/index.js";
import type { LockstepView } from "../src/lockstep.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";
import { follow, freshRoom, sleep, until } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";
import type { TickState } from "./worker.js";

// The rooms run in this isolate, so `Date.now` here is the clock their simulation keeps to.
// These tests stop it and move it on by hand: a room then runs exactly the ticks the test makes
// due, however busy the machine is, and a test can make it wake late without stalling anything.
const realNow = Date.now.bind(Date);
let now = 0;
function freeze(): void {
  now = realNow();
  vi.spyOn(Date, "now").mockImplementation(() => now);
}
afterEach(() => {
  vi.restoreAllMocks();
});

const join = (room: string, player: string) => follow<TickState>("/ticks", room, `${player}&v=${PROTOCOL_VERSION}`);
const old = (room: string, player: string) => follow<TickState>("/ticks", room, `${player}&v=3`);
type Seen = { tick: number; frames: { t: string; tick?: number }[] };

/** The ticks of the patches a player was sent, in order, from the `from`th on. */
const patchTicks = (p: Seen, from = 0) =>
  p.frames
    .filter((frame) => frame.t === "patch")
    .map((frame) => frame.tick!)
    .slice(from);
const patchCount = (p: Seen) => patchTicks(p).length;

/** Moves the clock on by `ms` and waits for the room to have run `ticks` more ticks. At 50 a second a tick is 20 ms. */
async function advance(p: Seen, ms: number, ticks = Math.floor(ms / 20)): Promise<void> {
  const want = p.tick + ticks;
  now += ms;
  await until(() => p.tick >= want, `tick ${want}`);
}

describe("the simulation's clock", () => {
  it("catches up on the ticks that came due while the room was late, in one patch", async () => {
    freeze();
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.of("clock").length === 1, "the start");
    for (let i = 0; i < 3; i++) await advance(p1, 20);
    const before = patchCount(p1);
    // Three ticks' worth late: under the cap of five.
    await advance(p1, 60);

    expect(patchTicks(p1, before)).toEqual([6]);
    // Every tick that came due ran, each with its own onTick.
    expect(p1.state!.count).toBe(6);
    // It caught up without moving the clock on: no new epoch, and nothing said.
    expect(p1.of("clock")).toHaveLength(1);
  });

  it("lets the backlog go after a long stall, and tells clients the clock moved on", async () => {
    freeze();
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.of("clock").length === 1, "the start");
    for (let i = 0; i < 3; i++) await advance(p1, 20);
    const [started] = p1.of("clock");
    const before = patchCount(p1);
    // Two seconds late: a hundred ticks are due. The room runs five and lets the rest go.
    await advance(p1, 2_000, 5);
    await until(() => p1.of("clock").length === 2, "the clock moving on");
    expect(p1.of("clock")[1]).toEqual({ t: "clock", tick: 8, ms: 0, epoch: started!.epoch! + 1 });

    // And it carries on at its usual pace from there, with no burst of the ticks it let go.
    await advance(p1, 20);
    expect(patchTicks(p1, before)).toEqual([8, 9]);
    expect(p1.state!.count).toBe(9);
  });

  it("starts the clock over when the simulation starts again, without catching up the time it was stopped", async () => {
    freeze();
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.of("clock").length === 1, "the start");
    for (let i = 0; i < 3; i++) await advance(p1, 20);
    p1.send({ type: "stop" });
    await until(() => p1.of("clock").length === 2, "the stop");
    // Well past the cap.
    now += 300;
    const before = patchCount(p1);
    p1.send({ type: "start" });
    await until(() => p1.of("clock").length === 3, "the start again");
    await advance(p1, 20);

    // The start itself, sent as the change it is, then one tick.
    expect(patchTicks(p1, before)).toEqual([3, 4]);
    expect(p1.of("clock")[2]).toMatchObject({ tick: 3, ms: 0 });
  });

  it("is in welcome, and in a frame whenever it starts, stops, and every five seconds", async () => {
    freeze();
    const room = freshRoom();
    const p1 = await join(room, "p1");
    // The first player's welcome comes before the simulation starts: it has no clock in it.
    expect(p1.of("welcome")[0]).not.toHaveProperty("ms");
    await until(() => p1.of("clock").length === 1, "the start");
    const [started] = p1.of("clock");
    expect(started).toMatchObject({ t: "clock", tick: 0, ms: 0 });
    for (let i = 0; i < 3; i++) await advance(p1, 20);

    // Someone who joins while it runs finds out from the welcome.
    now += 10;
    const p2 = await join(room, "p2");
    expect(p2.of("welcome")[0]).toMatchObject({ v: PROTOCOL_VERSION, tick: 3, ms: 10, epoch: started!.epoch });

    // Five seconds on, in steps the room keeps up with, it is said again.
    await advance(p1, 10, 1);
    for (let i = 0; i < 49; i++) await advance(p1, 100);
    expect(p1.of("clock")).toHaveLength(1);
    await advance(p1, 100);
    await until(() => p1.of("clock").length === 2, "the telling");
    expect(p1.of("clock")[1]).toEqual({ t: "clock", tick: 254, ms: 0, epoch: started!.epoch });

    p1.send({ type: "stop" });
    await until(() => p1.of("clock").length === 3, "the stop");
    expect(p1.of("clock")[2]).toEqual({ t: "clock", tick: 254 });

    p1.send({ type: "start" });
    await until(() => p1.of("clock").length === 4, "the start again");
    expect(p1.of("clock")[3]!.epoch).toBeGreaterThan(started!.epoch!);
    await until(() => p2.of("clock").length === 3, "p2 hearing the same");
    expect(p2.of("clock")).toEqual(p1.of("clock").slice(1));
  });

  it("is not sent to clients of earlier versions", async () => {
    const room = freshRoom();
    const p1 = await old(room, "p1");
    await until(() => p1.tick >= 3);
    const p2 = await old(room, "p2");
    p1.send({ type: "stop" });
    await until(() => p1.state!.phase === "lobby");
    p1.send({ type: "start" });
    await until(() => p2.tick >= p1.tick && p1.state!.phase === "playing");

    expect(p2.of("welcome")[0]).toMatchObject({ v: 3 });
    expect(p2.of("welcome")[0]).not.toHaveProperty("ms");
    expect([...p1.frames, ...p2.frames].filter((frame) => frame.t === "clock")).toEqual([]);
  });
});

describe("a lockstep room catching up", () => {
  it("still sends every turn in a frame of its own", async () => {
    freeze();
    const p1 = await follow<LockstepView<unknown>>("/turns", freshRoom(), `p1&v=${PROTOCOL_VERSION}`);
    await until(() => p1.of("clock").length === 1, "the start");
    for (let i = 0; i < 3; i++) await advance(p1, 20);
    const before = patchCount(p1);
    await advance(p1, 60);

    expect(patchTicks(p1, before)).toEqual([4, 5, 6]);
    expect(p1.of("patch").slice(before).map((patch) => (patch.p.turn as [number])[0])).toEqual([4, 5, 6]);
  });
});

describe("RoomClient against a ticking room", () => {
  it("knows the room's tick between frames, and draws through a BufferedInterpolator a steady way behind it", async () => {
    vi.stubGlobal("WebSocket", WorkerSocket);
    const client = new RoomClient<TickState>(`wss://tickflare.test/ticks/${freshRoom()}?player=p1`);
    const glide = new BufferedInterpolator(client, ["x"]);
    client.on("state", (state) => glide.update({ count: { x: state.count } }));
    try {
      await until(() => client.tick >= 10 && client.rtt !== undefined, "ticks and a round trip");
      const estimate = client.serverTick()!;
      // Here the round trip is next to nothing: the estimate is the latest tick, give or take a patch held up.
      expect(Math.abs(estimate - client.tick)).toBeLessThan(3);

      const drawn: number[] = [];
      for (let i = 0; i < 10; i++) {
        await sleep(20);
        drawn.push(glide.at("count")!.x);
      }
      // What is drawn only goes forward, about a tick for every 20 ms, a couple of ticks behind.
      for (let i = 1; i < drawn.length; i++) expect(drawn[i]!).toBeGreaterThanOrEqual(drawn[i - 1]!);
      expect(drawn[drawn.length - 1]! - drawn[0]!).toBeGreaterThan(4);
      expect(drawn[drawn.length - 1]!).toBeLessThan(client.serverTick()!);
      expect(drawn[drawn.length - 1]!).toBeGreaterThan(client.serverTick()! - glide.delay - 3);
    } finally {
      client.close();
      vi.unstubAllGlobals();
    }
  });
});
