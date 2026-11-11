/**
 * Plays items out at a steady pace, however unevenly they arrive.
 *
 * Lockstep turns leave the room at a fixed rate, but a real network delivers
 * them in fits: two together, then a gap. Applying them as they arrive makes
 * the game stutter. The pacer holds a small reserve and releases one item per
 * interval, so the simulation advances evenly. When a hiccup leaves more
 * waiting than the reserve is meant to hold, it plays at double speed until
 * the surplus is gone, instead of keeping it as extra delay for good.
 */
export class TurnPacer<T> {
  readonly #intervalMs: number;
  readonly #reserve: number;
  readonly #play: (item: T) => void;
  #queue: T[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** When the next item is due, in epoch milliseconds. */
  #dueAt = 0;

  /**
   * @param intervalMs time between items at the source
   * @param reserve    how many intervals to hold an item back when starting from empty
   * @param play       called for each item, in order
   */
  constructor(intervalMs: number, reserve: number, play: (item: T) => void) {
    this.#intervalMs = intervalMs;
    this.#reserve = Math.max(0, reserve);
    this.#play = play;
  }

  push(item: T): void {
    if (this.#reserve === 0) {
      // No reserve asked for: pass straight through.
      this.#play(item);
      return;
    }
    this.#queue.push(item);
    if (this.#timer === undefined) {
      // Starting, or ran dry: build the reserve up again before playing.
      this.#dueAt = Date.now() + this.#intervalMs * this.#reserve;
      this.#arm();
    }
  }

  /** Drop everything waiting and stop. */
  clear(): void {
    this.#queue = [];
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #arm(): void {
    this.#timer = setTimeout(() => this.#release(), Math.max(0, this.#dueAt - Date.now()));
  }

  #release(): void {
    this.#timer = undefined;
    const item = this.#queue.shift();
    // Nothing arrived in time: wait for the next push, which rebuilds the reserve.
    if (item === undefined) return;
    this.#play(item);
    // Keep to the clock, not to "now", so timer lateness does not add up.
    const surplus = this.#queue.length > this.#reserve;
    this.#dueAt += surplus ? this.#intervalMs / 2 : this.#intervalMs;
    this.#arm();
  }
}
