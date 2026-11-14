import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { follow, freshRoom, sleep, until } from "./helpers.js";
import type { TickState } from "./worker.js";

const join = (room: string, player: string) => follow<TickState>("/ticks", room, player);

const stubFor = (room: string) => env.TICKS.get(env.TICKS.idFromName(room));

function saved(room: string): Promise<{ count: number; tick: number }> {
  return runInDurableObject(stubFor(room), (_instance, state) => {
    const row = state.storage.sql.exec<{ state: string; tick: number }>("SELECT state, tick FROM tickflare_room").one();
    return { count: (JSON.parse(row.state) as TickState).count, tick: row.tick };
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

  it("answers a command with the tick that shows its effect, and says so in that tick's frame", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => p1.tick >= 3);
    p1.send({ type: "bump" });
    const id = p1.frames.length; // `send` numbers a command by the frames seen so far, plus one
    await until(() => p1.of("ack").length === 1, "the ack");

    // The frame before the ack is the patch that carries the bump, marked as the one that shows
    // this player's command. So by the time a client hears "applied", its state has the effect.
    const at = p1.frames.findIndex((frame) => frame.t === "ack");
    const shows = p1.frames[at - 1]!;
    expect(shows).toMatchObject({ t: "patch", c: id + 1, p: { bumps: [1] } });
    expect(p1.frames[at]).toEqual({ t: "ack", id: id + 1, seq: (shows as { seq: number }).seq, tick: (shows as { tick: number }).tick });
    expect(p1.frames.filter((frame) => "c" in frame)).toHaveLength(1);
    expect(p1.of("state")).toHaveLength(0);
  });

  it("answers a command that changes nothing the player sees after the tick, without a frame for it", async () => {
    // A room whose ticks change nothing, so that no patch is due unless a command makes one.
    const p1 = await join(`still-${freshRoom()}`, "p1");
    p1.send({ type: "bump" });
    await until(() => p1.of("ack").length === 1, "the first ack");
    expect(p1.of("patch")).toHaveLength(1);
    expect(p1.of("patch")[0]).toMatchObject({ p: { bumps: [1] } });

    // Setting a timer changes nothing in the state: there is no frame to carry the answer.
    p1.send({ type: "timer", ms: 60_000 });
    p1.send({ type: "timer", ms: 60_000 });
    await until(() => p1.of("ack").length === 3, "the acks");
    expect(p1.of("patch")).toHaveLength(1);
    const [, first, second] = p1.of("ack") as { tick?: number }[];
    // Each says which tick the view is now of, which is a later one than the patch was.
    expect(first!.tick).toBeGreaterThan(p1.of("patch")[0]!.tick);
    expect(second!.tick).toBeGreaterThanOrEqual(first!.tick!);
  });

  it("answers at once what was still owed when the simulation stops or the player leaves", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    await until(() => p1.tick >= 3);
    // A command that stops the simulation: there is no next tick to wait for.
    p1.send({ type: "stop" });
    await until(() => p1.of("ack").length === 1, "the ack of the command that stopped it");
    expect(p1.state!.phase).toBe("lobby");
    const stopped = p1.frames.findIndex((frame) => frame.t === "ack");
    expect(p1.frames[stopped - 1]).toMatchObject({ t: "patch", p: { phase: ["lobby"] } });

    p1.send({ type: "start" });
    await until(() => p2.state!.phase === "playing" && p2.tick >= p1.tick);
    // A bump and a leave in one breath: the bump is answered before the leave is.
    p2.send({ type: "bump" });
    p2.ws.send(JSON.stringify({ t: "leave", id: 9000 }));
    await until(() => p2.of("ack").length === 2, "both acks");
    const ids = p2.of("ack").map((frame) => frame.id);
    expect(ids[1]).toBe(9000);
    expect(ids[0]).toBeLessThan(9000);
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

  describe("with ticksWhileEmpty()", () => {
    const awake = (room: string) =>
      runInDurableObject(stubFor(room), async (_instance, state) => ({
        timer: state.storage.sql.exec("SELECT name FROM tickflare_timers WHERE name = 'tickflare:awake'").toArray().length > 0,
        alarm: await state.storage.getAlarm(),
      }));

    it("plays on with nobody connected, until the game says it is over", async () => {
      const room = `onward-${freshRoom()}`;
      const p1 = await join(room, "p1");
      await until(() => p1.tick >= 5);
      p1.ws.close(1000, "bye");
      await sleep(150);

      const first = await saved(room);
      await sleep(300);
      const later = await saved(room);
      expect(later.count).toBeGreaterThan(first.count + 5);
      // An alarm a few seconds ahead keeps the object in memory, and would restart it.
      const during = await awake(room);
      expect(during.timer).toBe(true);
      expect(during.alarm).toBeGreaterThan(Date.now());

      // The fixture ends its match at 150. Then the room is asleep like any other.
      for (let waited = 0; (await saved(room)).count < 150; waited += 50) {
        expect(waited).toBeLessThan(8000);
        await sleep(50);
      }
      await sleep(200);
      expect((await saved(room)).count).toBe(150);
      expect((await awake(room)).timer).toBe(false);
    });

    it("carries on from its last save when the room is torn down", async () => {
      const room = `onward-${freshRoom()}`;
      const p1 = await join(room, "p1");
      await until(() => p1.tick >= 5);
      p1.ws.close(1000, "bye");
      await sleep(250);
      const before = await saved(room);

      // What a deploy does: the object is gone from memory, loop and all. Its alarm brings it back.
      await runInDurableObject(stubFor(room), (_instance, state) => {
        try {
          state.abort("torn down");
        } catch {
          // Aborting throws in the caller.
        }
      }).catch(() => {});
      await sleep(100);
      expect((await saved(room)).count).toBeLessThanOrEqual(before.count + 6);
      expect(await runDurableObjectAlarm(stubFor(room))).toBe(true);
      await sleep(300);
      expect((await saved(room)).count).toBeGreaterThan(before.count + 6);
    });

    it("hands the match to whoever comes back", async () => {
      const room = `onward-${freshRoom()}`;
      const p1 = await join(room, "p1");
      await until(() => p1.tick >= 5);
      const left = p1.tick;
      p1.ws.close(1000, "bye");
      await sleep(400);

      // It went on while nobody was there: twenty ticks on a machine that keeps up, a few on any.
      const back = await join(room, "p1");
      expect(back.of("welcome")[0]!.state.count).toBeGreaterThan(left + 3);
      await until(() => back.tick >= back.of("welcome")[0]!.tick + 3);
      expect(back.state!.count).toBe(back.tick);
      expect((await awake(room)).timer).toBe(false);
    });

    it("leaves other rooms as they were: they stop when the last player drops", async () => {
      const room = freshRoom();
      const p1 = await join(room, "p1");
      await until(() => p1.tick >= 5);
      p1.ws.close(1000, "bye");
      await sleep(150);
      expect((await awake(room)).timer).toBe(false);
    });
  });

  // While the simulation runs, a command's change is neither saved nor turned into JSON when it
  // is made. Everything that then needs the state as it is has to find the change there.
  describe("a command's change while ticking", () => {
    const state = (room: string) =>
      runInDurableObject(stubFor(room), (_instance, storage) =>
        JSON.parse(storage.storage.sql.exec<{ state: string }>("SELECT state FROM tickflare_room").one().state) as TickState,
      );
    async function bumped(times: number) {
      const room = freshRoom();
      const p1 = await join(room, "p1");
      await until(() => p1.tick >= 3);
      for (let i = 0; i < times; i++) p1.send({ type: "bump" });
      await until(() => p1.of("ack").length === times, "the acks");
      return { room, p1 };
    }

    it("survives a tick that fails straight after it", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { room, p1 } = await bumped(3);
      p1.send({ type: "break" });
      await until(() => p1.state?.broken === true, "the break");
      // Long enough for the ticks after it to fail.
      await sleep(300);
      error.mockRestore();

      // Each failed tick was put back to the state as the commands left it.
      expect(p1.state).toMatchObject({ bumps: 3, broken: true });
      expect(await state(room)).toMatchObject({ bumps: 3, broken: true });
    });

    it("is not mistaken for a change made behind the room's back when a request reads the state", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { room, p1 } = await bumped(2);
      const response = await exports.default.fetch(`https://tickflare.test/ticks/${room}/score?player=p1`);
      expect(await response.json()).toMatchObject({ bumps: 2 });
      p1.send({ type: "bump" });
      await until(() => p1.state!.bumps === 3, "the third bump");

      expect(error).not.toHaveBeenCalled();
      error.mockRestore();
    });

    it("outlasts a hook that breaks the rules after it", async () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { p1 } = await bumped(2);
      p1.send({ type: "later" });
      await until(() => p1.of("reject").length === 1, "the refusal");
      p1.send({ type: "bump" });
      await until(() => p1.state!.bumps === 3, "the third bump");
      const before = p1.tick;
      await until(() => p1.tick >= before + 3);

      expect(p1.state!.bumps).toBe(3);
      // The one line about the promise, and none about the state having been changed.
      expect(error.mock.calls.flat().join(" ")).not.toContain("outside a hook");
      error.mockRestore();
    });

    it("is written when the simulation stops", async () => {
      const { room, p1 } = await bumped(4);
      p1.send({ type: "stop" });
      await until(() => p1.state!.phase === "lobby", "the stop");
      await sleep(50);

      expect(await state(room)).toMatchObject({ bumps: 4, phase: "lobby" });
    });

    it("is written with a timer set after it, which is saved at once", async () => {
      const { room, p1 } = await bumped(2);
      p1.send({ type: "timer", ms: 60_000 });
      await until(() => p1.of("ack").length === 3, "the ack");

      expect(await state(room)).toMatchObject({ bumps: 2 });
    });

    it("is there for the next player to join", async () => {
      const { room } = await bumped(5);
      const p2 = await join(room, "p2");
      expect(p2.of("welcome")[0]!.state.bumps).toBe(5);
    });
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
    expect(p1.frames.slice(-2).map((f) => f.t)).toEqual(["patch", "ack"]);
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
