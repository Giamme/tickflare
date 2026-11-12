import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LockstepView, Replay } from "../src/lockstep.js";
import { connect, follow, freshRoom, sleep, until } from "./helpers.js";
import type { TickState, TurnInput } from "./worker.js";

/**
 * What a deploy or a crash leaves behind is whatever is in storage. These
 * tests tear rooms down without warning and look at what they resume from.
 */
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
