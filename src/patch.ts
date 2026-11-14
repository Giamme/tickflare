/**
 * Deltas between two JSON values, used to send a player only what changed.
 *
 * A patch mirrors the shape of the object it changes. For each key:
 *   - a nested patch object: go into that key and patch what is there;
 *   - `[value]`: set the key to `value`;
 *   - `[changes, length]`: the key holds an array; `length` is how long it
 *     now is, and `changes` has, by index, what to do with the elements that
 *     changed, each in one of these same forms;
 *   - `0`: delete the key.
 *
 * An array is patched element by element where its elements kept their
 * places: a unit that moved costs its new position, not the whole list. An
 * array whose elements shifted, because one was put in or taken out before
 * the end, is sent whole. So for things that come and go, an object keyed by
 * id is still the better home.
 */
export type Patch = { [key: string]: Patch | [unknown] | ArrayPatch | 0 };

/**
 * What changed in an array: by index, the elements to patch or replace, and
 * the array's new length. Elements past the new length are gone.
 */
export type ArrayPatch = [changes: { [index: string]: Patch | [unknown] | ArrayPatch }, length: number];

/**
 * The patch that turns `prev` into `next`. Returns `undefined` when they are
 * equal, and `null` when they cannot be patched because one of them is not a
 * plain object: send `next` whole in that case.
 *
 * `next` is read as JSON would write it: keys holding `undefined` count as absent.
 */
export function diff(prev: unknown, next: unknown): Patch | null | undefined {
  if (isPlainObject(prev) && isPlainObject(next)) return diffObjects(prev, next);
  return jsonEqual(prev, next) ? undefined : null;
}

/** Applies a patch without touching `base`: unchanged branches are shared with it. */
export function applyPatch<T>(base: T, patch: Patch): T {
  const out: Record<string, unknown> = isPlainObject(base) ? { ...base } : {};
  for (const key of Object.keys(patch)) {
    if (key === "__proto__") continue;
    const change = patch[key];
    if (change === 0) delete out[key];
    else if (Array.isArray(change)) out[key] = change.length === 2 ? applyArrayPatch(own(out, key), change) : change[0];
    else if (change) out[key] = applyPatch(own(out, key), change);
  }
  return out as T;
}

/** An index as a patch writes it: a whole number from 0 up, with no sign and no leading zero. */
const INDEX = /^(0|[1-9][0-9]*)$/;

function applyArrayPatch(base: unknown, [changes, length]: ArrayPatch): unknown[] {
  const out: unknown[] = Array.isArray(base) ? base.slice(0, length) : [];
  for (const key of Object.keys(changes)) {
    const index = Number(key);
    // Nothing is put beyond the length the patch gives, so a patch cannot make a huge array.
    if (!INDEX.test(key) || index >= length) continue;
    const change = changes[key]!;
    if (Array.isArray(change)) out[index] = change.length === 2 ? applyArrayPatch(out[index], change) : change[0];
    else out[index] = applyPatch(out[index], change);
  }
  // An element the patch left out, past the old end, is null rather than a hole.
  for (let index = out.length; index < length; index++) out[index] = null;
  for (let index = 0; index < length; index++) if (!(index in out)) out[index] = null;
  return out;
}

/**
 * The same change for a client that does not know array patches: wherever
 * the patch has one, the whole array as it is in `next`, the state the patch
 * leads to. Returns the patch itself when there are none in it.
 */
export function withoutArrayPatches(patch: Patch, next: unknown): Patch {
  let out: Patch | undefined;
  const after = isPlainObject(next) ? next : {};
  for (const key of Object.keys(patch)) {
    const change = patch[key]!;
    let plain: Patch[string] = change;
    if (Array.isArray(change)) {
      if (change.length === 2) plain = [own(after, key)];
    } else if (change !== 0) {
      plain = withoutArrayPatches(change, own(after, key));
    }
    if (plain !== change) (out ??= { ...patch })[key] = plain;
  }
  return out ?? patch;
}

/**
 * How to turn the array `prev` into `next`: a patch of its elements,
 * `undefined` when they are equal, or `null` when sending `next` whole is the
 * better way, which it is when most of what changed are elements replaced
 * outright.
 */
export function diffArrays(prev: unknown[], next: unknown[]): ArrayPatch | null | undefined {
  const changes: ArrayPatch[0] = {};
  let changed = 0;
  let replaced = 0;
  const shared = Math.min(prev.length, next.length);
  for (let index = 0; index < shared; index++) {
    const from = prev[index];
    const to = next[index] === undefined ? null : next[index];
    if (isPlainObject(from) && isPlainObject(to)) {
      const inner = diffObjects(from, to);
      if (!inner) continue;
      changes[index] = inner;
    } else if (Array.isArray(from) && Array.isArray(to)) {
      const inner = diffArrays(from, to);
      if (inner === undefined) continue;
      if (inner === null) replaced += 1;
      changes[index] = inner ?? [to];
    } else if (jsonEqual(from, to)) {
      continue;
    } else {
      changes[index] = [to];
      replaced += 1;
    }
    changed += 1;
  }
  for (let index = shared; index < next.length; index++) {
    changes[index] = [next[index] === undefined ? null : next[index]];
    changed += 1;
    replaced += 1;
  }
  if (changed === 0 && prev.length === next.length) return undefined;
  // Elements replaced outright cost what they cost in the whole array, plus their index. Once
  // they are more than half of it, the whole array is no longer than the patch.
  if (replaced * 2 > next.length) return null;
  return [changes, next.length];
}

function diffObjects(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
): Patch | undefined {
  let patch: Patch | undefined;
  for (const key of Object.keys(next)) {
    const to = next[key];
    if (to === undefined) continue;
    const from = own(prev, key);
    if (isPlainObject(from) && isPlainObject(to)) {
      const inner = diffObjects(from, to);
      if (inner) (patch ??= {})[key] = inner;
    } else if (Array.isArray(from) && Array.isArray(to)) {
      const inner = diffArrays(from, to);
      if (inner !== undefined) (patch ??= {})[key] = inner ?? [to];
    } else if (from === undefined || !jsonEqual(from, to)) {
      (patch ??= {})[key] = [to];
    }
  }
  for (const key of Object.keys(prev)) {
    if (prev[key] !== undefined && own(next, key) === undefined) (patch ??= {})[key] = 0;
  }
  return patch;
}

/**
 * `object[key]`, but only if the object itself has the key. A unit called
 * "toString" or "constructor" must not be mistaken for what every object inherits.
 */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined;
}

/** Whether two values are the same as JSON. @internal */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!jsonEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (isPlainObject(a) && isPlainObject(b)) return diffObjects(a, b) === undefined;
  return false;
}

/** @internal */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
