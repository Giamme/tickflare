/**
 * Keeps an estimate of which tick a room is on, from the clock readings the
 * room sends and the round trip to it.
 *
 * A reading says that tick `tick` fell due `ms` milliseconds before the
 * frame was sent. The frame took about half a round trip to arrive, so on
 * this machine `tick` fell due `ms + rtt / 2` before it arrived, and the room
 * has gone on at `tickRate` ticks a second since. Readings of one epoch are
 * averaged, so that one frame held up on the way moves the estimate only a
 * little; a new epoch replaces the estimate.
 */
export class ServerClock {
  #tickRate = 0;
  #epoch: number | undefined;
  /** The local time (`performance.now()`) at which `#base` fell due, before half the round trip is added. */
  #baseAt: number | undefined;
  #base = 0;
  /** The tick the simulation stopped at, while it is stopped. */
  #stopped: number | undefined;
  #rtt: number | undefined;

  /** How much of a new reading's difference from the estimate is taken in: the rest is the estimate's. */
  static readonly SMOOTHING = 0.25;

  /** The smoothed round trip to the room, in milliseconds. Undefined until one has been measured. */
  get rtt(): number | undefined {
    return this.#rtt;
  }

  /** A round trip took `ms` milliseconds. Averaged with the earlier ones as TCP does: each new one counts for an eighth. */
  roundTrip(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    this.#rtt = this.#rtt === undefined ? ms : this.#rtt + (ms - this.#rtt) / 8;
  }

  /**
   * The room said where its clock is, in a frame that arrived at `now`
   * (local, from `performance.now()`). With `ms` absent the simulation has
   * stopped at `tick`.
   */
  reading(tick: number, tickRate: number, ms: number | undefined, epoch: number | undefined, now = localNow()): void {
    if (ms === undefined || !(tickRate > 0)) {
      this.#stopped = tick;
      this.#baseAt = undefined;
      this.#epoch = undefined;
      return;
    }
    this.#stopped = undefined;
    const at = now - ms;
    if (this.#baseAt === undefined || epoch !== this.#epoch || tickRate !== this.#tickRate) {
      this.#tickRate = tickRate;
      this.#epoch = epoch;
      this.#base = tick;
      this.#baseAt = at;
      return;
    }
    // When `tick` fell due by the estimate so far, then a step towards the new reading.
    const expected = this.#baseAt + ((tick - this.#base) * 1000) / tickRate;
    this.#base = tick;
    this.#baseAt = expected + (at - expected) * ServerClock.SMOOTHING;
  }

  /** Forget the clock, keeping the round trip: the connection was lost, or the room told nothing yet. */
  reset(): void {
    this.#baseAt = undefined;
    this.#epoch = undefined;
    this.#stopped = undefined;
  }

  /**
   * The tick the room is on at `now` (local, from `performance.now()`), with
   * the fraction of the next that has passed. The tick it stopped at while
   * its simulation is stopped, and undefined when there is nothing to go on.
   */
  tick(now = localNow()): number | undefined {
    if (this.#stopped !== undefined) return this.#stopped;
    if (this.#baseAt === undefined) return undefined;
    const since = now - this.#baseAt + (this.#rtt ?? 0) / 2;
    return this.#base + (since * this.#tickRate) / 1000;
  }
}

/** A clock that only goes forward, in milliseconds. */
export function localNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
