import { ServerClock, localNow } from "./clock.js";

/** What `BufferedInterpolator` reads the ticks from: a `RoomClient` will do. */
export interface TickSource {
  /** The tick of the latest state: read when `update` is called. */
  readonly tick: number;
  /** Ticks a second; 0 in event mode. */
  readonly tickRate: number;
  /** Patches a second, when the room sends less often than it ticks: `RoomClient.patchRate`. */
  readonly patchRate?: number;
  /** The tick the room is on at `now`, by estimate, as `RoomClient.serverTick` gives it. */
  serverTick?(now?: number): number | undefined;
}

/** Settings for `BufferedInterpolator`. */
export interface BufferedInterpolatorOptions<Field extends string> {
  /**
   * How far behind the newest state it expects to have, in ticks, before the
   * margin for jitter is added. By default one tick more than there are
   * between two patches, so that there are always two to draw between: 2
   * for a room that sends after every tick, where a patch can then be a tick
   * late or cover two ticks without anything having to be guessed, and 4
   * for one that ticks 60 times a second and sends 20 times.
   */
  delayTicks?: number;
  /**
   * For how many ticks a thing keeps moving at its last speed when no newer
   * state has arrived for it, before it stops where it got to. By default
   * two ticks more than there are between two patches, which is 3 for a
   * room that sends after every tick; 0 stops it at its last known place.
   */
  maxExtrapolationTicks?: number;
  /**
   * A change between two states in a row farther than this, measured over
   * the fields that are not angles, is a jump: drawn as one, when the time
   * comes, instead of a slide. Off by default. Set it above the farthest
   * anything moves between two patches.
   */
  snapDistance?: number;
  /** Fields that are angles in radians, which go the short way round through ±π. */
  angles?: readonly Field[];
}

interface Snapshot<Field extends string> {
  tick: number;
  values: Record<Field, number>;
  /** It was a jump from the one before. */
  snap: boolean;
}

/** Snapshots kept per id at the most, whatever the delay. */
const MAX_SNAPSHOTS = 64;

/**
 * Smooths values that arrive once per tick by drawing them a little in the
 * past, at an even pace, from the ticks they belong to.
 *
 * `Interpolator` glides to each new value as it arrives: it adds almost no
 * delay, but things speed up when two patches arrive together and stop when
 * one is late. This one keeps the last few states of each id, keyed by the
 * room's tick, and draws the moment `delay` ticks behind the tick the room
 * is on (`RoomClient.serverTick()`), blending the states on either side.
 * Motion then keeps the pace of the room, whatever the network does to the
 * patches, at the cost of the delay: two ticks and a margin for the jitter
 * it measures, which it keeps adjusting. Against a room that sends less
 * often than it ticks (`patchRate`), the two ticks become one more than
 * there are between two patches.
 *
 * When the newest state is older than the moment it draws, it carries each
 * thing on at its last speed for up to `maxExtrapolationTicks`, then holds
 * it. A jump, such as a respawn, is drawn as one: say so with `snap(id)`, or
 * set `snapDistance`.
 *
 *     const glide = new BufferedInterpolator(room, ["x", "y"], { snapDistance: 200 });
 *     room.on("state", (state) => glide.update(state.units));
 *     // in the render loop:
 *     const { x, y } = glide.at(id) ?? state.units[id];
 *
 * Against a room older than 0.2, which does not say where its clock is, it
 * times the patches as they arrive instead.
 */
export class BufferedInterpolator<Field extends string> {
  readonly #source: TickSource;
  readonly #fields: readonly Field[];
  readonly #angles: ReadonlySet<Field>;
  readonly #delayTicks: number | undefined;
  readonly #maxExtrapolation: number | undefined;
  readonly #snapDistance: number;
  #tracks = new Map<string, Snapshot<Field>[]>();
  /** Times the patches as they arrive, for a room that does not say where its clock is. */
  #arrivals = new ServerClock();
  /** How many ticks behind the room's clock a state arrives, smoothed, and how much that varies. */
  #lateness: number | undefined;
  #jitter = 0;
  #newestTick = -Infinity;
  /** The latest moment drawn, and when it was asked for: what is drawn never goes back. */
  #shown: { tick: number; now: number } | undefined;

  /**
   * @param source  where the ticks come from: the `RoomClient`
   * @param fields  the numeric fields to smooth, e.g. `["x", "y"]`
   * @param options see `BufferedInterpolatorOptions`
   */
  constructor(source: TickSource, fields: readonly Field[], options: BufferedInterpolatorOptions<Field> = {}) {
    this.#source = source;
    this.#fields = fields;
    this.#angles = new Set(options.angles ?? []);
    this.#delayTicks = options.delayTicks === undefined ? undefined : Math.max(0, options.delayTicks);
    this.#maxExtrapolation = options.maxExtrapolationTicks === undefined ? undefined : Math.max(0, options.maxExtrapolationTicks);
    this.#snapDistance = options.snapDistance ?? Infinity;
  }

  /** The delay it draws at right now, in ticks behind the room's clock: see the class. */
  get delay(): number {
    return (this.#lateness ?? 0) + (this.#delayTicks ?? 1 + this.#ticksAPatch()) + 2 * this.#jitter;
  }

  /** How many ticks there are between two patches: 1, unless the room sends less often than it ticks. */
  #ticksAPatch(): number {
    const { tickRate, patchRate } = this.#source;
    return patchRate !== undefined && patchRate > 0 && patchRate < tickRate ? Math.ceil(tickRate / patchRate) : 1;
  }

  /**
   * Feed the latest values, keyed by id, as of tick `tick`: the source's
   * latest unless given. Ids missing from `targets` are forgotten.
   *
   * @param now when they arrived, from `performance.now()`
   */
  update(targets: Record<string, Record<Field, number>>, tick = this.#source.tick, now = localNow()): void {
    if (tick < this.#newestTick) {
      // The room went back to a save: what was kept is of a timeline that no longer is.
      this.#tracks.clear();
      this.#arrivals.reset();
      this.#lateness = undefined;
      this.#jitter = 0;
      this.#shown = undefined;
    }
    if (tick > this.#newestTick) {
      this.#newestTick = tick;
      this.#measure(tick, now);
    }
    const drawn = this.#shown?.tick ?? -Infinity;
    const tracks = new Map<string, Snapshot<Field>[]>();
    for (const id of Object.keys(targets)) {
      const target = targets[id]!;
      const values = {} as Record<Field, number>;
      for (const field of this.#fields) values[field] = target[field];
      const track = this.#tracks.get(id) ?? [];
      const last = track[track.length - 1];
      if (last?.tick === tick) {
        last.values = values;
      } else {
        track.push({ tick, values, snap: last !== undefined && this.#distance(last.values, values) > this.#snapDistance });
      }
      // What lies behind the moment drawn is no longer needed, apart from the one it starts from.
      let drop = 0;
      while (drop < track.length - 2 && track[drop + 1]!.tick <= drawn) drop += 1;
      drop = Math.max(drop, track.length - MAX_SNAPSHOTS);
      if (drop > 0) track.splice(0, drop);
      tracks.set(id, track);
    }
    this.#tracks = tracks;
  }

  /**
   * The latest values given for `id` were a jump, such as a respawn: draw
   * them in one step when their tick comes, not as a slide. Call it after
   * the `update` that brought them, for instance when a message says so:
   * messages arrive after the patch of the same tick.
   */
  snap(id: string): void {
    const track = this.#tracks.get(id);
    const last = track?.[track.length - 1];
    if (last && track!.length > 1) last.snap = true;
  }

  /** The values to draw for `id` right now, or undefined if it is not known. */
  at(id: string, now = localNow()): Record<Field, number> | undefined {
    const track = this.#tracks.get(id);
    if (!track || track.length === 0) return undefined;
    const newest = track[track.length - 1]!;
    const tick = this.#drawnTick(now);
    if (tick === undefined) return { ...newest.values };

    if (tick >= newest.tick) {
      const before = track[track.length - 2];
      const ahead = Math.min(tick - newest.tick, this.#maxExtrapolation ?? 2 + this.#ticksAPatch());
      if (!before || newest.snap || ahead <= 0) return { ...newest.values };
      // Carried on at the speed it last had, for as long as that is allowed.
      return this.#blend(before.values, newest.values, 1 + ahead / (newest.tick - before.tick));
    }
    let i = track.length - 1;
    while (i > 0 && track[i - 1]!.tick > tick) i -= 1;
    const to = track[i]!;
    const from = track[i - 1];
    // Before the first it knows, it shows the first.
    if (!from) return { ...to.values };
    if (to.snap) return { ...from.values };
    return this.#blend(from.values, to.values, (tick - from.tick) / (to.tick - from.tick));
  }

  /** Forget everything, e.g. after moving to another room. */
  clear(): void {
    this.#tracks.clear();
    this.#arrivals.reset();
    this.#lateness = undefined;
    this.#jitter = 0;
    this.#newestTick = -Infinity;
    this.#shown = undefined;
  }

  /** The room's tick at `now`, from its clock if it says where that is, else from when patches arrive. */
  #clockTick(now: number): number | undefined {
    const told = this.#source.serverTick?.(now);
    if (told !== undefined) {
      // A clock that stands still: the simulation has stopped, and the latest state is final.
      if (this.#source.serverTick!(now + 1000) === told) return Infinity;
      return told;
    }
    return this.#arrivals.tick(now);
  }

  /** A state of `tick` arrived at `now`: how late was it, by the room's clock? */
  #measure(tick: number, now: number): void {
    const rate = this.#source.tickRate;
    if (!(rate > 0)) return;
    if (this.#source.serverTick?.(now) === undefined) this.#arrivals.reading(tick, rate, 0, 0, now);
    const clock = this.#clockTick(now);
    if (clock === undefined || clock === Infinity) return;
    const late = clock - tick;
    if (this.#lateness === undefined) {
      this.#lateness = late;
      return;
    }
    // As TCP smooths its round trip: the mean takes an eighth of each sample, the spread a quarter.
    this.#jitter += (Math.abs(late - this.#lateness) - this.#jitter) / 4;
    this.#lateness += (late - this.#lateness) / 8;
  }

  /** The tick drawn at `now`, with its fraction. Undefined when there is no clock to go by. */
  #drawnTick(now: number): number | undefined {
    if (!(this.#source.tickRate > 0)) return undefined;
    const clock = this.#clockTick(now);
    if (clock === undefined || clock === Infinity) return undefined;
    let tick = clock - this.delay;
    const shown = this.#shown;
    // A delay that grows would take what is drawn back in time. It waits for the clock instead.
    if (shown && now >= shown.now) tick = Math.max(tick, shown.tick);
    if (!shown || now >= shown.now) this.#shown = { tick, now };
    return tick;
  }

  #blend(from: Record<Field, number>, to: Record<Field, number>, t: number): Record<Field, number> {
    const shown = {} as Record<Field, number>;
    for (const field of this.#fields) {
      const a = from[field];
      const b = to[field];
      shown[field] = this.#angles.has(field) ? wrap(a + wrap(b - a) * t) : a + (b - a) * t;
    }
    return shown;
  }

  #distance(a: Record<Field, number>, b: Record<Field, number>): number {
    if (this.#snapDistance === Infinity) return 0;
    let sum = 0;
    for (const field of this.#fields) {
      if (!this.#angles.has(field)) sum += (b[field] - a[field]) ** 2;
    }
    return Math.sqrt(sum);
  }
}

/** An angle in radians, brought into (-π, π]. */
function wrap(angle: number): number {
  const turned = angle - 2 * Math.PI * Math.floor((angle + Math.PI) / (2 * Math.PI));
  return turned === -Math.PI ? Math.PI : turned;
}
