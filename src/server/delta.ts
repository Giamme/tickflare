import { encodePatch, encodePatchFrame, KeyTable } from "../binary.js";
import { applyPatch, diff, diffArrays, isPlainObject, jsonEqual, withoutArrayPatches, type Patch } from "../patch.js";

/**
 * How to bring a socket up to date: a patch as JSON, or its whole view as
 * JSON, or neither if nothing changed for it. And the snapshot it then holds.
 */
interface Update {
  patch?: string;
  /** The patch as an object, when one is at hand. */
  parsed?: Patch;
  /** The patch in binary, once a socket has needed it. */
  binary?: Uint8Array;
  /**
   * The same change for sockets whose clients do not know array patches,
   * once one has needed it: this update itself when the patch has none.
   */
  plain?: { patch: string; parsed?: Patch; binary?: Uint8Array };
  whole?: string;
  next: unknown;
}

export interface SeatedSocket {
  ws: WebSocket;
  /** The player the socket belongs to. */
  id: string;
  /** Whether its client asked for patches in binary. */
  binary?: boolean;
  /** Whether its client said it knows array patches. */
  arrays?: boolean;
}

/**
 * Sends each socket what changed in its view since it was last sent
 * anything: after a tick while the room simulates, after a change otherwise.
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
  /** The `seq` of what each socket was last sent: what its client says its view is of. */
  #seqs = new Map<WebSocket, number>();
  /** The `seq` of the last send. */
  #sentSeq = -1;
  /** Without a custom view: the snapshot every socket held after the last send, and the `seq` it is of. */
  #common: { seq: number; snapshot: unknown } | undefined;
  /** The names sent as keys in binary patches, numbered. One table for the room. */
  #keys = new KeyTable();
  /** How much of that table each socket has been told, and of which generation of it. */
  #told = new WeakMap<WebSocket, { generation: number; known: number }>();
  /**
   * During a send: each patch already encoded in binary, by its JSON, or null if it cannot be,
   * and the frames made around each encoding, by what sets them apart. Players whose views
   * change alike are sent the same bytes, made once.
   */
  #encoded = new Map<string, Uint8Array | null>();
  #framed = new Map<Uint8Array, Map<string, Uint8Array>>();

  /** Record exactly what a socket has just been sent in full, as a copy the room cannot touch. */
  remember(ws: WebSocket, snapshot: unknown, seq: number): void {
    this.#baselines.set(ws, snapshot);
    this.#seqs.set(ws, seq);
  }

  /** Forget what the sockets hold: the next send gives each its whole view. */
  reset(): void {
    this.#baselines.clear();
    this.#seqs.clear();
    this.#common = undefined;
  }

  /** Whether it is known what every one of these sockets holds. */
  knows(sockets: SeatedSocket[]): boolean {
    return sockets.every(({ ws }) => this.#baselines.has(ws));
  }

  /**
   * For a room without a custom view, whose sockets are known to hold the
   * state as it was at `seq`: records that for the sockets nothing else is
   * known about. `snapshot` makes a copy of that state, and is called only
   * if the copy from the last send is of another `seq` or gone.
   */
  seed(sockets: SeatedSocket[], seq: number, snapshot: () => unknown): void {
    let base = this.#common?.seq === seq ? this.#common.snapshot : undefined;
    for (const { ws } of sockets) {
      if (this.#baselines.has(ws)) continue;
      this.#baselines.set(ws, (base ??= snapshot()));
      this.#seqs.set(ws, seq);
    }
  }

  /**
   * @param state  the room's state, which is what everyone sees when `viewOf` is undefined
   * @param viewOf what one player sees, when the room has a custom view
   * @param named  whether a patch says which `seq` it is a patch of, so that a client that
   *               holds another can tell. For changes sent outside the simulation.
   * @param shows  for the sockets whose commands this state is the first to show: the id of
   *               the latest of them, which their frame then carries as `c`
   */
  send(
    sockets: SeatedSocket[],
    seq: number,
    tick: number,
    state: unknown,
    viewOf: ((playerId: string) => unknown) | undefined,
    named = false,
    shows?: Map<WebSocket, number>,
  ): void {
    if (!viewOf && seq === this.#sentSeq && sockets.every(({ ws }) => this.#baselines.has(ws))) return;
    const head = `"seq":${seq},"tick":${tick}`;
    const baselines = new Map<WebSocket, unknown>();
    const seqs = new Map<WebSocket, number>();
    this.#keys.renew();
    /** Sends a socket its update, and records what it then holds. */
    const deliver = (ws: WebSocket, update: Update, binary = false, arrays = false): void => {
      const held = this.#seqs.get(ws);
      const shown = shows?.get(ws);
      const c = shown === undefined ? "" : `,"c":${shown}`;
      if (update.patch !== undefined) {
        const from = named && held !== undefined ? held : undefined;
        // The patch in the form this socket's client reads.
        const form = arrays ? (update as { patch: string }) : plainForm(update);
        const frame = binary ? this.#binaryFrame(ws, form, { seq, tick, from, c: shown }) : undefined;
        if (frame) {
          ws.send(frame);
          this.#told.set(ws, { generation: this.#keys.generation, known: this.#keys.size });
        } else {
          ws.send(`{"t":"patch",${head}${from === undefined ? "" : `,"from":${from}`}${c},"p":${form.patch}}`);
        }
      } else if (update.whole !== undefined) {
        ws.send(`{"t":"state",${head}${c},"state":${update.whole}}`);
      }
      baselines.set(ws, update.next);
      // A socket that was sent nothing still holds the view of the `seq` it had.
      seqs.set(ws, update.patch !== undefined || update.whole !== undefined || held === undefined ? seq : held);
    };

    try {
      if (viewOf) this.#sendViews(sockets, viewOf, deliver);
      else this.#sendState(sockets, state, deliver);
    } finally {
      this.#encoded.clear();
      this.#framed.clear();
    }

    // A socket that could not be sent to, or whose view() threw, keeps what it had and gets the
    // difference next time.
    for (const { ws } of sockets) {
      if (baselines.has(ws) || !this.#baselines.has(ws)) continue;
      baselines.set(ws, this.#baselines.get(ws));
      const held = this.#seqs.get(ws);
      if (held !== undefined) seqs.set(ws, held);
    }
    const common = viewOf ? undefined : this.#latest;
    this.#baselines = baselines;
    this.#seqs = seqs;
    this.#sentSeq = seq;
    this.#common = common === undefined ? undefined : { seq, snapshot: common };
    this.#latest = undefined;
  }

  /** During a send without a custom view: the snapshot everyone ends up holding. */
  #latest: unknown;

  /**
   * A patch as a binary frame for one socket, or undefined if it cannot be
   * said in binary, in which case the socket is sent the JSON: its client
   * reads both. A patch is encoded once in a send, however many sockets are
   * sent it, and so is a frame around it for the sockets that need the same.
   */
  #binaryFrame(
    ws: WebSocket,
    update: { patch: string; parsed?: Patch; binary?: Uint8Array },
    head: { seq: number; tick: number; from: number | undefined; c: number | undefined },
  ): Uint8Array | undefined {
    let patch = update.binary ?? this.#encoded.get(update.patch);
    if (patch === null) return undefined;
    if (patch === undefined) {
      try {
        patch = encodePatch(update.parsed ?? (JSON.parse(update.patch) as Patch), this.#keys);
      } catch {
        this.#encoded.set(update.patch, null);
        return undefined;
      }
      this.#encoded.set(update.patch, patch);
    }
    update.binary = patch;
    const told = this.#told.get(ws);
    // A socket this instance has not sent a frame to, or that knows a table since started again,
    // is told to forget its keys and is given all of them.
    const forget = told === undefined || told.generation !== this.#keys.generation;
    const known = forget ? 0 : told.known;
    // The frame gives the keys from `known` to the table's present size, which grows as patches
    // with new names are encoded: that size is part of what sets a frame apart.
    const key = `${forget ? "f" : known}/${this.#keys.size}/${head.from ?? ""}/${head.c ?? ""}`;
    let frames = this.#framed.get(patch);
    if (frames === undefined) this.#framed.set(patch, (frames = new Map()));
    let frame = frames.get(key);
    if (frame === undefined) {
      try {
        frame = encodePatchFrame(head, this.#keys, known, forget, patch);
      } catch {
        return undefined;
      }
      frames.set(key, frame);
    }
    return frame;
  }

  #sendState(sockets: SeatedSocket[], state: unknown, deliver: Deliver): void {
    // Sockets that were last sent the same snapshot share one diff, and everyone ends up
    // holding the same snapshot.
    const shared = new Map<unknown, Update>();
    let common: Update | undefined;
    for (const { ws, id, binary, arrays } of sockets) {
      try {
        const base = this.#baselines.get(ws);
        let update = base === undefined ? undefined : shared.get(base);
        if (!update) {
          update = updateFor(base, state);
          if (common) update.next = common.next;
          else common = update;
          if (base !== undefined) shared.set(base, update);
        }
        deliver(ws, update, binary, arrays);
      } catch (err) {
        console.error(`[tickflare] could not send the state to ${id}:`, err);
      }
    }
    this.#latest = common?.next;
  }

  #sendViews(
    sockets: SeatedSocket[],
    viewOf: (playerId: string) => unknown,
    deliver: Deliver,
  ): void {
    // Every view first, then the diffs: a field shared between views is final by the time it is diffed.
    const views: (SeatedSocket & { live: unknown })[] = [];
    for (const socket of sockets) {
      try {
        views.push({ ...socket, live: viewOf(socket.id) });
      } catch (err) {
        // A view() that threw must not starve the other players.
        console.error(`[tickflare] could not send the state to ${socket.id}:`, err);
      }
    }

    const fields = new FieldCache();
    for (const { ws, id, binary, arrays, live } of views) {
      try {
        const base = this.#baselines.get(ws);
        deliver(
          ws,
          isPlainObject(live) && (base === undefined || isPlainObject(base))
            ? viewUpdate(base, live, fields, binary === true || arrays !== true)
            : updateFor(base, live),
          binary,
          arrays,
        );
      } catch (err) {
        console.error(`[tickflare] could not send the state to ${id}:`, err);
      }
    }
  }
}

type Deliver = (ws: WebSocket, update: Update, binary?: boolean, arrays?: boolean) => void;

/** The patch of an update without array patches in it, worked out once for the sockets that need it so. */
function plainForm(update: Update): { patch: string; parsed?: Patch; binary?: Uint8Array } {
  if (update.plain) return update.plain;
  const parsed = (update.parsed ??= JSON.parse(update.patch!) as Patch);
  const without = withoutArrayPatches(parsed, update.next);
  update.plain = without === parsed ? (update as { patch: string }) : { patch: JSON.stringify(without), parsed: without };
  return update.plain;
}

/**
 * What is known, during one send, about each top-level field value that is an
 * object: its JSON, the copy everyone who is brought up to date ends up holding,
 * and the patch from each copy that was being held before.
 */
class FieldCache {
  #byValue = new Map<
    object,
    { json?: string; next?: unknown; patches: Map<unknown, string | null>; parsed?: Map<unknown, unknown> }
  >();

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
      if (entry.next === undefined) {
        const parsed = JSON.parse(json) as Patch;
        entry.next = applyPatch(base, parsed);
        (entry.parsed ??= new Map()).set(base, parsed);
      }
    } else {
      entry.next ??= base;
    }
    entry.patches.set(base, json);
    return json;
  }

  /**
   * How to bring the array `base` up to `live`, as the JSON of the change to
   * its key: a patch of its elements or the whole array. Null when nothing
   * changed.
   */
  arrayChange(base: unknown[], live: unknown[]): string | null {
    const entry = this.#entry(live);
    const known = entry.patches.get(base);
    if (known !== undefined) return known;
    const patch = diffArrays(base, live);
    let json: string | null = null;
    if (patch === undefined) {
      entry.next ??= base;
    } else if (patch === null) {
      json = `[${this.json(live)}]`;
    } else {
      json = JSON.stringify(patch);
      if (entry.next === undefined) {
        const parsed = JSON.parse(json) as Patch[string];
        entry.next = applyPatch({ v: base }, { v: parsed }).v;
        (entry.parsed ??= new Map()).set(base, parsed);
      }
    }
    entry.patches.set(base, json);
    return json;
  }

  /**
   * The change `patch` or `arrayChange` gave for `base` and `live`, as an
   * object read back from its JSON: parsed once, for everyone who is sent it.
   */
  parsed(base: unknown, live: object, json: string): unknown {
    const entry = this.#entry(live);
    let parsed = entry.parsed?.get(base);
    if (parsed === undefined) (entry.parsed ??= new Map()).set(base, (parsed = JSON.parse(json)));
    return parsed;
  }

  /** The copy of `live` that everyone who holds it after this send shares. */
  next(live: object): unknown {
    const entry = this.#entry(live);
    return (entry.next ??= JSON.parse(this.json(live)));
  }
}

/**
 * What brings a socket from `base` to the view `live`, field by field, so
 * that fields shared with other views cost nothing extra.
 */
function viewUpdate(
  base: Record<string, unknown> | undefined,
  live: Record<string, unknown>,
  fields: FieldCache,
  parse = false,
): Update {
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
    return { whole: `{${parts.join(",")}}`, next };
  }

  const parts: string[] = [];
  const next: Record<string, unknown> = { ...base };
  // For a client that needs the patch as an object, binary or without array patches: the same
  // patch, built from what is parsed already instead of parsing it again for each player.
  // `__proto__` would be the object's prototype here, where it is an ordinary key in JSON.
  let parsed: Patch | undefined = parse ? {} : undefined;
  for (const key of Object.keys(live)) {
    const to = live[key];
    if (to === undefined) continue;
    const from = Object.prototype.hasOwnProperty.call(base, key) ? base[key] : undefined;
    const name = JSON.stringify(key);
    if (key === "__proto__") parsed = undefined;
    if (typeof to === "object" && to !== null) {
      if (isPlainObject(from) && isPlainObject(to)) {
        const patch = fields.patch(from, to);
        if (patch !== null) {
          parts.push(`${name}:${patch}`);
          if (parsed) parsed[key] = fields.parsed(from, to, patch) as Patch;
        }
      } else if (Array.isArray(from) && Array.isArray(to)) {
        const change = fields.arrayChange(from, to);
        if (change !== null) {
          parts.push(`${name}:${change}`);
          if (parsed) parsed[key] = fields.parsed(from, to, change) as Patch[string];
        }
      } else if (from === undefined || !jsonEqual(from, to)) {
        parts.push(`${name}:[${fields.json(to)}]`);
        if (parsed) parsed[key] = [fields.next(to)];
      }
      next[key] = fields.next(to);
    } else if (from === undefined || !jsonEqual(from, to)) {
      const json = JSON.stringify(to);
      if (json === undefined) continue;
      parts.push(`${name}:[${json}]`);
      next[key] = JSON.parse(json);
      if (parsed) parsed[key] = [next[key]];
    }
  }
  for (const key of Object.keys(base)) {
    if (base[key] !== undefined && (!Object.prototype.hasOwnProperty.call(live, key) || live[key] === undefined)) {
      parts.push(`${JSON.stringify(key)}:0`);
      delete next[key];
      if (key === "__proto__") parsed = undefined;
      else if (parsed) parsed[key] = 0;
    }
  }
  if (parts.length === 0) return { next: base };
  return parsed ? { patch: `{${parts.join(",")}}`, parsed, next } : { patch: `{${parts.join(",")}}`, next };
}

/** What brings a socket from `base` to `live`, and the snapshot it will then hold. */
function updateFor(base: unknown, live: unknown): Update {
  if (base !== undefined) {
    const patch = diff(base, live);
    if (patch === undefined) return { next: base };
    if (patch !== null) {
      const json = JSON.stringify(patch);
      // A copy of its own, so that what the socket holds shares nothing with the room's state.
      const parsed = JSON.parse(json) as Patch;
      return { patch: json, parsed, next: applyPatch(base, parsed) };
    }
  }
  const json = JSON.stringify(live) ?? "null";
  return { whole: json, next: JSON.parse(json) };
}
