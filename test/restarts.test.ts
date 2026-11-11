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
      entries.filter((entry) => entry.e === "join").map((entry) => `${turn}:${entry.p}`),
    );
    expect(joins).toHaveLength(1);
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
