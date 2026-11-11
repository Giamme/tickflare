import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { sleep, twoPlayers } from "./helpers.js";

const stubFor = (room: string) => env.ROOMS.get(env.ROOMS.idFromName(room));

describe("timers", () => {
  it("runs onTimer when the time is up and tells everyone", async () => {
    const { p1, p2 } = await twoPlayers();
    const id = p1.command({ type: "timer", name: "turn", ms: 30 });
    // Setting a timer is not a state change: no state frame, same seq.
    expect(await p1.next("ack")).toEqual({ t: "ack", id, seq: 2 });

    expect(await p1.next("state")).toMatchObject({ seq: 3, state: { log: ["join:p1", "join:p2", "timer:turn"] } });
    expect((await p2.next("state")).state.log).toContain("timer:turn");
  });

  it("fires each timer once, in time order", async () => {
    const { p1 } = await twoPlayers();
    p1.command({ type: "timer", name: "late", ms: 80 });
    await p1.next("ack");
    p1.command({ type: "timer", name: "early", ms: 20 });
    await p1.next("ack");

    await p1.next("state");
    expect((await p1.next("state")).state.log.slice(2)).toEqual(["timer:early", "timer:late"]);
  });

  it("replaces a timer that is set again under the same name", async () => {
    const { p1 } = await twoPlayers();
    p1.command({ type: "timer", name: "turn", ms: 60_000 });
    await p1.next("ack");
    p1.command({ type: "timer", name: "turn", ms: 20 });
    await p1.next("ack");

    expect((await p1.next("state")).state.log.slice(2)).toEqual(["timer:turn"]);
  });

  it("does not fire a timer that was cleared", async () => {
    const { p1 } = await twoPlayers();
    p1.command({ type: "timer", name: "turn", ms: 40 });
    await p1.next("ack");
    p1.command({ type: "cancel", name: "turn" });
    await p1.next("ack");
    await sleep(150);

    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.log).toEqual(["join:p1", "join:p2"]);
  });

  it("forgets a timer set by a hook that then rejects", async () => {
    const { p1 } = await twoPlayers();
    p1.command({ type: "timerThenReject", name: "turn", ms: 20 });
    await p1.next("reject");
    await sleep(150);

    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.log).toEqual(["join:p1", "join:p2"]);
  });

  it("lets onTimer set the next timer", async () => {
    const { p1 } = await twoPlayers();
    p1.command({ type: "timer", name: "relay", ms: 20 });
    await p1.next("ack");

    await p1.next("state");
    expect((await p1.next("state")).state.log.slice(2)).toEqual(["timer:relay", "timer:relayed"]);
  });

  it("spends a timer whose hook throws, instead of firing it again", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { p1 } = await twoPlayers();
    p1.command({ type: "timer", name: "boom", ms: 20 });
    await p1.next("ack");
    await sleep(250);

    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
    // The hook's half-made change was rolled back, and later timers still work.
    p1.command({ type: "timer", name: "after", ms: 20 });
    await p1.next("ack");
    expect((await p1.next("state")).state.log.slice(2)).toEqual(["timer:after"]);
  });

  it("wakes an evicted room, with the timer and the sockets intact", async () => {
    const { room, p1, p2 } = await twoPlayers();
    p1.command({ type: "timer", name: "turn", ms: 300 });
    await p1.next("ack");

    await evictDurableObject(stubFor(room));

    expect((await p1.next("state")).state.log).toContain("timer:turn");
    expect((await p2.next("state")).state.log).toContain("timer:turn");
  });

  it("fires the earliest timer when the alarm is run by hand in a test", async () => {
    const { room, p1 } = await twoPlayers();
    p1.command({ type: "timer", name: "far", ms: 60_000 });
    await p1.next("ack");

    expect(await runDurableObjectAlarm(stubFor(room))).toBe(true);
    expect((await p1.next("state")).state.log).toContain("timer:far");
    // Nothing is left to fire.
    expect(await runDurableObjectAlarm(stubFor(room))).toBe(false);
  });
});
