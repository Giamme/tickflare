import { describe, expect, it } from "vitest";
import { applyPatch, diff, withoutArrayPatches, type Patch } from "../src/patch.js";

const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("diff", () => {
  it("returns undefined for equal values", () => {
    expect(diff({ a: 1, b: { c: [1, 2] } }, { a: 1, b: { c: [1, 2] } })).toBeUndefined();
    expect(diff(3, 3)).toBeUndefined();
  });

  it("describes sets, nested changes and deletions", () => {
    const patch = diff(
      { keep: 1, gone: 2, nested: { x: 1, y: 2 }, list: [1, 2] },
      { keep: 1, added: { z: 1 }, nested: { x: 1, y: 3 }, list: [1, 2, 3] },
    );
    // The list grew by one at its end: that element and the new length, not the list again.
    expect(patch).toEqual({ gone: 0, added: [{ z: 1 }], nested: { y: [3] }, list: [{ 2: [3] }, 3] });
  });

  it("treats undefined like JSON does: as absent", () => {
    expect(diff({ a: 1 }, { a: 1, b: undefined })).toBeUndefined();
    expect(diff({ a: 1, b: 2 }, { a: 1, b: undefined })).toEqual({ b: 0 });
  });

  it("tells null from a missing key and from an object", () => {
    expect(diff({ a: null }, { a: null })).toBeUndefined();
    expect(diff({}, { a: null })).toEqual({ a: [null] });
    expect(diff({ a: { b: 1 } }, { a: null })).toEqual({ a: [null] });
    expect(diff({ a: [1] }, { a: { 0: 1 } })).toEqual({ a: [{ 0: 1 }] });
  });

  it("returns null when the root cannot be patched", () => {
    expect(diff([1], [2])).toBeNull();
    expect(diff({ a: 1 }, 5)).toBeNull();
  });

  it("deletes keys that share a name with something every object inherits", () => {
    const prev = { units: { toString: { x: 1 }, constructor: { x: 2 }, alice: { x: 3 } } };
    const next = { units: {} };
    const patch = diff(prev, next);
    expect(patch).toEqual({ units: { toString: 0, constructor: 0, alice: 0 } });
    expect(applyPatch(prev, patch!)).toEqual(next);
  });

  it("adds such keys too, and patches into them", () => {
    const prev: Record<string, unknown> = { units: {} };
    const next: Record<string, unknown> = { units: { toString: { x: 1 }, valueOf: 2 } };
    const patch = diff(prev, next);
    expect(patch).toEqual({ units: { toString: [{ x: 1 }], valueOf: [2] } });
    expect(applyPatch(prev, patch!)).toEqual(next);
    const into = JSON.parse('{"units":{"toString":{"x":[5]}}}') as Patch;
    expect(applyPatch(prev, into)).toEqual(JSON.parse('{"units":{"toString":{"x":5}}}'));
  });
});

describe("applyPatch", () => {
  it("leaves the base alone and shares what did not change", () => {
    const base = { same: { deep: 1 }, changed: { n: 1 } };
    const next = applyPatch(base, { changed: { n: [2] } });

    expect(base.changed.n).toBe(1);
    expect(next).toEqual({ same: { deep: 1 }, changed: { n: 2 } });
    expect(next.same).toBe(base.same);
  });

  it("cannot be used to reach the prototype", () => {
    const next = applyPatch({}, JSON.parse('{"__proto__":{"polluted":[true]}}') as Patch);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.keys(next)).toEqual([]);
  });

  it("rebuilds any next value from any previous one", () => {
    let seed = 42;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
    const value = (depth: number): unknown => {
      const kind = depth > 3 ? pick(["n", "s", "z"]) : pick(["n", "s", "z", "a", "o", "o", "o"]);
      if (kind === "n") return Math.floor(random() * 5);
      if (kind === "s") return pick(["a", "b", ""]);
      if (kind === "z") return null;
      if (kind === "a") return Array.from({ length: Math.floor(random() * 3) }, () => value(depth + 1));
      const object: Record<string, unknown> = {};
      for (const key of ["a", "b", "c", "d"]) if (random() < 0.6) object[key] = value(depth + 1);
      return object;
    };

    for (let i = 0; i < 500; i++) {
      const prev = { root: value(0) };
      const next = { root: value(0) };
      const patch = diff(prev, next);
      const rebuilt = patch ? applyPatch(prev, wire(patch)) : prev;
      expect(rebuilt).toEqual(next);
      expect(diff(rebuilt, next)).toBeUndefined();
    }
  });
});

describe("arrays in a patch", () => {
  const units = () => [
    { id: "a", x: 1, y: 1, tags: ["fast"] },
    { id: "b", x: 5, y: 5, tags: [] as string[] },
    { id: "c", x: 9, y: 9, tags: ["slow", "big"] },
  ];

  it("are patched element by element where the elements kept their places", () => {
    const prev = { units: units() };
    const next = { units: units() };
    next.units[1]!.x = 6;
    next.units[2]!.tags.push("new");
    const patch = diff(prev, next)!;
    // The unit that moved costs its new x, and the array's length is said once.
    expect(patch).toEqual({ units: [{ 1: { x: [6] }, 2: { tags: [{ 2: ["new"] }, 3] } }, 3] });
    const rebuilt = applyPatch(prev, wire(patch));
    expect(rebuilt).toEqual(next);
    // What did not change is the very same object as before.
    expect(rebuilt.units[0]).toBe(prev.units[0]);
    expect(rebuilt.units[1]!.tags).toBe(prev.units[1]!.tags);
    expect(Array.isArray(rebuilt.units)).toBe(true);
  });

  it("grow and shrink at the end", () => {
    const prev = { list: [1, 2, 3, 4, 5, 6], units: units() };
    expect(diff(prev, { ...prev, list: [1, 2, 3, 4, 5, 6, 7] })).toEqual({ list: [{ 6: [7] }, 7] });
    expect(diff(prev, { ...prev, list: [1, 2, 3] })).toEqual({ list: [{}, 3] });
    expect(diff(prev, { ...prev, list: [] })).toEqual({ list: [{}, 0] });
    expect(diff(prev, { ...prev, units: units().slice(0, 2) })).toEqual({ units: [{}, 2] });
    for (const list of [[1, 2, 3, 4, 5, 6, 7], [1, 2, 3], [], [1, 9, 3, 4, 5, 6]]) {
      expect(applyPatch(prev, wire(diff(prev, { ...prev, list })!)).list).toEqual(list);
    }
  });

  it("are sent whole when most of what changed is elements replaced outright", () => {
    // One taken out at the front: every element after it is another one.
    expect(diff({ list: [1, 2, 3, 4, 5, 6] }, { list: [2, 3, 4, 5, 6] })).toEqual({ list: [[2, 3, 4, 5, 6]] });
    expect(diff({ list: [] }, { list: [1, 2] })).toEqual({ list: [[1, 2]] });
    expect(diff({ list: ["a", "b"] }, { list: ["b", "a"] })).toEqual({ list: [["b", "a"]] });
    // Elements that changed in most of what they hold are as good as replaced: a patch of them
    // would say every index and every key again.
    const points = [{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }];
    const shifted = points.map(({ x, y }) => ({ x: x + 1, y: y + 1 }));
    expect(diff({ points }, { points: shifted })).toEqual({ points: [shifted] });
    // And not when the elements are objects that only changed inside.
    const moved = units().map((unit) => ({ ...unit, x: unit.x + 1 }));
    expect(diff({ units: units() }, { units: moved })).toEqual({ units: [{ 0: { x: [2] }, 1: { x: [6] }, 2: { x: [10] } }, 3] });
  });

  it("can be turned back into whole arrays, for a client that does not know them", () => {
    const prev = { units: units(), round: 1, deep: { grid: [[1, 2], [3, 4]] } };
    const next = { units: units(), round: 2, deep: { grid: [[1, 2], [3, 5]] } };
    next.units[0]!.y = 7;
    const patch = diff(prev, next)!;
    expect(patch).toEqual({ units: [{ 0: { y: [7] } }, 3], round: [2], deep: { grid: [{ 1: [{ 1: [5] }, 2] }, 2] } });
    const plain = withoutArrayPatches(patch, next);
    expect(plain).toEqual({ units: [next.units], round: [2], deep: { grid: [next.deep.grid] } });
    expect(applyPatch(prev, wire(plain))).toEqual(next);
    // A patch with no arrays in it is handed back as it is.
    const simple = diff({ a: 1, b: { c: 1 } }, { a: 2, b: { c: 2 } })!;
    expect(withoutArrayPatches(simple, { a: 2, b: { c: 2 } })).toBe(simple);
  });

  it("ignore an index that is not one, and never put anything past the length", () => {
    const odd = { list: [{ "01": [9], "-1": [9], "1.5": [9], __proto__: [9], 7: [9], 1: [8] }, 3] } as unknown as Patch;
    const rebuilt = applyPatch({ list: [1, 2, 3, 4] }, JSON.parse(JSON.stringify(odd).replace('"1":[8]', '"__proto__":[9],"1":[8]')) as Patch);
    expect(rebuilt.list).toEqual([1, 8, 3]);
    // An array patch for something that is not an array makes one, without holes.
    expect(applyPatch({ list: "text" } as unknown as { list: number[] }, { list: [{ 1: [5] }, 3] }).list).toEqual([null, 5, null]);
  });

  it("rebuild any list of units from any earlier one, with array patches and without", () => {
    let seed = 7;
    const random = (n: number) => Math.floor(((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296) * n);
    type Unit = { id: number; x: number; hp: number; path: number[]; cargo?: { kind: string }[] };
    const unit = (id: number): Unit => ({ id, x: random(100), hp: 10, path: [random(5), random(5)] });
    let state = { units: Array.from({ length: 12 }, (_, id) => unit(id)), tick: 0 };
    let viaPatches = wire(state);
    let viaPlain = wire(state);
    let patched = 0;
    for (let tick = 1; tick <= 600; tick++) {
      const next = wire(state);
      next.tick = tick;
      for (let change = random(5); change >= 0; change--) {
        const target = next.units[random(next.units.length)];
        const kind = random(12);
        if (!target || kind === 0) next.units.push(unit(tick * 10 + change));
        else if (kind < 6) target.x += random(7) - 3;
        else if (kind === 6) target.hp -= 1;
        else if (kind === 7) target.path.push(random(5));
        else if (kind === 8) target.path.pop();
        else if (kind === 9) target.cargo = [...(target.cargo ?? []), { kind: `k${random(3)}` }];
        else if (kind === 10) next.units.pop();
        else next.units.splice(random(next.units.length), 1); // the rest shift down
      }
      const patch = diff(state, next);
      if (patch) {
        const text = JSON.stringify(patch);
        viaPatches = applyPatch(viaPatches, JSON.parse(text) as Patch);
        const plain = withoutArrayPatches(patch, next);
        // No array patch is left in it: every array in a change has one element, its value.
        expect(JSON.stringify(plain)).not.toMatch(/\},\d+\]/);
        viaPlain = applyPatch(viaPlain, wire(plain));
        if (/\},\d+\]/.test(text)) patched += 1;
      }
      state = next;
      expect(viaPatches, `tick ${tick}`).toEqual(state);
      expect(viaPlain, `tick ${tick}, without array patches`).toEqual(state);
    }
    expect(patched).toBeGreaterThan(300);
  });
});
