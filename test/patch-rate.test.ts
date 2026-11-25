import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomClient } from "../src/client/index.js";
import { CloseCode } from "../src/protocol.js";
import { follow, freshRoom, sleep, until } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";
import type { PacedState } from "./worker.js";

/**
 * `patchRate`: a room that simulates more often than it sends. The fixture
 * ticks fifty times a second and sends ten times, so a patch is due every
 * fifth tick. A room that wakes late runs several ticks in one go and sends
 * after the last, so what the tests hold it to is that no two patches fall
 * within the same five ticks, and not that each falls on a fifth.
 */
const join = (room: string, player: string, prefix = "/paced") => follow<PacedState>(prefix, room, player);
type Joined = Awaited<ReturnType<typeof join>>;
/** The tick of each frame that brought `player` a newer view: patches, and the first one, which comes whole. */
const sent = (player: Joined) =>
  player.frames.flatMap((frame) => (frame.t === "patch" || (frame.t === "state" && frame.tick !== undefined) ? [frame.tick!] : []));

describe("a room that sends less often than it ticks", () => {
  it("sends at most one patch for every five ticks, with everything the ticks between did", async () => {
    const p1 = await join(freshRoom(), "p1");
    expect(p1.of("welcome")[0]).toMatchObject({ tickRate: 50, patchRate: 10 });
    await until(() => sent(p1).length >= 5);

    const ticks = sent(p1);
    const fifths = ticks.map((tick) => Math.floor(tick / 5));
    expect(new Set(fifths).size, `patches at ${ticks.join(", ")}`).toBe(fifths.length);
    expect(ticks.length).toBeLessThanOrEqual(p1.tick / 5);
    // Nothing between two patches is lost: the state of each is that of its tick.
    for (const [tick, state] of p1.history) expect(state.ticks).toBe(tick);
  });

  it("spreads the patches evenly when the rate does not divide the tick rate", async () => {
    // 50 ticks and 20 patches a second: one is due every two and a half ticks.
    const p1 = await join(freshRoom(), "p1", "/uneven");
    expect(p1.of("welcome")[0]).toMatchObject({ tickRate: 50, patchRate: 20 });
    await until(() => sent(p1).length >= 8);
    const ticks = sent(p1);
    const slots = ticks.map((tick) => Math.floor((tick * 20) / 50));
    expect(new Set(slots).size, `patches at ${ticks.join(", ")}`).toBe(slots.length);
    expect(ticks.length).toBeLessThanOrEqual((p1.tick * 20) / 50);
  });

  it("sends after every tick when the rate is not below the tick rate, and does not mention it", async () => {
    const p1 = await join(freshRoom(), "p1", "/eager");
    expect("patchRate" in p1.of("welcome")[0]!).toBe(false);
    await until(() => p1.tick >= 12);
    // One a tick, but for the ticks a late wake-up ran together.
    expect(p1.of("patch").length).toBeGreaterThan(p1.tick / 2);

    // A lockstep room has every turn to send, whatever its `patchRate` says.
    const turns = await follow<unknown>("/turns", freshRoom(), "p1");
    expect("patchRate" in turns.of("welcome")[0]!).toBe(false);
  });

  it("acks a command with the patch that shows it", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.of("patch").length >= 1);
    const id = p1.frames.length + 1;
    p1.send({ type: "add", n: 3 });
    await until(() => p1.of("ack").length > 0);

    const ack = p1.frames.findIndex((frame) => frame.t === "ack");
    expect(p1.frames[ack]).toMatchObject({ id });
    // The frame before the ack is the patch that carries the command, and it was a patch that was due.
    const patch = p1.frames[ack - 1]!;
    expect(patch).toMatchObject({ t: "patch", c: id });
    expect(p1.state!.sums.p1).toBe(3);
    const before = sent(p1).filter((tick) => tick < (patch as { tick: number }).tick).at(-1)!;
    expect(Math.floor((patch as { tick: number }).tick / 5)).toBeGreaterThan(Math.floor(before / 5));
  });

  it("holds what a tick sends until the patch that shows the tick", async () => {
    const p1 = await join(freshRoom(), "p1");
    // The fixture broadcasts from the ticks 2, 7, 12 and so on: none of them a tick a patch is due at.
    await until(() => p1.of("msg").length >= 4);
    let shown = 0;
    const beats: number[] = [];
    for (const frame of p1.frames) {
      if (frame.t === "welcome" || frame.t === "patch" || frame.t === "state") shown = frame.tick ?? shown;
      if (frame.t !== "msg") continue;
      const { beat } = frame.d as { beat: number };
      expect(beat, `the message of tick ${beat} came when the view was of tick ${shown}`).toBeLessThanOrEqual(shown);
      beats.push(beat);
    }
    // In the order they were sent in, and none missing.
    expect(beats).toEqual(beats.map((_, n) => beats[0]! + n * 5));
  });

  it("sends what is waiting at once when the simulation stops", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => sent(p1).length >= 2);
    const id = p1.frames.length + 1;
    // The fixture stops in a tick that sends a message, three ticks before the next patch is due.
    p1.send({ type: "stop" });
    await until(() => p1.state!.over, "the last state");
    await sleep(60);

    // The last state is the room's, with every tick it ran: the one it stopped in is the last.
    const ran = p1.state!.ticks;
    expect(ran % 5).toBe(2);
    expect(p1.tick).toBe(ran);
    // The command was answered, and the message of that tick has come.
    expect(p1.of("ack").map((ack) => ack.id)).toContain(id);
    expect(p1.of("msg").map((frame) => (frame.d as { beat: number }).beat).at(-1)).toBe(ran);
    // And nothing comes after it.
    const frames = p1.frames.length;
    await sleep(100);
    expect(p1.frames.length).toBe(frames);
  });

  it("does not make a player who is removed by a tick wait to hear why", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      p2.ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
    });
    // Straight after a patch, so that the tick that removes them is one no patch is due at.
    const patches = p1.of("patch").length;
    await until(() => p1.of("patch").length > patches);
    p1.send({ type: "kick", who: "p2" });

    expect(await closed).toEqual({ code: CloseCode.Removed, reason: "kicked" });
    const bye = p2.of("msg").find((frame) => "bye" in (frame.d as object));
    expect(bye, "the message sent to the player with their removal").toBeDefined();
  });
});

describe("RoomClient and a room that sends less often than it ticks", () => {
  beforeEach(() => {
    WorkerSocket.all = [];
    vi.stubGlobal("WebSocket", WorkerSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says how often patches come", async () => {
    const open = async (prefix: string) => {
      const client = new RoomClient<unknown>(`wss://tickflare.test${prefix}/${freshRoom()}?player=p1`);
      expect(client.patchRate).toBe(0);
      await until(() => client.status === "open", "the connection");
      return client;
    };
    const paced = await open("/paced");
    expect([paced.tickRate, paced.patchRate]).toEqual([50, 10]);
    // A room that sends after every tick: as often as it ticks. In event mode there is no rate.
    const ticking = await open("/ticks");
    expect([ticking.tickRate, ticking.patchRate]).toEqual([50, 50]);
    const events = await open("/rooms");
    expect([events.tickRate, events.patchRate]).toEqual([0, 0]);
    for (const client of [paced, ticking, events]) client.close();
  });
});
