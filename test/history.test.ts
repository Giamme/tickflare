import { describe, expect, it } from "vitest";
import { follow, freshRoom, until } from "./helpers.js";
import type { HistoryState } from "./worker.js";

/**
 * `historyTicks` and `stateAt`: a ticking room that keeps the state of its
 * last ticks, to judge a command by what its player was looking at. The
 * fixture ticks fifty times a second and keeps ten ticks; its runner is at
 * `x`, one further with every tick, so in a new room `x` is the tick.
 */
const join = (room: string) => follow<HistoryState>("/history", room, "p1");

describe("a room that keeps the state of its last ticks", () => {
  it("judges a command by the state of the tick its player saw", async () => {
    const p1 = await join(freshRoom());
    await until(() => p1.tick >= 5);
    // What the player sees now, and aims at.
    const seen = { tick: p1.tick, x: p1.state!.x };
    expect(seen.x).toBe(seen.tick);
    // The room has moved on by the time the shot is there.
    await until(() => p1.tick >= seen.tick + 2);
    p1.send({ type: "shoot", tick: seen.tick, x: seen.x });
    await until(() => p1.state!.shots.length === 1);

    const shot = p1.state!.shots[0]!;
    expect(shot).toMatchObject({ tick: seen.tick, was: seen.x, hit: true });
    expect(shot.now).toBeGreaterThanOrEqual(seen.x + 2);
  });

  it("takes a tick with a fraction for the nearest whole one", async () => {
    const p1 = await join(freshRoom());
    await until(() => p1.tick >= 6);
    const tick = p1.tick - 1;
    p1.send({ type: "shoot", tick: tick + 0.4, x: tick });
    p1.send({ type: "shoot", tick: tick + 0.6, x: tick + 1 });
    await until(() => p1.state!.shots.length === 2);
    expect(p1.state!.shots.map((shot) => shot.was)).toEqual([tick, tick + 1]);
  });

  it("keeps as many ticks as it is asked to, the latest among them, and nothing of the tick to come", async () => {
    const p1 = await join(freshRoom());
    await until(() => p1.tick >= 14);
    p1.send({ type: "span" });
    await until(() => p1.state!.spans.length === 1);
    const span = p1.state!.spans[0]!;
    // The tick to come, the latest, and those nine, ten, three and two before it.
    expect(span.has).toEqual([false, true, true, false, true, true]);
    expect(span.latest).toBe(span.tick);

    // Three ticks are the latest and the two before it.
    const short = await join(`short-${freshRoom()}`);
    await until(() => short.tick >= 14);
    short.send({ type: "span" });
    await until(() => short.state!.spans.length === 1);
    expect(short.state!.spans[0]!.has).toEqual([false, true, false, false, false, true]);
  });

  it("keeps none unless asked to", async () => {
    const p1 = await join(`none-${freshRoom()}`);
    await until(() => p1.tick >= 5);
    p1.send({ type: "span" });
    p1.send({ type: "shoot", tick: p1.tick, x: p1.state!.x });
    await until(() => p1.state!.shots.length === 1);
    expect(p1.state!.spans[0]).toMatchObject({ has: [false, false, false, false, false, false], latest: null });
    expect(p1.state!.shots[0]).toMatchObject({ was: null, hit: false });
  });

  it("has nothing for a tick it no longer keeps", async () => {
    const p1 = await join(freshRoom());
    await until(() => p1.tick >= 16);
    p1.send({ type: "shoot", tick: 2, x: 2 });
    p1.send({ type: "shoot", tick: p1.tick + 500, x: 0 });
    await until(() => p1.state!.shots.length === 2);
    expect(p1.state!.shots.map((shot) => shot.was)).toEqual([null, null]);
  });

  it("hands out a copy: changing it changes neither the room nor what the next look finds", async () => {
    const p1 = await join(freshRoom());
    await until(() => p1.tick >= 5);
    const tick = p1.tick;
    p1.send({ type: "scribble", tick });
    p1.send({ type: "shoot", tick, x: tick });
    await until(() => p1.state!.shots.length === 1);
    expect(p1.state!.shots[0]).toMatchObject({ was: tick, hit: true });
    expect(p1.state!.x).toBeGreaterThanOrEqual(tick);
  });

  it("has nothing to look back at while the simulation is stopped, and has again once it runs", async () => {
    const p1 = await join(freshRoom());
    await until(() => p1.tick >= 5);
    p1.send({ type: "play", on: false });
    await until(() => p1.state!.playing === false);
    // Stopped, the players see every change as it is made, and `this.state` is what they see.
    p1.send({ type: "span" });
    await until(() => p1.state!.spans.length === 1);
    const stopped = p1.state!.spans[0]!;
    expect(stopped).toMatchObject({ has: [false, false, false, false, false, false], latest: null });

    p1.send({ type: "play", on: true });
    await until(() => p1.tick >= stopped.tick + 2);
    p1.send({ type: "span" });
    await until(() => p1.state!.spans.length === 2);
    const running = p1.state!.spans[1]!;
    expect(running.has[1]).toBe(true);
    expect(running.latest).toBe(running.tick);
    // Nothing of before the stop: the ticks since are all there is.
    expect(running.has[3]).toBe(false);
  });
});
