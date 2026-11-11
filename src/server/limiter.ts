/** How often idle buckets are cleared out. */
const SWEEP_MS = 10_000;

/**
 * A token bucket per key: it refills at `rate` a second and holds at most
 * one second's worth (never less than one), so `rate` is both the sustained
 * limit and the largest burst. A bucket belongs to the key, not to a
 * connection: dropping and reconnecting does not refill it. Kept in memory
 * only: a room that restarts starts everyone afresh.
 */
export class RateLimiter {
  #buckets = new Map<string, { left: number; at: number }>();
  #sweptAt = 0;

  /** Take one from `key`'s bucket. False when it is empty. An infinite rate always passes. */
  spend(key: string, rate: number): boolean {
    if (rate === Number.POSITIVE_INFINITY) return true;
    if (!(rate > 0)) return false;
    // A rate below one a second still lets single frames through, just further apart.
    const size = Math.max(1, rate);
    const now = Date.now();
    if (now - this.#sweptAt >= SWEEP_MS) this.#sweep(now, rate, size);

    const bucket = this.#buckets.get(key) ?? { left: size, at: now };
    bucket.left = Math.min(size, bucket.left + ((now - bucket.at) / 1000) * rate);
    bucket.at = now;
    this.#buckets.set(key, bucket);
    if (bucket.left < 1) return false;
    bucket.left -= 1;
    return true;
  }

  /** Forgets the keys that have been quiet for long enough to be full again. */
  #sweep(now: number, rate: number, size: number): void {
    this.#sweptAt = now;
    const refillMs = (size / rate) * 1000;
    for (const [key, bucket] of this.#buckets) {
      if (now - bucket.at >= refillMs) this.#buckets.delete(key);
    }
  }
}
