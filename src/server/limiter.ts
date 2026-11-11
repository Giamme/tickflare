/**
 * A token bucket per key: it refills at `rate` a second and holds at most
 * one second's worth, so `rate` is both the sustained limit and the largest
 * burst. Kept in memory only: a room that restarts starts everyone afresh.
 */
export class RateLimiter {
  #buckets = new Map<string, { left: number; at: number }>();

  /** Take one from `key`'s bucket. False when it is empty. An infinite rate always passes. */
  spend(key: string, rate: number): boolean {
    if (!Number.isFinite(rate)) return true;
    const now = Date.now();
    const bucket = this.#buckets.get(key) ?? { left: rate, at: now };
    bucket.left = Math.min(rate, bucket.left + ((now - bucket.at) / 1000) * rate);
    bucket.at = now;
    this.#buckets.set(key, bucket);
    if (bucket.left < 1) return false;
    bucket.left -= 1;
    return true;
  }

  forget(key: string): void {
    this.#buckets.delete(key);
  }
}
