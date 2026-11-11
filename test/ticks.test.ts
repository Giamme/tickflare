import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { follow, freshRoom, sleep, until } from "./helpers.js";
import type { TickState } from "./worker.js";

const join = (room: string, player: string) => follow<TickState>("/ticks", room, player);

const stubFor = (room: string) => env.TICKS.get(env.TICKS.idFromName(room));

function saved(room: string): Promise<{ count: number; tick: number }> {
  return runInDurableObject(stubFor(room), (_instance, state) => {
    const row = state.storage.sql.exec<{ state: string }>("SELECT state FROM tickflare_room").one();
    const tick = state.storage.sql
      .exec<{ value: string }>("SELECT value FROM tickflare_meta WHERE key = 'tick'")
      .one();
    return { count: (JSON.parse(row.state) as TickState).count, tick: Number(tick.value) };
  });
}

describe("state sync", () => {
  it("runs onTick at the tick rate and sends only what changed", async () => {
    const p1 = await join(freshRoom(), "p1");
    expect(p1.of("welcome")[0]).toMatchObject({ tickRate: 50, tick: 0 });
    await sleep(400);

    // 50 Hz for 0.4 s is 20 ticks; allow for a slow machine.
    expect(p1.tick).toBeGreaterThan(8);
    expect(p1.tick).toBeLessThan(28);
    expect(p1.state!.count).toBe(p1.tick);
    expect(Object.keys(p1.state!.ballast)).toHaveLength(50);

    expect(p1.of("state")).toHaveLength(0);
    const patches = p1.of("patch");
    expect(patches.length).toBeGreaterThan(8);
    for (const patch of patches) {
      expect(Object.keys(patch.p).sort()).toEqual(["count", "secrets"]);
    }
  });

  it("keeps each player's view private in patches", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    await until(() => p2.tick > 5 && p1.tick > 5);

    expect(Object.keys(p1.state!.secrets)).toEqual(["p1"]);
    expect(Object.keys(p2.state!.secrets)).toEqual(["p2"]);
    expect(p2.state!.secrets.p2).toBe(p2.state!.count * 2);
    expect(JSON.stringify(p1.frames)).not.toContain('"p2":');
  });

  it("brings a late joiner to the same state as everyone else", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    await until(() => p1.tick >= 4);
    const p2 = await join(room, "p2");
    const joinedAt = p2.tick;
    await until(() => p1.tick >= joinedAt + 6 && p2.tick >= joinedAt + 6);

    expect(p2.of("state")).toHaveLength(0);
    for (let tick = joinedAt + 1; tick <= joinedAt + 6; tick++) {
      expect(p2.history.get(tick)?.count, `tick ${tick}`).toBe(p1.history.get(tick)?.count);
    }
    expect(p2.state!.ballast).toEqual(p1.state!.ballast);
  });

  it("acks a command at once and delivers its effect with a later tick", async () => {
    const p1 = await join(freshRoom(), "p1");
    p1.send({ type: "bump" });
    await until(() => p1.state!.bumps === 1, "the bump");

    const frames = p1.frames.map((f) => f.t);
    expect(frames.indexOf("ack")).toBeGreaterThan(0);
    expect(p1.of("state")).toHaveLength(0);
    expect(p1.of("patch").some((f) => "bumps" in f.p)).toBe(true);
  });

  it("rolls a rejected command back to the present, not to the last save", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.tick >= 8);
    p1.send({ type: "half" });
    await until(() => p1.of("reject").length === 1, "the reject");
    const before = p1.tick;
    await until(() => p1.tick >= before + 4);

    const counts = [...p1.history.values()].map((state) => state.count);
    expect(Math.max(...counts)).toBeLessThan(1000);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(p1.state!.count).toBeGreaterThanOrEqual(before);
  });

  it("writes the state to storage on the save interval while it runs", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    await until(() => p1.tick >= 12);

    const { count, tick } = await saved(room);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(p1.tick + 2);
    expect(tick).toBe(count);
  });

  it("stops when the last player drops, and resumes from where it stopped", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    await until(() => p1.tick >= 5);
    p1.ws.close(1000, "bye");
    await sleep(100);

    const stopped = await saved(room);
    expect(stopped.count).toBeGreaterThanOrEqual(5);
    await sleep(100);
    expect(await saved(room)).toEqual(stopped);

    const back = await join(room, "p1");
    expect(back.of("welcome")[0]).toMatchObject({ tick: stopped.tick, state: { count: stopped.count } });
    await until(() => back.tick >= stopped.tick + 3);
    expect(back.state!.count).toBe(back.tick);
  });

  it("behaves as event mode while shouldTick() is false", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.tick >= 3);

    p1.send({ type: "stop" });
    await until(() => p1.state!.phase === "lobby", "the lobby");
    const paused = p1.tick;
    await sleep(120);
    expect(p1.tick).toBe(paused);

    // In the lobby a command is saved and sent whole straight away, then acked.
    p1.send({ type: "bump" });
    await until(() => p1.of("ack").length === 2, "the second ack");
    expect(p1.frames.slice(-2).map((f) => f.t)).toEqual(["state", "ack"]);
    expect(p1.state!.bumps).toBe(1);

    p1.send({ type: "start" });
    await until(() => p1.tick >= paused + 3, "ticks after start");
    expect(p1.state!.phase).toBe("playing");
    expect(p1.state!.count).toBe(p1.tick);
  });

  it("fires timers while the simulation runs", async () => {
    const p1 = await join(freshRoom(), "p1");
    p1.send({ type: "timer", ms: 60 });
    await until(() => p1.state!.log.includes("timer:bell"), "the timer");
    expect(p1.state!.count).toBeGreaterThan(0);
  });

  it("pauses a simulation that keeps failing, until the next event", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.tick >= 3);
    p1.send({ type: "break" });
    await sleep(300);

    // Five failed ticks, then one line saying the simulation is paused.
    expect(error).toHaveBeenCalledTimes(6);
    error.mockRestore();
    const stuck = p1.state!.count;

    p1.send({ type: "fix" });
    await until(() => p1.state!.count >= stuck + 3, "ticks after the fix");
    expect(p1.state!.broken).toBe(false);
  });
});
