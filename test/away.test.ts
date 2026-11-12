import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LockstepView } from "../src/lockstep.js";
import { connect, follow, freshRoom, sleep, until } from "./helpers.js";

/** Two players seated in a room whose seats time out after 150 ms away. */
async function pair(room = freshRoom()) {
  const p1 = await connect(room, "p1", {}, "/away");
  await p1.next("welcome");
  const p2 = await connect(room, "p2", {}, "/away");
  await p2.next("welcome");
  await p1.next("state");
  await p1.next("presence");
  return { room, p1, p2 };
}

describe("seatTimeoutMs", () => {
  it("gives up the seat of a player who stays away, through onLeave", async () => {
    const { room, p1, p2 } = await pair();
    p2.ws.close(1000, "bye");
    expect((await p1.next("state")).state.log).toContain("leave:p2");
    expect((await p1.next("presence")).players[1]).toEqual({ id: "p2", connected: false });

    // 150 ms later the seat is gone, and onLeave has run.
    expect((await p1.next("state")).state.log.slice(-1)).toEqual(["left:p2"]);
    expect((await p1.next("presence")).players).toEqual([{ id: "p1", connected: true }]);

    // Coming back after that is a new join.
    const back = await connect(room, "p2", {}, "/away");
    expect((await back.next("welcome")).state.log.slice(-1)).toEqual(["join:p2"]);
  });

  it("is called off when the player comes back in time", async () => {
    const { room, p1, p2 } = await pair();
    p2.ws.close(1000, "bye");
    await sleep(50);
    const back = await connect(room, "p2", {}, "/away");
    const welcome = await back.next("welcome");
    await sleep(250);

    back.command({ type: "noop" });
    await back.next("ack");
    expect(welcome.state.log).toContain("back:p2");
    p1.command({ type: "add", n: 1 });
    const log = (await back.next("state")).state.log;
    expect(log).not.toContain("left:p2");
  });

  it("leaves the player seated when onLeave refuses", async () => {
    const { room, p1, p2 } = await pair();
    p1.command({ type: "lock" });
    await p2.next("state");
    p2.ws.close(1000, "bye");
    await sleep(350);

    const back = await connect(room, "p2", {}, "/away");
    const welcome = await back.next("welcome");
    expect(welcome.state.log).toContain("back:p2");
    expect(welcome.state.log).not.toContain("left:p2");
  });

  it("tells the remaining players in order: the drop, then the seat given up", async () => {
    const { p1, p2 } = await pair();
    p2.ws.close(1000, "bye");
    await sleep(300);
    p1.command({ type: "noop" });
    const frames = [await p1.any(), await p1.any(), await p1.any(), await p1.any(), await p1.any()];
    expect(frames.map((f) => f.t)).toEqual(["state", "presence", "state", "presence", "ack"]);
  });

  it("starts the clock for seats that were left without one", async () => {
    const { room, p1, p2 } = await pair();
    p2.ws.close(1000, "bye");
    await p1.next("state");
    await p1.next("presence");

    // As if the room had been running without a seat timeout when p2 dropped.
    const stub = env.AWAY.get(env.AWAY.idFromName(room));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM tickflare_timers");
      await state.storage.deleteAlarm();
    });
    await evictDurableObject(stub);

    // Any event wakes the room; it notices the unattended seat and starts its timeout.
    p1.command({ type: "noop" });
    await p1.next("ack");
    expect((await p1.next("state")).state.log.slice(-1)).toEqual(["left:p2"]);
  });
});

describe("lockstep seats", () => {
  it("announces a seat that timed out to every simulation", async () => {
    const room = freshRoom();
    const p1 = await follow<LockstepView>("/turns", room, "p1");
    const p2 = await follow<LockstepView>("/turns", room, "p2");
    await until(() => p1.tick >= 2);
    p2.ws.close(1000, "bye");

    const stream = () => [...p1.history.values()].flatMap((view) => view.entries.map((e) => `${e.player}:${e.event}`));
    await until(() => stream().includes("p2:leave"), "the leave");
    expect(stream()).toEqual(["p1:join", "p2:join", "p2:disconnect", "p2:leave"]);
  });
});
