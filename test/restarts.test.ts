import { abortAllDurableObjects, evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { LockstepView, Replay } from "../src/lockstep.js";
import { connect, follow, freshRoom, sleep, until } from "./helpers.js";
import type { TickState, TurnInput } from "./worker.js";

/** Resolves once `seen` has been sent nothing for `ms`. */
async function quiet(seen: { frames: unknown[] }, ms = 300): Promise<void> {
  for (let count = -1; count !== seen.frames.length; ) {
    count = seen.frames.length;
    await sleep(ms);
  }
}

/**
 * What a deploy or a crash leaves behind is whatever is in storage. These
 * tests tear rooms down without warning and look at what they resume from.
 */
describe("a room saved by an older version", () => {
  it("gets the tables that came later, and plays on", async () => {
    const room = freshRoom();
    const stub = env.LAZY.get(env.LAZY.idFromName(room));
    const p1 = await follow<TickState>("/lazy", room, "p1");
    p1.send({ type: "timer", ms: 40 });
    await until(() => p1.state!.log.includes("timer:bell"), "the first timer");
    // A timer to fire after the restart, and the tables a room from before had none of.
    p1.send({ type: "timer", ms: 400 });
    await sleep(50);
    await runInDurableObject(stub, (_instance, state) => {
      for (const table of ["tickflare_forwards", "tickflare_arrivals", "tickflare_outbox"]) {
        state.storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
      }
    });
    await abortAllDurableObjects();

    // Its alarm fires the timer, and a player who comes back can play.
    const p2 = await follow<TickState>("/lazy", room, "p2");
    await until(() => (p2.state?.log.filter((entry) => entry === "timer:bell").length ?? 0) >= 2, "the timer after the restart");
    p2.send({ type: "timer", ms: 40 });
    await until(() => (p2.state?.log.filter((entry) => entry === "timer:bell").length ?? 0) >= 3, "a timer set after the restart");
    const after = env.LAZY.get(env.LAZY.idFromName(room));
    const tables = await runInDurableObject(after, (_instance, state) =>
      state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'tickflare_%'").toArray().map((row) => row.name),
    );
    expect(tables).toEqual(expect.arrayContaining(["tickflare_forwards", "tickflare_arrivals", "tickflare_outbox"]));
  });
});

describe("a ticking room that is torn down", () => {
  it("has either the timer or its effect in storage, never neither", async () => {
    const room = freshRoom();
    const stub = env.LAZY.get(env.LAZY.idFromName(room));
    const p1 = await follow<TickState>("/lazy", room, "p1");
    p1.send({ type: "timer", ms: 40 });
    await until(() => p1.state!.log.includes("timer:bell"), "the timer");

    await abortAllDurableObjects();
    const after = await runInDurableObject(stub, (_instance, state) => ({
      log: (JSON.parse(state.storage.sql.exec<{ state: string }>("SELECT state FROM tickflare_room").one().state) as TickState).log,
      timers: state.storage.sql.exec("SELECT name FROM tickflare_timers").toArray().length,
    }));
    expect(after.timers === 1 || after.log.includes("timer:bell"), JSON.stringify(after)).toBe(true);
  });

  it("has saved the state a finished match came from by the time the match is announced", async () => {
    const room = freshRoom();
    const stub = env.LAZY.get(env.LAZY.idFromName(room));
    const p1 = await follow<TickState>("/lazy", room, "p1");
    p1.send({ type: "win" });
    await until(() => p1.state!.bumps === 99, "the win");
    await sleep(100);

    await abortAllDurableObjects();
    const after = await runInDurableObject(stub, (_instance, state) => ({
      owed: state.storage.sql.exec("SELECT id FROM tickflare_outbox").toArray().length,
      bumps: (JSON.parse(state.storage.sql.exec<{ state: string }>("SELECT state FROM tickflare_room").one().state) as TickState).bumps,
    }));
    expect(after).toEqual({ owed: 0, bumps: 99 });
  });
});

describe("a ticking room that is taken out of memory with its players connected", () => {
  it("welcomes them again when it comes back, since what they hold may be newer than what it saved", async () => {
    const room = freshRoom();
    const stub = env.TICKS.get(env.TICKS.idFromName(room));
    const p1 = await follow<TickState>("/ticks", room, "p1");
    const p2 = await follow<TickState>("/ticks", room, "p2");
    await until(() => p1.tick >= 8 && p2.tick >= 8, "some ticks");

    // A room cannot be taken out of memory while its simulation runs, short of a crash. One whose
    // ticks keep failing pauses, and can be: it is still due to simulate, and its players are
    // still connected, which is how a room looks that went down in the middle of a simulation.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    p1.send({ type: "break" });
    await until(() => p1.state!.broken === true, "the break");
    await quiet(p1); // the simulation has paused
    await evictDurableObject(stub);
    const [seen1, seen2] = [p1.frames.length, p2.frames.length];
    // Nothing runs until something reaches the room. Here it is a command from p2.
    p2.send({ type: "fix" });
    await until(() => p1.of("welcome").length === 2 && p2.of("welcome").length === 2, "the second welcome");
    errors.mockRestore();

    // The welcome comes first, to both, on the connections they had.
    expect(p1.frames[seen1]!.t).toBe("welcome");
    expect(p2.frames[seen2]!.t).toBe("welcome");
    const again = p1.of("welcome")[1]!;
    expect(again.players.map((player) => player.id)).toEqual(["p1", "p2"]);
    expect(again.you).toBe("p1");

    // And the simulation carries on from there, in patches of what the welcome gave them.
    await until(() => p1.state!.broken === false && p2.state!.broken === false, "the fix");
    const from = p1.frames.length;
    await until(() => p1.frames.length >= from + 5, "ticks after the fix");
    expect(p1.frames.slice(seen1 + 1).filter((frame) => frame.t === "state")).toEqual([]);
    const tick = Math.min(p1.tick, p2.tick);
    await until(() => p1.history.has(tick) && p2.history.has(tick));
    expect(p1.history.get(tick)!.count).toBe(p2.history.get(tick)!.count);
  });

  it("does not welcome anyone again when it wakes from sleep", async () => {
    const room = freshRoom();
    const stub = env.TICKS.get(env.TICKS.idFromName(room));
    const p1 = await follow<TickState>("/ticks", room, "p1");
    p1.send({ type: "stop" });
    await until(() => p1.state!.phase === "lobby" && p1.of("ack").length === 1, "the simulation stopped");

    // What hibernation does to a room that is not simulating.
    await evictDurableObject(stub);
    p1.send({ type: "bump" });
    await until(() => p1.state!.bumps === 1, "the bump");
    expect(p1.of("welcome")).toHaveLength(1);
  });
});

describe("a lockstep room that is torn down", () => {
  it("has recorded each join once when it resumes", async () => {
    const room = freshRoom();
    const p1 = await follow<LockstepView<TurnInput>>("/turns", room, "p1");
    await until(() => p1.tick >= 3);

    await abortAllDurableObjects();
    const back = await follow<LockstepView<TurnInput>>("/turns", room, "p1");
    const resumedAt = back.tick;
    await until(() => back.tick >= resumedAt + 5);

    const response = await exports.default.fetch(`https://tickflare.test/turns/${room}/replay?player=p1`);
    const replay = (await response.json()) as Replay<TurnInput>;
    const joins = replay.turns.flatMap(([turn, entries]) =>
      entries.filter((entry) => entry.event === "join").map((entry) => `${turn}:${entry.player}`),
    );
    expect(joins).toHaveLength(1);
  });

  it("has recorded an order once, though the room itself was not saved after it", async () => {
    const room = freshRoom();
    const p1 = await follow<LockstepView<TurnInput>>("/turns", room, "p1");
    await until(() => p1.tick >= 3);
    p1.send({ k: "i", d: { type: "add", n: 7 } });
    await until(() => [...p1.history.values()].some((view) => view.entries.some((entry) => entry.input?.n === 7)), "the order's turn");
    const orderedAt = [...p1.history.values()].find((view) => view.entries.some((entry) => entry.input?.n === 7))!.turn;

    // The turn is in the recording; the room's own row still says what it said when p1 sat down.
    const stub = env.TURNS.get(env.TURNS.idFromName(room));
    await abortAllDurableObjects();
    const stored = await runInDurableObject(stub, (_instance, state) => ({
      saved: (JSON.parse(state.storage.sql.exec<{ state: string }>("SELECT state FROM tickflare_room").one().state) as { turn: number }).turn,
      recorded: state.storage.sql.exec<{ n: number }>("SELECT MAX(n) AS n FROM tickflare_turns").one().n,
    }));
    expect(stored.saved).toBeLessThan(orderedAt);
    expect(stored.recorded).toBe(orderedAt);

    const back = await follow<LockstepView<TurnInput>>("/turns", room, "p1");
    await until(() => back.state!.turn >= orderedAt + 5, "the turns after the order's");

    const response = await exports.default.fetch(`https://tickflare.test/turns/${room}/replay?player=p1`);
    const replay = (await response.json()) as Replay<TurnInput>;
    const all = replay.turns.flatMap(([turn, entries]) => entries.map((entry) => `${turn}:${entry.event ?? `add ${entry.input?.n}`}`));
    expect(all.filter((entry) => entry.endsWith(":join"))).toHaveLength(1);
    expect(all.filter((entry) => entry.endsWith("add 7"))).toEqual([`${orderedAt}:add 7`]);
    // No turn number is used twice: p1 coming back is recorded after the order, not over it.
    const numbers = replay.turns.map(([turn]) => turn);
    expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b));
    expect(Number(all.find((entry) => entry.endsWith(":reconnect"))!.split(":")[0])).toBeGreaterThan(orderedAt);
  });

  it("writes one row for a turn with an order in it, and none for the room", async () => {
    const room = freshRoom();
    const p1 = await follow<LockstepView<TurnInput>>("/turns", room, "p1");
    await until(() => p1.tick >= 3);
    const stub = env.TURNS.get(env.TURNS.idFromName(room));
    const seq = () => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ seq: number }>("SELECT seq FROM tickflare_room").one().seq);
    const before = await seq();
    p1.send({ k: "i", d: { type: "add", n: 1 } });
    await until(() => [...p1.history.values()].some((view) => view.entries.some((entry) => entry.input?.n === 1)), "the order's turn");
    // The room's row has not been written again: its sequence number is the one from before the order.
    expect(await seq()).toBe(before);
  });
});

describe("a room saved before the tick counter moved into its row", () => {
  it("carries on from the counter it had", async () => {
    const room = freshRoom();
    const stub = env.TICKS.get(env.TICKS.idFromName(room));
    const p1 = await follow<TickState>("/ticks", room, "p1");
    await until(() => p1.tick >= 10);
    p1.ws.close(1000, "bye");
    await sleep(250);

    const kept = await runInDurableObject(stub, (_instance, state) => {
      const sql = state.storage.sql;
      const now = {
        column: sql.exec<{ tick: number }>("SELECT tick FROM tickflare_room").one().tick,
        rows: sql.exec("SELECT 1 FROM tickflare_meta WHERE key = 'tick'").toArray().length,
      };
      // Put the room back the way 0.1.0 stored it.
      sql.exec("ALTER TABLE tickflare_room DROP COLUMN tick");
      sql.exec("INSERT OR REPLACE INTO tickflare_meta (key, value) VALUES ('tick', '5000')");
      return now;
    });
    expect(kept.column).toBeGreaterThanOrEqual(10);
    expect(kept.rows).toBe(0);

    await abortAllDurableObjects();
    const back = await follow<TickState>("/ticks", room, "p1");
    expect(back.tick).toBeGreaterThanOrEqual(5000);
  });
});

describe("a room woken by something other than a socket", () => {
  it("arms the alarm for seat timeouts it starts on the way", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, "/away");
    await p1.next("welcome");
    const p2 = await connect(room, "p2", {}, "/away");
    await p2.next("welcome");
    p2.ws.close(1000, "bye");
    await p1.next("state"); // join
    await p1.next("presence");
    await p1.next("state"); // leave:p2
    await p1.next("presence");

    // As after a deploy that dropped p2 without the room seeing the close: a seat with no timeout running.
    const stub = env.AWAY.get(env.AWAY.idFromName(room));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM tickflare_timers");
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);

    // The first thing to reach the room is a plain HTTP request.
    const http = await exports.default.fetch(`https://tickflare.test/away/${room}/scores?player=p1`);
    expect(http.status).toBe(404);
    await http.text();
    await evictDurableObject(stub);

    const armed = await runInDurableObject(stub, async (_instance, state) => ({
      timers: state.storage.sql.exec<{ name: string }>("SELECT name FROM tickflare_timers").toArray().map((t) => t.name),
      alarm: await state.storage.getAlarm(),
    }));
    expect(armed.timers).toEqual(["tickflare:away:p2"]);
    expect(armed.alarm, "a timer is stored but no alarm is set").not.toBeNull();
  });
});

/**
 * A ticking room is a `setInterval` in memory. Cloudflare can take the room
 * out of memory with its players still connected: after 70 to 140 seconds
 * without an event, which keepalives are not, or to move it. Nothing the
 * players send then reaches it until one of them sends a command. These tests
 * check what brings it back without one: the alarm it keeps while it runs.
 */
describe("a ticking room with players connected", () => {
  const ticks = (room: string) => env.TICKS.get(env.TICKS.idFromName(room));
  const alarmOf = (room: string) => runInDurableObject(ticks(room), (_instance, state) => state.storage.getAlarm());

  it("keeps an alarm under thirty seconds ahead while it runs, and none when it stops", async () => {
    const room = freshRoom();
    const p1 = await follow<TickState>("/ticks", room, "p1");
    await until(() => p1.tick >= 3, "a few ticks");
    const alarm = await alarmOf(room);
    expect(alarm).toBeGreaterThan(Date.now());
    expect(alarm).toBeLessThanOrEqual(Date.now() + 30_000);

    // Firing it while the room is in memory is an event like any other: the simulation goes on, and the alarm is set again.
    expect(await runDurableObjectAlarm(ticks(room))).toBe(true);
    const at = p1.tick;
    await until(() => p1.tick >= at + 3, "ticks after the alarm");
    expect(await alarmOf(room)).toBeGreaterThan(Date.now());

    p1.send({ type: "stop" });
    await until(() => p1.state!.phase === "lobby", "the simulation to stop");
    await sleep(50);
    expect(await alarmOf(room)).toBeNull();
  });

  it("resumes when its alarm fires after Cloudflare took it out of memory, and sends everyone the whole view again", async () => {
    const room = freshRoom();
    const stub = ticks(room);
    const p1 = await follow<TickState>("/ticks", room, "p1");
    await until(() => p1.tick >= 5, "a few ticks");

    // A room cannot be taken out of memory here while it ticks. So: stop it, take it out with the player
    // still connected, and leave in storage what a room that was ticking leaves: its state, and its alarm.
    p1.send({ type: "stop" });
    await until(() => p1.state!.phase === "lobby", "the simulation to stop");
    await quiet(p1);
    await evictDurableObject(stub);
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("UPDATE tickflare_room SET state = json_set(state, '$.phase', 'playing')");
      await state.storage.setAlarm(Date.now());
    });
    const welcomes = p1.of("welcome").length;
    const before = p1.tick;

    // Nobody sends anything. The alarm alone brings it back.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await until(() => p1.of("welcome").length === welcomes + 1, "the whole view again");
    expect(p1.state!.phase).toBe("playing");
    await until(() => p1.tick >= before + 5, "ticks again");
    expect(p1.state!.count).toBe(p1.tick);
    expect(await alarmOf(room)).toBeGreaterThan(Date.now());
  });

  it("forgets the alarm earlier versions kept with the timers", async () => {
    const room = freshRoom();
    const stub = ticks(room);
    const p1 = await follow<TickState>("/ticks", room, "p1");
    p1.send({ type: "stop" });
    await until(() => p1.state!.phase === "lobby", "the simulation to stop");
    await quiet(p1);
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO tickflare_timers (name, fire_at) VALUES ('tickflare:awake', ?)", Date.now() - 1000);
    });

    p1.send({ type: "noop" });
    await until(() => p1.of("ack").length >= 1, "the answer");
    const after = await runInDurableObject(stub, async (_instance, state) => ({
      timers: state.storage.sql.exec("SELECT name FROM tickflare_timers").toArray().length,
      alarm: await state.storage.getAlarm(),
    }));
    // Left there, it would have fired again and again: it is in the past, and nothing would clear it.
    expect(after).toEqual({ timers: 0, alarm: null });
  });
});
