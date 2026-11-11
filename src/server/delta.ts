import { applyPatch, diff, isPlainObject, jsonEqual } from "../patch.js";

export interface SeatedSocket {
  ws: WebSocket;
  /** The player the socket belongs to. */
  id: string;
}

/**
 * Sends each socket what changed in its view since the last tick.
 *
 * It remembers, per socket, a copy of what that socket holds. A socket it
 * knows nothing about gets its whole view; the others get a patch, or
 * nothing if their view did not change.
 *
 * Work that is the same for several sockets is done once. Without a custom
 * view everyone sees the same state, so sockets holding the same snapshot
 * share one diff. With a custom view, the same holds one level down: a
 * top-level field of the view that is the same object for several players
 * (a public part built once per tick, say) is diffed and serialized once for
 * all the sockets that hold the same copy of it, and they all end the tick
 * holding one copy again.
 */
export class DeltaSender {
  /** What each socket was last sent. Snapshots are never mutated, so sockets may share one. */
  #baselines = new Map<WebSocket, unknown>();
  /** The `seq` of the last send. */
  #sentSeq = -1;

  /** Record exactly what a socket has just been sent in full, as a copy the simulation cannot touch. */
  remember(ws: WebSocket, snapshot: unknown): void {
    this.#baselines.set(ws, snapshot);
  }

  /** Forget what the sockets hold: the next send gives each its whole view. */
  reset(): void {
    this.#baselines.clear();
  }

  /**
   * @param state  the room's state, which is what everyone sees when `viewOf` is undefined
   * @param viewOf what one player sees, when the room has a custom view
   */
  send(
    sockets: SeatedSocket[],
    seq: number,
    tick: number,
    state: unknown,
    viewOf: ((playerId: string) => unknown) | undefined,
  ): void {
    if (viewOf) return this.#sendViews(sockets, seq, tick, viewOf);
    if (seq === this.#sentSeq && sockets.every(({ ws }) => this.#baselines.has(ws))) return;

    const baselines = new Map<WebSocket, unknown>();
    // Sockets that were last sent the same snapshot share one diff, and everyone ends the tick
    // on the same snapshot.
    const shared = new Map<unknown, { frame?: string; next: unknown }>();
    let common: { next: unknown } | undefined;

    for (const { ws, id } of sockets) {
      try {
        const base = this.#baselines.get(ws);
        let update = base === undefined ? undefined : shared.get(base);
        if (!update) {
          update = frameFor(base, state, seq, tick);
          if (common) update.next = common.next;
          else common = update;
          if (base !== undefined) shared.set(base, update);
        }
        if (update.frame) ws.send(update.frame);
        baselines.set(ws, update.next);
      } catch (err) {
        console.error(`[tickflare] could not send the tick to ${id}:`, err);
      }
    }
    this.#baselines = baselines;
    this.#sentSeq = seq;
  }

  #sendViews(sockets: SeatedSocket[], seq: number, tick: number, viewOf: (playerId: string) => unknown): void {
    const head = `"seq":${seq},"tick":${tick}`;
    // Every view first, then the diffs: a field shared between views is final by the time it is diffed.
    const views: { ws: WebSocket; id: string; live: unknown }[] = [];
    for (const { ws, id } of sockets) {
      try {
        views.push({ ws, id, live: viewOf(id) });
      } catch (err) {
        // A view() that threw must not starve the other players.
        console.error(`[tickflare] could not send the tick to ${id}:`, err);
      }
    }

    const fields = new FieldCache();
    const baselines = new Map<WebSocket, unknown>();
    for (const { ws, id, live } of views) {
      try {
        const base = this.#baselines.get(ws);
        const update = isPlainObject(live) && (base === undefined || isPlainObject(base))
          ? viewFrame(base, live, head, fields)
          : frameFor(base, live, seq, tick);
        if (update.frame) ws.send(update.frame);
        baselines.set(ws, update.next);
      } catch (err) {
        console.error(`[tickflare] could not send the tick to ${id}:`, err);
      }
    }
    // A socket whose view() threw keeps what it had, and gets the difference next time.
    for (const { ws } of sockets) {
      if (!baselines.has(ws) && this.#baselines.has(ws)) baselines.set(ws, this.#baselines.get(ws));
    }
    this.#baselines = baselines;
    this.#sentSeq = seq;
  }
}

/**
 * What is known, during one send, about each top-level field value that is an
 * object: its JSON, the copy everyone who is brought up to date ends up holding,
 * and the patch from each copy that was being held before.
 */
class FieldCache {
  #byValue = new Map<object, { json?: string; next?: unknown; patches: Map<unknown, string | null> }>();

  #entry(live: object) {
    let entry = this.#byValue.get(live);
    if (!entry) this.#byValue.set(live, (entry = { patches: new Map() }));
    return entry;
  }

  /** The JSON of the whole value. */
  json(live: object): string {
    const entry = this.#entry(live);
    return (entry.json ??= JSON.stringify(live));
  }

  /**
   * How to bring `base` up to `live`: a patch as JSON, or null when nothing
   * changed. Also settles the copy that holders of `live` share afterwards.
   */
  patch(base: Record<string, unknown>, live: Record<string, unknown>): string | null {
    const entry = this.#entry(live);
    const known = entry.patches.get(base);
    if (known !== undefined) return known;
    const patch = diff(base, live);
    let json: string | null = null;
    if (patch) {
      json = JSON.stringify(patch);
      entry.next ??= applyPatch(base, JSON.parse(json));
    } else {
      entry.next ??= base;
    }
    entry.patches.set(base, json);
    return json;
  }

  /** The copy of `live` that everyone who holds it after this send shares. */
  next(live: object): unknown {
    const entry = this.#entry(live);
    return (entry.next ??= JSON.parse(this.json(live)));
  }
}

/**
 * The frame that brings a socket from `base` to the view `live`, field by
 * field, so that fields shared with other views cost nothing extra.
 */
function viewFrame(
  base: Record<string, unknown> | undefined,
  live: Record<string, unknown>,
  head: string,
  fields: FieldCache,
): { frame?: string; next: unknown } {
  if (base === undefined) {
    const parts: string[] = [];
    const next: Record<string, unknown> = {};
    for (const key of Object.keys(live)) {
      const value = live[key];
      if (value === undefined) continue;
      if (typeof value === "object" && value !== null) {
        parts.push(`${JSON.stringify(key)}:${fields.json(value)}`);
        next[key] = fields.next(value);
      } else {
        const json = JSON.stringify(value);
        if (json === undefined) continue;
        parts.push(`${JSON.stringify(key)}:${json}`);
        next[key] = JSON.parse(json);
      }
    }
    return { frame: `{"t":"state",${head},"state":{${parts.join(",")}}}`, next };
  }

  const parts: string[] = [];
  const next: Record<string, unknown> = { ...base };
  for (const key of Object.keys(live)) {
    const to = live[key];
    if (to === undefined) continue;
    const from = Object.prototype.hasOwnProperty.call(base, key) ? base[key] : undefined;
    const name = JSON.stringify(key);
    if (typeof to === "object" && to !== null) {
      if (isPlainObject(from) && isPlainObject(to)) {
        const patch = fields.patch(from, to);
        if (patch !== null) parts.push(`${name}:${patch}`);
      } else if (from === undefined || !jsonEqual(from, to)) {
        parts.push(`${name}:[${fields.json(to)}]`);
      }
      next[key] = fields.next(to);
    } else if (from === undefined || !jsonEqual(from, to)) {
      const json = JSON.stringify(to);
      if (json === undefined) continue;
      parts.push(`${name}:[${json}]`);
      next[key] = JSON.parse(json);
    }
  }
  for (const key of Object.keys(base)) {
    if (base[key] !== undefined && (!Object.prototype.hasOwnProperty.call(live, key) || live[key] === undefined)) {
      parts.push(`${JSON.stringify(key)}:0`);
      delete next[key];
    }
  }
  if (parts.length === 0) return { next: base };
  return { frame: `{"t":"patch",${head},"p":{${parts.join(",")}}}`, next };
}

/** The frame that brings a socket from `base` to `live`, and the snapshot it will then hold. */
function frameFor(base: unknown, live: unknown, seq: number, tick: number): { frame?: string; next: unknown } {
  const head = `"seq":${seq},"tick":${tick}`;
  if (base !== undefined) {
    const patch = diff(base, live);
    if (patch === undefined) return { next: base };
    if (patch !== null) {
      const json = JSON.stringify(patch);
      return { frame: `{"t":"patch",${head},"p":${json}}`, next: applyPatch(base, JSON.parse(json)) };
    }
  }
  const json = JSON.stringify(live) ?? "null";
  return { frame: `{"t":"state",${head},"state":${json}}`, next: JSON.parse(json) };
}
