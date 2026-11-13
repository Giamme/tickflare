import { describe, expect, it } from "vitest";
import { plain, Tracker } from "../src/server/tracked.js";

/** A tree to change, the tracker that follows the changes, and the proxy to change it through. */
function tracked<T extends object>(tree: T) {
  const tracker = new Tracker();
  tracker.begin();
  return { tracker, tree, state: tracker.wrap(tree) };
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Whether a proxy is anywhere inside the tree, which is to hold plain objects only. */
function holdsProxy(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (plain(value) !== value) return true;
  return Object.values(value).some(holdsProxy);
}

const sample = () => ({
  total: 3,
  names: ["ada", "bob", "cy"],
  units: { u1: { x: 1, y: 2, tags: ["a"] }, u2: { x: 5, y: 6, tags: [] as string[] } } as Record<
    string,
    { x: number; y: number; tags: string[]; hp?: number }
  >,
  nested: { deep: { deeper: { flag: false } } },
  maybe: null as null | { n: number },
});

describe("following what a hook writes", () => {
  it("reads like the tree itself", () => {
    const { state, tree } = tracked(sample());
    expect(state.total).toBe(3);
    expect(state.units.u1!.tags).toEqual(["a"]);
    expect(Object.keys(state.units)).toEqual(["u1", "u2"]);
    expect(state.names.map((name) => name.toUpperCase())).toEqual(["ADA", "BOB", "CY"]);
    expect([...state.names]).toEqual(tree.names);
    expect(JSON.stringify(state)).toBe(JSON.stringify(tree));
    expect(Array.isArray(state.names)).toBe(true);
    expect("u1" in state.units).toBe(true);
    // The same object is the same proxy every time, so it can be compared with itself.
    expect(state.units.u1).toBe(state.units.u1);
  });

  it("knows whether anything changed", () => {
    const { state, tracker } = tracked(sample());
    void state.units.u1!.x;
    state.total = 3;
    state.nested.deep.deeper.flag = false;
    delete (state.units as Record<string, unknown>).nobody;
    expect(tracker.changed).toBe(false);

    state.nested.deep.deeper.flag = true;
    expect(tracker.changed).toBe(true);
  });

  it("writes through to the tree", () => {
    const { state, tree } = tracked(sample());
    state.total += 4;
    state.units.u1!.x = 10;
    state.units.u3 = { x: 0, y: 0, tags: ["new"] };
    delete state.units.u2;
    state.names.push("di");
    state.maybe = { n: 1 };

    expect(tree.total).toBe(7);
    expect(tree.units.u1!.x).toBe(10);
    expect(Object.keys(tree.units)).toEqual(["u1", "u3"]);
    expect(tree.names).toEqual(["ada", "bob", "cy", "di"]);
    expect(tree.maybe).toEqual({ n: 1 });
  });

  it.each<[string, (state: ReturnType<typeof sample>) => void]>([
    ["a field", (s) => void (s.total = 99)],
    ["a nested field", (s) => void (s.nested.deep.deeper.flag = true)],
    ["a new key", (s) => void (s.units.u9 = { x: 9, y: 9, tags: [] })],
    ["a deleted key", (s) => void delete s.units.u1],
    [
      "a new key and then a deleted one",
      (s) => {
        s.units.u9 = { x: 9, y: 9, tags: [] };
        delete s.units.u1;
        delete s.units.u9;
        s.units.u1 = { x: 0, y: 0, tags: [] };
      },
    ],
    ["a replaced branch", (s) => void (s.nested = { deep: { deeper: { flag: true } } })],
    ["push", (s) => void s.names.push("di", "ed")],
    ["pop", (s) => void s.names.pop()],
    ["shift", (s) => void s.names.shift()],
    ["unshift", (s) => void s.names.unshift("zed")],
    ["splice", (s) => void s.names.splice(1, 1, "x", "y", "z")],
    ["sort", (s) => void s.names.sort((a, b) => (a < b ? 1 : -1))],
    ["reverse", (s) => void s.names.reverse()],
    ["fill", (s) => void s.names.fill("same")],
    ["an index past the end", (s) => void (s.names[7] = "far")],
    ["length to zero", (s) => void (s.names.length = 0)],
    ["a longer length", (s) => void (s.names.length = 9)],
    ["a nested array", (s) => void s.units.u1!.tags.push("b", "c")],
    ["a copy with a change", (s) => void (s.units.u1 = { ...s.units.u1!, x: 42 })],
    ["defineProperty", (s) => void Object.defineProperty(s, "total", { value: 5, writable: true, enumerable: true, configurable: true })],
    ["Object.assign", (s) => void Object.assign(s.units.u2!, { x: 0, hp: 3 })],
    [
      "many at once",
      (s) => {
        s.names.push("di");
        s.units.u1!.tags = [];
        delete s.units.u2;
        s.names.splice(0, 2);
        s.total = -1;
        s.maybe = { n: 2 };
        s.maybe.n = 3;
      },
    ],
  ])("puts back %s", (_name, change) => {
    const { state, tree, tracker } = tracked(sample());
    const before = JSON.stringify(tree);
    const u1 = tree.units.u1;

    change(state);
    expect(tracker.changed).toBe(true);
    expect(JSON.stringify(tree)).not.toBe(before);
    tracker.undo();

    expect(JSON.stringify(tree)).toBe(before);
    expect(Object.keys(tree.units)).toEqual(["u1", "u2"]);
    expect(tree.names).toHaveLength(3);
    // Put back, not rebuilt: what was there before is the same object as before.
    expect(tree.units.u1).toBe(u1);
  });

  it("keeps proxies out of the tree", () => {
    const { state, tree } = tracked(sample());
    state.units.u3 = state.units.u1!;
    state.units.u4 = { ...state.units.u2!, tags: state.units.u1!.tags };
    state.names = [...state.names];
    const group = { members: [state.units.u1, { inner: state.nested.deep }] };
    (state as unknown as { group: unknown }).group = group;
    Object.assign(state.nested, { again: state.nested.deep });

    expect(holdsProxy(tree)).toBe(false);
    expect(tree.units.u3).toBe(tree.units.u1);
    expect(tree.units.u4!.tags).toBe(tree.units.u1!.tags);
  });

  it("finds an object the hook has just put in an array", () => {
    const { state } = tracked({ units: [] as { id: number }[] });
    const unit = { id: 1 };
    state.units.push(unit);

    expect(state.units.includes(unit)).toBe(true);
    expect(state.units.indexOf(unit)).toBe(0);
    expect(state.units.lastIndexOf(unit)).toBe(0);
    expect(state.units.includes(state.units[0]!)).toBe(true);
    expect(state.units.indexOf({ id: 1 })).toBe(-1);
    // The proxy is not the object, which is what `plain` is for.
    expect(state.units[0]).not.toBe(unit);
    expect(plain(state.units[0])).toBe(unit);
  });

  it("refuses what JSON cannot hold, when it is written", () => {
    const { state, tree, tracker } = tracked(sample());
    const before = JSON.stringify(tree);
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = { back: loop };

    expect(() => void ((state as unknown as { big: unknown }).big = 10n)).toThrow("JSON-serializable");
    expect(() => void ((state as unknown as { big: unknown }).big = { deep: [1n] })).toThrow("JSON-serializable");
    expect(() => void ((state as unknown as { loop: unknown }).loop = loop)).toThrow("JSON-serializable");
    // The same object twice is not a loop.
    const shared = { n: 1 };
    (state as unknown as { twice: unknown }).twice = [shared, shared];
    tracker.undo();
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("leaves alone what JSON does not look into", () => {
    const { state, tree } = tracked({ when: null as Date | null, at: { when: new Date(0) } });
    const date = new Date(5);
    state.when = date;
    expect(tree.when).toBe(date);
    expect(state.at.when.getTime()).toBe(0);
    expect(JSON.stringify(state)).toBe(JSON.stringify(tree));
  });

  it("reads frozen objects", () => {
    const { state } = tracked({ fixed: Object.freeze({ inner: Object.freeze({ n: 1 }) }) });
    expect(state.fixed.inner.n).toBe(1);
    expect(() => void ((state.fixed as { inner: unknown }).inner = null)).toThrow(TypeError);
  });

  it("refuses a write once the hook is over", () => {
    const { state, tree, tracker } = tracked(sample());
    const unit = state.units.u1!;
    tracker.end();

    expect(unit.x).toBe(1);
    expect(() => void (unit.x = 2)).toThrow("outside a hook");
    expect(() => void delete state.units.u2).toThrow("outside a hook");
    expect(() => state.names.push("late")).toThrow("outside a hook");
    expect(tree.units.u1!.x).toBe(1);

    // The same proxy works again in the next hook.
    tracker.begin();
    unit.x = 2;
    expect(tree.units.u1!.x).toBe(2);
  });

  it("gives the object itself for what is not a proxy", () => {
    const object = { n: 1 };
    expect(plain(object)).toBe(object);
    expect(plain(5)).toBe(5);
    expect(plain(null)).toBe(null);
  });
});

/**
 * The same random changes made twice: through the tracker, and to a plain
 * copy. If they stand, the two trees are the same. If they are undone, the
 * tracked tree is what it was.
 */
describe("random changes", () => {
  // A small generator with a seed, so that a failure can be run again.
  function random(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

  function value(next: () => number, depth: number): Json {
    const roll = next();
    if (depth > 2 || roll < 0.35) return [null, true, 7, "s", 0.5][Math.floor(next() * 5)]!;
    if (roll < 0.65) return Array.from({ length: Math.floor(next() * 4) }, () => value(next, depth + 1));
    const object: Record<string, Json> = {};
    for (let i = Math.floor(next() * 4); i > 0; i--) object[`k${Math.floor(next() * 5)}`] = value(next, depth + 1);
    return object;
  }

  /** Walks to a random object or array in the tree and changes it. The same rolls give the same change on any copy. */
  function change(root: Json, next: () => number): void {
    let at = root as Json[] | Record<string, Json>;
    for (let depth = Math.floor(next() * 4); depth > 0; depth--) {
      const inner = Object.values(at).filter((item): item is Json[] | Record<string, Json> => typeof item === "object" && item !== null);
      if (inner.length === 0) break;
      at = inner[Math.floor(next() * inner.length)]!;
    }
    const roll = next();
    if (Array.isArray(at)) {
      if (roll < 0.2) at.push(value(next, 1));
      else if (roll < 0.3) at.pop();
      else if (roll < 0.4) at.shift();
      else if (roll < 0.5) at.unshift(value(next, 1));
      else if (roll < 0.65) at.splice(Math.floor(next() * (at.length + 1)), Math.floor(next() * 3), value(next, 1));
      else if (roll < 0.75) at.reverse();
      else if (roll < 0.85) at.length = Math.floor(next() * (at.length + 1));
      else if (at.length > 0) at[Math.floor(next() * at.length)] = value(next, 1);
      else at.push(value(next, 1));
      return;
    }
    const keys = Object.keys(at);
    if (roll < 0.45 || keys.length === 0) at[`k${Math.floor(next() * 6)}`] = value(next, 1);
    else if (roll < 0.7) delete at[keys[Math.floor(next() * keys.length)]!];
    else {
      // Moves a branch, so that an object of the tree ends up somewhere else in it.
      const from = keys[Math.floor(next() * keys.length)]!;
      at[`k${Math.floor(next() * 6)}`] = at[from]!;
      delete at[from];
    }
  }

  it("stand as they were made, and are put back exactly", () => {
    for (let seed = 1; seed <= 2000; seed++) {
      const build = random(seed);
      const tree = { root: value(build, 0), list: [value(build, 0), value(build, 0)], map: { a: value(build, 0) } } as Json;
      const expected = copy(tree);
      const tracker = new Tracker();

      // Several hooks in a row: some stand, some are undone.
      for (let hook = 0; hook < 6; hook++) {
        const hookSeed = seed * 100 + hook;
        const stands = hook % 2 === 0;
        const start = JSON.stringify(tree);
        tracker.begin();
        const rolls = random(hookSeed);
        const state = tracker.wrap(tree);
        for (let i = 0; i < 8; i++) change(state, rolls);
        if (stands) {
          tracker.end();
          const same = random(hookSeed);
          for (let i = 0; i < 8; i++) change(expected, same);
          expect(JSON.stringify(tree), `seed ${seed}, hook ${hook}`).toBe(JSON.stringify(expected));
        } else {
          tracker.undo();
          expect(JSON.stringify(tree), `seed ${seed}, hook ${hook}`).toBe(start);
          // Not even a key holding `undefined`, which JSON would not show.
          expect(JSON.stringify(tree, (_key, item: unknown) => (item === undefined ? "undefined!" : item))).toBe(start);
        }
        expect(holdsProxy(tree), `seed ${seed}, hook ${hook}`).toBe(false);
      }
    }
  });
});
