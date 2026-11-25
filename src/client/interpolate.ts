/**
 * Smooths values that arrive once per patch, for drawing between patches.
 *
 * State sync delivers positions 10 to 30 times a second; a screen draws 60
 * or more. Each time a new value arrives for an id, the interpolator glides
 * to it from wherever that id was being drawn, over `durationMs` (the time
 * between two patches is the usual choice). Because it always starts from
 * what is on screen, a late or bunched update bends the motion instead of
 * making it jump.
 *
 *     const glide = new Interpolator(1000 / client.patchRate, ["x", "y"]);
 *     onState: (state) => glide.update(state.units),
 *     // in the render loop:
 *     const { x, y } = glide.at(id) ?? state.units[id];
 */
export class Interpolator<Field extends string> {
  readonly #durationMs: number;
  readonly #fields: readonly Field[];
  #tracks = new Map<string, { from: Record<Field, number>; to: Record<Field, number>; since: number }>();

  /**
   * @param durationMs how long a glide takes, usually the time between ticks
   * @param fields     the numeric fields to smooth, e.g. `["x", "y"]`
   */
  constructor(durationMs: number, fields: readonly Field[]) {
    this.#durationMs = Math.max(1, durationMs);
    this.#fields = fields;
  }

  /**
   * Feed the latest values, keyed by id. Ids missing from `targets` are
   * forgotten; new ones start at their target.
   */
  update(targets: Record<string, Record<Field, number>>, now = performance.now()): void {
    const tracks = new Map<string, { from: Record<Field, number>; to: Record<Field, number>; since: number }>();
    for (const id of Object.keys(targets)) {
      const target = targets[id]!;
      const to = {} as Record<Field, number>;
      for (const field of this.#fields) to[field] = target[field];
      tracks.set(id, { from: this.at(id, now) ?? to, to, since: now });
    }
    this.#tracks = tracks;
  }

  /** The values to draw for `id` right now, or undefined if it is not known. */
  at(id: string, now = performance.now()): Record<Field, number> | undefined {
    const track = this.#tracks.get(id);
    if (!track) return undefined;
    const t = Math.min(1, Math.max(0, (now - track.since) / this.#durationMs));
    const shown = {} as Record<Field, number>;
    for (const field of this.#fields) {
      shown[field] = track.from[field] + (track.to[field] - track.from[field]) * t;
    }
    return shown;
  }

  /** Forget everything, e.g. after moving to another room. */
  clear(): void {
    this.#tracks.clear();
  }
}
