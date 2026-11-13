
/**
 * Tracks what a hook writes to the room's state, so that the kernel knows
 * whether anything changed and can put it back, without making a copy of the
 * whole state before every hook.
 *
 * Inside a hook `this.state` is not the state itself but a proxy of it, and
 * so is every object and array reached through it. Reading passes straight
 * through. Writing is noted first: which slot, and what was in it. Undoing
 * a hook is replaying those notes backwards.
 *
 * The state underneath stays made of plain objects only: a proxy that is
 * written into the state is replaced by the object it stands for. So the
 * simulation, the views and the saves, which run outside these hooks, work
 * on plain objects at full speed.
 */

/** The object behind each proxy, for every tracker: `plain()` needs no tracker to look it up. */
const TARGETS = new WeakMap<object, object>();

/** One write, as it has to be undone. */
type Note =
  | { target: Record<PropertyKey, unknown>; key: PropertyKey; had: boolean; value: unknown; length?: number }
  | { target: object; key: PropertyKey; descriptor: PropertyDescriptor | undefined }
  | { undo: () => void };

/** An object literal, or anything else with no class of its own: what JSON turns back into an object. */
function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const NOT_JSON = "Room state must be JSON-serializable";
const OUTSIDE =
  "The room's state was changed outside a hook. Change it in a hook, or from `act()` after an await.";

/**
 * The object itself behind something read from `this.state` inside a hook,
 * for the few things a proxy cannot stand in for: `structuredClone`, or
 * comparing with `===` against an object that did not come from the state.
 * Read from it; a change made through it is not tracked, so it is neither
 * sent nor undone with the hook.
 */
export function plain<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  return (TARGETS.get(value) as T | undefined) ?? value;
}

export class Tracker {
  /** The proxy of each object of the state that has been read through one. */
  #proxies = new WeakMap<object, object>();
  /** What the running hook has written, oldest first. Null while no hook is running. */
  #notes: Note[] | null = null;
  /**
   * The keys of each object the running hook has deleted a key from, as they
   * were before. Putting a deleted key back puts it last, and the order of
   * the keys is part of what the state looks like as JSON.
   */
  #orders = new Map<Record<PropertyKey, unknown>, string[]>();
  #handler: ProxyHandler<Record<PropertyKey, unknown>>;
  /** `includes`, `indexOf` and `lastIndexOf` for proxied arrays: see `#search`. */
  #searches: Record<string, (this: unknown[], ...args: unknown[]) => unknown>;

  constructor() {
    this.#handler = {
      get: (target, key, receiver) => this.#get(target, key, receiver),
      set: (target, key, value) => this.#set(target, key, value),
      deleteProperty: (target, key) => this.#delete(target, key),
      defineProperty: (target, key, descriptor) => this.#define(target, key, descriptor),
    };
    this.#searches = {
      includes: this.#search("includes"),
      indexOf: this.#search("indexOf"),
      lastIndexOf: this.#search("lastIndexOf"),
    };
  }

  /** Whether a hook is being tracked. */
  get active(): boolean {
    return this.#notes !== null;
  }

  /** Whether the hook being tracked has changed anything so far. */
  get changed(): boolean {
    return this.#notes !== null && this.#notes.length > 0;
  }

  /** Start tracking a hook. */
  begin(): void {
    this.#notes = [];
  }

  /** The hook is over and its changes stand. */
  end(): void {
    this.#notes = null;
    this.#orders.clear();
  }

  /** The hook is over and everything it wrote is put back. */
  undo(): void {
    const notes = this.#notes;
    this.#notes = null;
    if (!notes) return;
    for (let i = notes.length - 1; i >= 0; i--) {
      const note = notes[i]!;
      if ("undo" in note) {
        note.undo();
      } else if ("descriptor" in note) {
        if (note.descriptor) Object.defineProperty(note.target, note.key, note.descriptor);
        else delete (note.target as Record<PropertyKey, unknown>)[note.key];
      } else {
        if (note.had) note.target[note.key] = note.value;
        else delete note.target[note.key];
        // Writing past the end of an array made it longer, and deleting does not make it shorter.
        if (note.length !== undefined) (note.target as unknown as unknown[]).length = note.length;
      }
    }
    for (const [target, keys] of this.#orders) {
      // Every key is back, with its value. Taking each out and putting it in again, in the
      // order they were in, leaves them in that order.
      for (const key of keys) {
        // A key the hook added before it first deleted one is in the list, and gone again by now.
        if (!Object.hasOwn(target, key)) continue;
        const value = target[key];
        delete target[key];
        target[key] = value;
      }
    }
    this.#orders.clear();
  }

  /** Note a change the tracker cannot see by itself, with how to undo it. */
  note(undo: () => void): void {
    if (this.#notes === null) throw new TypeError(OUTSIDE);
    this.#notes.push({ undo });
  }

  /** What `this.state` gives a hook: the proxy of `value` if it is an object or an array of the state. */
  wrap<T>(value: T): T {
    if (typeof value !== "object" || value === null) return value;
    const known = this.#proxies.get(value);
    if (known) return known as T;
    if (!Array.isArray(value) && !isPlainObject(value)) return value;
    const proxy = new Proxy(value as Record<PropertyKey, unknown>, this.#handler);
    this.#proxies.set(value, proxy);
    TARGETS.set(proxy, value);
    return proxy as T;
  }

  /**
   * A value on its way into the state, with every proxy in it replaced by the
   * object it stands for. New objects are looked through, and changed in
   * place: they are the state's from here on.
   */
  clean<T>(value: T): T {
    return this.#clean(value, undefined) as T;
  }

  #clean(value: unknown, above: Set<object> | undefined): unknown {
    if (typeof value === "bigint") throw new TypeError(NOT_JSON);
    if (typeof value !== "object" || value === null) return value;
    const target = TARGETS.get(value);
    if (target) return target;
    // Already part of the state, which holds no proxies; or not something JSON looks into.
    if (this.#proxies.has(value)) return value;
    const list = Array.isArray(value);
    if (!list && !isPlainObject(value)) return value;
    if (above?.has(value)) throw new TypeError(NOT_JSON);
    (above ??= new Set()).add(value);
    const inside = value as Record<PropertyKey, unknown>;
    for (const key of list ? (value as unknown[]).keys() : Object.keys(value)) {
      const item = inside[key];
      if (typeof item === "bigint") throw new TypeError(NOT_JSON);
      if (typeof item !== "object" || item === null) continue;
      const cleaned = this.#clean(item, above);
      if (cleaned !== item) inside[key] = cleaned;
    }
    above.delete(value);
    return value;
  }

  #get(target: Record<PropertyKey, unknown>, key: PropertyKey, receiver: unknown): unknown {
    const value = Reflect.get(target, key, receiver);
    if (typeof value === "function") {
      return typeof key === "string" && Array.isArray(target) && Object.hasOwn(this.#searches, key)
        ? this.#searches[key]
        : value;
    }
    if (typeof value !== "object" || value === null) return value;
    // A proxy has to hand out a frozen object's own values as they are.
    if (!Object.isExtensible(target)) {
      const own = Reflect.getOwnPropertyDescriptor(target, key);
      if (own && !own.configurable && !own.writable) return value;
    }
    return this.wrap(value);
  }

  #set(target: Record<PropertyKey, unknown>, key: PropertyKey, incoming: unknown): boolean {
    const notes = this.#notes;
    if (notes === null) throw new TypeError(OUTSIDE);
    const value = this.#clean(incoming, undefined);
    const had = Object.hasOwn(target, key);
    const old = had ? target[key] : undefined;
    if (had && Object.is(old, value)) return true;

    if (!Array.isArray(target)) {
      if (!Reflect.set(target, key, value)) return false;
      notes.push({ target, key, had, value: old });
      return true;
    }
    const length = target.length;
    // Making an array shorter drops what was past its new end without a word.
    const dropped: Note[] = [];
    if (key === "length" && typeof value === "number" && value < length) {
      for (let i = value; i < length; i++) {
        if (i in target) dropped.push({ target, key: String(i), had: true, value: target[i], length });
      }
    }
    if (!Reflect.set(target, key, value)) return false;
    notes.push(...dropped, { target, key, had, value: old, length });
    return true;
  }

  #delete(target: Record<PropertyKey, unknown>, key: PropertyKey): boolean {
    const notes = this.#notes;
    if (notes === null) throw new TypeError(OUTSIDE);
    if (!Object.hasOwn(target, key)) return Reflect.deleteProperty(target, key);
    const old = target[key];
    const list = Array.isArray(target);
    if (!list && !this.#orders.has(target)) this.#orders.set(target, Object.keys(target));
    if (!Reflect.deleteProperty(target, key)) return false;
    const note: Note = { target, key, had: true, value: old };
    if (list) note.length = target.length;
    notes.push(note);
    return true;
  }

  #define(target: Record<PropertyKey, unknown>, key: PropertyKey, descriptor: PropertyDescriptor): boolean {
    const notes = this.#notes;
    if (notes === null) throw new TypeError(OUTSIDE);
    const before = Reflect.getOwnPropertyDescriptor(target, key);
    const cleaned = "value" in descriptor ? { ...descriptor, value: this.#clean(descriptor.value, undefined) } : descriptor;
    if (!Reflect.defineProperty(target, key, cleaned)) return false;
    notes.push({ target, key, descriptor: before });
    return true;
  }

  /**
   * A new object that a hook has just put in an array is still held by the
   * hook as the object itself, while the array hands out its proxy. So
   * looking for it in the array has to compare the objects underneath.
   */
  #search(name: "includes" | "indexOf" | "lastIndexOf") {
    const method = Array.prototype[name] as (this: unknown[], ...args: unknown[]) => unknown;
    return function (this: unknown[], ...args: unknown[]): unknown {
      if (args.length > 0) args[0] = plain(args[0]);
      return method.apply(plain(this), args);
    };
  }
}
