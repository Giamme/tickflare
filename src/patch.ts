/**
 * Deltas between two JSON values, used to send a player only what changed.
 *
 * A patch mirrors the shape of the object it changes. For each key:
 *   - a nested patch object: go into that key and patch what is there;
 *   - `[value]`: set the key to `value`;
 *   - `0`: delete the key.
 *
 * Only plain objects are patched key by key. Arrays and primitives are
 * replaced whole, so keep things that change one at a time (units, players)
 * in objects keyed by id, not in arrays.
 */
export type Patch = { [key: string]: Patch | [unknown] | 0 };

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
    else if (Array.isArray(change)) out[key] = change[0];
    else if (change) out[key] = applyPatch(own(out, key), change);
  }
  return out as T;
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
