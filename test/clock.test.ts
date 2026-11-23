import { afterEach, describe, expect, it, vi } from "vitest";
import { BufferedInterpolator, RoomClient } from "../src/client/index.js";
import type { LockstepView } from "../src/lockstep.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";
import { follow, freshRoom, sleep, until } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";
import type { TickState } from "./worker.js";

// The rooms run in this isolate, so moving `Date.now` here moves the clock their simulation
// keeps to: that is how these tests make a room wake late without stalling the machine.
const realNow = Date.now.bind(Date);
let ahead = 0;
/** Makes every clock in the isolate read `ms` later than it did, as a room that woke that late would see. */
function jump(ms: number): void {
  if (ahead === 0) vi.spyOn(Date, "now").mockImplementation(() => realNow() + ahead);
  ahead += ms;
}
afterEach(() => {
  ahead = 0;
  vi.restoreAllMocks();
});

const join = (room: string, player: string) => follow<TickState>("/ticks", room, `${player}&v=${PROTOCOL_VERSION}`);
const old = (room: string, player: string) => follow<TickState>("/ticks", room, `${player}&v=3`);

/** The ticks of the patches a player was sent, in order. */
const patchTicks = (p: { frames: { t: string; tick?: number }[] }) =>
  p.frames.filter((frame) => frame.t === "patch").map((frame) => frame.tick!);
/** The largest step between two patches after the one at `from`. */
const widestStep = (ticks: number[]) => Math.max(...ticks.slice(1).map((tick, i) => tick - ticks[i]!));

describe("the simulation's clock", () => {
  it("catches up on the ticks that came due while the room was late, in one patch", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.tick >= 5);
    const before = p1.of("patch").length;
    // Three ticks' worth late, at 50 a second: under the cap of five.
    jump(60);
    await until(() => p1.of("patch").length >= before + 3);

    const ticks = patchTicks(p1).slice(before - 1);
    expect(widestStep(ticks)).toBeGreaterThanOrEqual(3);
    expect(widestStep(ticks)).toBeLessThanOrEqual(5);
    // Every tick that came due ran, each with its own onTick.
    expect(p1.state!.count).toBe(p1.tick);
    // It caught up without moving the clock on: no new epoch.
    const epochs = new Set(p1.of("clock").map((frame) => frame.epoch));
    expect(epochs.size).toBe(1);
  });

  it("lets the backlog go after a long stall, and tells clients the clock moved on", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.tick >= 5 && p1.of("clock").length === 1);
    const [started] = p1.of("clock");
    const at = p1.tick;
    // Two seconds late: a hundred ticks are due. The room runs five and lets the rest go.
    jump(2_000);
    await until(() => p1.of("clock").length === 2, "the clock moving on");
    const moved = p1.of("clock")[1]!;
    expect(moved.epoch).toBeGreaterThan(started!.epoch!);
    expect(moved.tick).toBeLessThanOrEqual(at + 6);
    expect(moved.ms).toBeLessThan(20);

    // And it carries on at its usual pace from there, with no burst of the ticks it let go.
    await sleep(100);
    expect(p1.tick).toBeLessThan(at + 6 + 15);
    expect(widestStep(patchTicks(p1))).toBeLessThanOrEqual(5);
    expect(p1.state!.count).toBe(p1.tick);
  });

  it("starts the clock over when the simulation starts again, without catching up the time it was stopped", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.tick >= 3);
    p1.send({ type: "stop" });
    await until(() => p1.state!.phase === "lobby", "the lobby");
    const paused = p1.tick;
    // Well past the cap, at 50 ticks a second.
    await sleep(300);
    const before = p1.of("patch").length;
    p1.send({ type: "start" });
    await until(() => p1.tick >= paused + 3, "ticks after the start");

    const after = patchTicks(p1).slice(before);
    expect(after[0]).toBe(paused); // The start itself, sent as the change it is.
    expect(widestStep([paused, ...after.slice(1)])).toBeLessThanOrEqual(2);
  });

  it("is in welcome, and in a frame whenever it starts, stops or every few seconds", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    // The first player's welcome comes before the simulation starts: it has no clock in it.
    expect(p1.of("welcome")[0]).not.toHaveProperty("ms");
    await until(() => p1.of("clock").length === 1);
    expect(p1.of("clock")[0]).toMatchObject({ t: "clock", tick: 0, ms: 0 });
    await until(() => p1.tick >= 3);

    // Someone who joins while it runs finds out from the welcome.
    const p2 = await join(room, "p2");
    const welcome = p2.of("welcome")[0]!;
    expect(welcome.v).toBe(4);
    expect(welcome.epoch).toBe(p1.of("clock")[0]!.epoch);
    expect(welcome.ms).toBeGreaterThanOrEqual(0);
    expect(welcome.ms).toBeLessThan(40);

    p1.send({ type: "stop" });
    await until(() => p1.of("clock").length === 2, "the stop");
    const stopped = p1.of("clock")[1]!;
    expect(stopped).not.toHaveProperty("ms");
    expect(stopped).not.toHaveProperty("epoch");
    expect(stopped.tick).toBe(p1.tick);

    p1.send({ type: "start" });
    await until(() => p1.of("clock").length === 3, "the start");
    expect(p1.of("clock")[2]!.epoch).toBeGreaterThan(welcome.epoch!);
    expect(p2.of("clock")).toEqual(p1.of("clock").slice(1));

    // Five seconds on, it is said again.
    jump(5_000);
    await until(() => p1.of("clock").length === 4, "the next telling");
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
    const p1 = await follow<LockstepView<unknown>>("/turns", freshRoom(), `p1&v=${PROTOCOL_VERSION}`);
    await until(() => p1.tick >= 5);
    const before = p1.of("patch").length;
    jump(60);
    await until(() => p1.of("patch").length >= before + 6);

    const turns = p1.of("patch").map((patch) => patch.p.turn as [number] | undefined);
    const ticks = patchTicks(p1);
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]! - ticks[i - 1]!, `patch ${i}`).toBe(1);
    expect(turns.every((turn, i) => turn?.[0] === ticks[i])).toBe(true);
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
      // Here the round trip is next to nothing: the estimate is the latest tick, give or take one.
      expect(Math.abs(estimate - client.tick)).toBeLessThan(2);

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
