import { describe, expect, it } from "vitest";
import { ServerClock } from "../src/client/index.js";

describe("ServerClock", () => {
  it("knows nothing until the room says where its clock is", () => {
    expect(new ServerClock().tick(1000)).toBeUndefined();
  });

  it("counts on from a reading at the tick rate, half a round trip ahead", () => {
    const clock = new ServerClock();
    // Tick 100 fell due 10 ms before the frame was sent; it arrived at 1000 on this machine.
    clock.reading(100, 20, 10, 1, 1000);
    expect(clock.tick(1000)).toBeCloseTo(100.2);
    expect(clock.tick(1040)).toBeCloseTo(101);
    clock.roundTrip(100);
    // The frame was 50 ms on its way, so the room is a tick further on than it looked.
    expect(clock.tick(1040)).toBeCloseTo(102);
  });

  it("smooths the round trip as TCP does", () => {
    const clock = new ServerClock();
    expect(clock.rtt).toBeUndefined();
    clock.roundTrip(80);
    expect(clock.rtt).toBe(80);
    clock.roundTrip(160);
    expect(clock.rtt).toBe(90);
    clock.roundTrip(-1);
    expect(clock.rtt).toBe(90);
  });

  it("takes in only part of a reading that disagrees, while the epoch stays the same", () => {
    const clock = new ServerClock();
    clock.reading(0, 10, 0, 1, 0);
    // Tick 50 is due at 5000. This reading arrived 40 ms late: held up on the way.
    clock.reading(50, 10, 0, 1, 5040);
    expect(clock.tick(5040)).toBeCloseTo(50 + 0.4 * (1 - ServerClock.SMOOTHING));
    // It now has tick 100 due 10 ms late. A reading on time pulls it a quarter of the way back.
    expect(clock.tick(10_000)).toBeCloseTo(99.9);
    clock.reading(100, 10, 0, 1, 10_000);
    expect(clock.tick(10_000)).toBeCloseTo(100 - 0.1 * (1 - ServerClock.SMOOTHING));
  });

  it("starts over from a reading of a new epoch, and stands still while the simulation is stopped", () => {
    const clock = new ServerClock();
    clock.reading(0, 10, 0, 1, 0);
    clock.reading(80, 10, 0, 2, 5000);
    expect(clock.tick(5000)).toBe(80);
    clock.reading(85, 10, undefined, undefined, 5500);
    expect(clock.tick(9000)).toBe(85);
    clock.reading(85, 10, 0, 3, 9000);
    expect(clock.tick(9100)).toBeCloseTo(86);
    clock.reset();
    expect(clock.tick(9100)).toBeUndefined();
  });
});
