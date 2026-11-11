import { describe, expect, it } from "vitest";
import { applyPatch, diff, type Patch } from "../src/patch.js";

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
    expect(patch).toEqual({ gone: 0, added: [{ z: 1 }], nested: { y: [3] }, list: [[1, 2, 3]] });
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
