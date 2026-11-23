import { describe, expect, it } from "vitest";
import { BufferedInterpolator, type TickSource } from "../src/client/index.js";

/** A room at 10 ticks a second whose clock the test sets: tick `n` is due at `n * 100` ms. */
function room(rate = 10): TickSource & { tick: number; offset: number | undefined; stopped?: number } {
  const source = {
    tick: 0,
    tickRate: rate,
    /** Undefined: the room does not say where its clock is. */
    offset: 0 as number | undefined,
    stopped: undefined as number | undefined,
    serverTick(now = 0) {
      if (source.stopped !== undefined) return source.stopped;
      return source.offset === undefined ? undefined : (now * rate) / 1000 + source.offset;
    },
  };
  return source;
}

/** Feeds tick `tick` with `x` for "a", arriving `late` ms after it was due. */
function feed(glide: BufferedInterpolator<"x">, source: { tick: number }, tick: number, x: number, late = 0) {
  source.tick = tick;
  glide.update({ a: { x } }, tick, tick * 100 + late);
}

describe("BufferedInterpolator", () => {
  it("draws a moment two ticks behind the newest state, at the room's pace", () => {
    const source = room();
    const glide = new BufferedInterpolator(source, ["x"]);
    for (let tick = 1; tick <= 5; tick++) feed(glide, source, tick, tick * 10);
    // At 500 ms the room is on tick 5; the states arrived on time, so it draws tick 3.
    expect(glide.delay).toBeCloseTo(2);
    expect(glide.at("a", 500)!.x).toBeCloseTo(30);
    expect(glide.at("a", 550)!.x).toBeCloseTo(35);
  });

  it("keeps an even pace when patches arrive bunched", () => {
    const source = room();
    const glide = new BufferedInterpolator(source, ["x"]);
    for (let tick = 1; tick <= 4; tick++) feed(glide, source, tick, tick * 10);
    // Ticks 5 and 6 arrive together, late; drawing goes on at one tick per 100 ms all the same.
    feed(glide, source, 5, 50, 100);
    feed(glide, source, 6, 60, 0);
    const delay = glide.delay;
    const shown = [600, 650, 700].map((now) => glide.at("a", now)!.x);
    expect(shown[1]! - shown[0]!).toBeCloseTo(5);
    expect(shown[2]! - shown[1]!).toBeCloseTo(5);
    // And the jitter it saw makes it hold back a little more.
    expect(delay).toBeGreaterThan(2);
  });

  it("carries a thing on at its last speed when updates stop, for a few ticks, then holds it", () => {
    const source = room();
    const glide = new BufferedInterpolator(source, ["x"], { maxExtrapolationTicks: 2 });
    for (let tick = 1; tick <= 5; tick++) feed(glide, source, tick, tick * 10);
    // Nothing more arrives. Tick 5 is drawn at 700 ms; past it the dot goes on for two ticks.
    expect(glide.at("a", 700)!.x).toBeCloseTo(50);
    expect(glide.at("a", 800)!.x).toBeCloseTo(60);
    expect(glide.at("a", 900)!.x).toBeCloseTo(70);
    expect(glide.at("a", 1500)!.x).toBeCloseTo(70);
  });

  it("draws a jump as one when its tick comes, whether marked or too far", () => {
    const source = room();
    const marked = new BufferedInterpolator(source, ["x"]);
    const far = new BufferedInterpolator(source, ["x"], { snapDistance: 50 });
    for (const glide of [marked, far]) {
      for (let tick = 1; tick <= 3; tick++) feed(glide, source, tick, tick * 10);
      feed(glide, source, 4, 500);
    }
    marked.snap("a");
    for (const glide of [marked, far]) {
      // Tick 3 is drawn at 500 ms; up to tick 4 it stays where it was, then it is there.
      expect(glide.at("a", 550)!.x).toBe(30);
      expect(glide.at("a", 600)!.x).toBe(500);
      // And it is not carried on at the speed of the jump.
      expect(glide.at("a", 700)!.x).toBe(500);
    }
  });

  it("goes the short way round for angles", () => {
    const source = room();
    const glide = new BufferedInterpolator(source, ["a"], { angles: ["a"] });
    source.tick = 1;
    glide.update({ s: { a: 3 } }, 1, 100);
    glide.update({ s: { a: -3 } }, 2, 200);
    const halfway = glide.at("s", 350)!.a;
    expect(Math.abs(halfway)).toBeCloseTo(Math.PI);
  });

  it("goes back to the latest state once the room's simulation stops", () => {
    const source = room();
    const glide = new BufferedInterpolator(source, ["x"]);
    for (let tick = 1; tick <= 5; tick++) feed(glide, source, tick, tick * 10);
    source.stopped = 5;
    expect(glide.at("a", 510)!.x).toBe(50);
  });

  it("times the patches as they arrive when the room does not say where its clock is", () => {
    const source = room();
    source.offset = undefined;
    const glide = new BufferedInterpolator(source, ["x"]);
    for (let tick = 1; tick <= 5; tick++) feed(glide, source, tick, tick * 10, 30);
    // Arrivals 30 ms after each tick: the latest is tick 5 at 530 ms, and it draws two behind.
    expect(glide.at("a", 530)!.x).toBeCloseTo(30);
    expect(glide.at("a", 580)!.x).toBeCloseTo(35);
  });

  it("forgets ids that are gone, and starts over when the room goes back to a save", () => {
    const source = room();
    const glide = new BufferedInterpolator(source, ["x"]);
    for (let tick = 1; tick <= 5; tick++) feed(glide, source, tick, tick * 10);
    glide.update({ b: { x: 1 } }, 6, 600);
    expect(glide.at("a", 600)).toBeUndefined();
    glide.update({ b: { x: 7 } }, 2, 650);
    expect(glide.at("b", 650)).toEqual({ x: 7 });
    glide.clear();
    expect(glide.at("b", 650)).toBeUndefined();
  });
});
