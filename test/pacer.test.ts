import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnPacer } from "../src/client/pacer.js";

describe("TurnPacer", () => {
  let played: { item: number; at: number }[];
  let start: number;
  const pacer = (reserve = 1) =>
    new TurnPacer<number>(100, reserve, (item) => played.push({ item, at: Date.now() - start }));
  /** Push items at the given times (ms from the start), then let everything play out. */
  async function arrivals(target: TurnPacer<number>, times: number[]) {
    times.forEach((at, item) => setTimeout(() => target.push(item), at));
    await vi.advanceTimersByTimeAsync(Math.max(...times) + 1000);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    start = Date.now();
    played = [];
  });
  afterEach(() => vi.useRealTimers());

  it("plays evenly spaced arrivals one interval late, in order", async () => {
    await arrivals(pacer(), [0, 100, 200, 300]);
    expect(played).toEqual([
      { item: 0, at: 100 },
      { item: 1, at: 200 },
      { item: 2, at: 300 },
      { item: 3, at: 400 },
    ]);
  });

  it("evens out arrivals that come early, late and bunched together", async () => {
    // Sent every 100 ms, delivered with up to 90 ms of jitter.
    await arrivals(pacer(), [0, 190, 195, 310, 480, 500, 505, 690]);
    expect(played.map((p) => p.at)).toEqual([100, 200, 300, 400, 500, 600, 700, 800]);
    expect(played.map((p) => p.item)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("rebuilds its reserve after running dry, then works the delay off again", async () => {
    // A 400 ms stall, after which the held-up turns arrive at once.
    await arrivals(pacer(), [0, 100, 600, 600, 600, 600, 600, 700, 800]);
    const times = played.map((p) => p.at);
    expect(times.slice(0, 2)).toEqual([100, 200]);
    // Starts again one interval after the stall ends, at double speed while there is a surplus...
    expect(times.slice(2, 6)).toEqual([700, 750, 800, 850]);
    // ...and back at the normal pace once it is gone.
    expect(times[8]! - times[7]!).toBe(100);
    expect(played.map((p) => p.item)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("applies items as they arrive when there is no reserve", async () => {
    await arrivals(pacer(0), [0, 130, 260]);
    expect(played.map((p) => p.at)).toEqual([0, 130, 260]);
  });

  it("drops what is waiting when cleared", async () => {
    const target = pacer();
    target.push(1);
    target.push(2);
    target.clear();
    await vi.advanceTimersByTimeAsync(1000);
    expect(played).toEqual([]);

    target.push(3);
    await vi.advanceTimersByTimeAsync(1000);
    expect(played.map((p) => p.item)).toEqual([3]);
  });
});
