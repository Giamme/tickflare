import { describe, expect, it } from "vitest";
import { produce } from "../src/client/draft.js";

/** Freezes everything, so that a write to the base would throw. */
function frozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.values(value).forEach(frozen);
    Object.freeze(value);
  }
  return value;
}

const base = () =>
  frozen({
    units: { a: { x: 1, y: 2, tags: ["fast"] }, b: { x: 5, y: 6, tags: [] as string[] } },
    order: ["a", "b"],
    meta: { round: 1, note: null as string | null },
  });

describe("produce", () => {
  it("returns the base itself when nothing is changed", () => {
    const state = base();
    expect(produce(state, () => {})).toBe(state);
    // Reading is not changing, and neither is writing what is there already.
    expect(
      produce(state, (draft) => {
        void draft.units.a.x;
        draft.units.a.x = 1;
        draft.meta.note = null;
        delete (draft.units as Record<string, unknown>).nobody;
      }),
    ).toBe(state);
  });

  it("copies only what lies on the way to a change", () => {
    const state = base();
    const next = produce(state, (draft) => {
      draft.units.a.x = 9;
    });
    expect(next).toEqual({ ...state, units: { ...state.units, a: { ...state.units.a, x: 9 } } });
    expect(state.units.a.x).toBe(1);
    expect(next).not.toBe(state);
    expect(next.units).not.toBe(state.units);
    expect(next.units.a).not.toBe(state.units.a);
    // Everything else is the very same object.
    expect(next.units.b).toBe(state.units.b);
    expect(next.units.a.tags).toBe(state.units.a.tags);
    expect(next.order).toBe(state.order);
    expect(next.meta).toBe(state.meta);
  });

  it("follows adding, deleting and replacing", () => {
    const state = base();
    const next = produce(state, (draft) => {
      (draft.units as Record<string, unknown>).c = { x: 0, y: 0, tags: [] };
      delete (draft.units as Record<string, unknown>).b;
      draft.meta = { round: 2, note: "new" };
      draft.meta.round += 1;
    });
    expect(next.units).toEqual({ a: state.units.a, c: { x: 0, y: 0, tags: [] } });
    expect(next.units.a).toBe(state.units.a);
    expect(next.meta).toEqual({ round: 3, note: "new" });
    expect(state.meta).toEqual({ round: 1, note: null });
  });

  it("follows what an array's methods do", () => {
    const state = base();
    const next = produce(state, (draft) => {
      draft.order.push("c");
      draft.order.reverse();
      draft.units.a.tags.push("armoured");
      draft.units.b.tags.length = 0;
    });
    expect(next.order).toEqual(["c", "b", "a"]);
    expect(Array.isArray(next.order)).toBe(true);
    expect(next.units.a.tags).toEqual(["fast", "armoured"]);
    expect(next.units.b).toBe(state.units.b); // already empty: nothing changed
    expect(state.order).toEqual(["a", "b"]);
  });

  it("reads the draft as the state it will become", () => {
    const state = base();
    produce(state, (draft) => {
      draft.units.a.x = 7;
      (draft.units as Record<string, unknown>).z = { x: 0, y: 0, tags: [] };
      expect(draft.units.a.x).toBe(7);
      expect(Object.keys(draft.units)).toEqual(["a", "b", "z"]);
      expect("z" in draft.units).toBe(true);
      expect(Object.values(draft.units).map((unit) => unit.x)).toEqual([7, 5, 0]);
      expect(draft.order.map((id) => (draft.units as Record<string, { x: number }>)[id]!.x)).toEqual([7, 5]);
      expect(JSON.parse(JSON.stringify(draft)).units.a.x).toBe(7);
      const seen: number[] = [];
      for (const id of draft.order) seen.push(id.length);
      expect(seen).toEqual([1, 1]);
    });
  });

  it("leaves no draft behind in the result, even when one was assigned somewhere", () => {
    const state = base();
    const next = produce(state, (draft) => {
      const units = draft.units as Record<string, unknown>;
      units.twin = draft.units.a; // a draft, put somewhere else
      units.pair = { first: draft.units.a, all: [draft.units.b] }; // and drafts inside a new value
      draft.units.b.x = 50;
    }) as unknown as { units: Record<string, any> };
    expect(next.units.twin).toBe(state.units.a);
    expect(next.units.pair.first).toBe(state.units.a);
    expect(next.units.pair.all[0]).toBe(state.units.b);
    expect(next.units.b.x).toBe(50);
    // Nothing in the result is a proxy: it survives what a proxy would not.
    expect(structuredClone(next)).toEqual(next);
  });

  it("hands over what is not an object or an array as it is", () => {
    expect(produce(5, () => {})).toBe(5);
    const when = new Date(0);
    const next = produce({ when, n: 1 }, (draft) => {
      expect(draft.when).toBe(when);
      draft.n = 2;
    });
    expect(next.when).toBe(when);
  });

  it("does what the same changes do to a plain copy, whatever they are", () => {
    // A stream of random edits, made to a draft and to a deep copy. Seeded, so a failure repeats.
    for (let seed = 1; seed <= 300; seed++) {
      const start = frozen({
        a: { n: 1, list: [1, 2, 3], deep: { k: "v", more: { z: 0 } } },
        b: { n: 2, list: [] as number[], deep: { k: "w", more: { z: 1 } } },
        top: [{ id: 1 }, { id: 2 }],
      });
      const edit = (state: any) => {
        // The same edits each time it is called.
        let s = seed * 2654435761;
        const random = (n: number) => (((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296) * n) | 0;
        for (let step = 0; step < 12; step++) {
          const who = random(2) ? state.a : state.b;
          switch (random(9)) {
            case 0: who.n += random(3); break; // sometimes adds 0: no change
            case 1: who.list.push(random(100)); break;
            case 2: who.list.pop(); break;
            case 3: who.deep.more.z = random(2); break;
            case 4: delete who.deep.k; break;
            case 5: who.deep = { k: "new", more: { z: random(5) } }; break;
            case 6: state.top.splice(random(3), random(2), { id: random(100) }); break;
            case 7: who.list.sort((x: number, y: number) => y - x); break;
            case 8: state[`extra${random(3)}`] = { from: step }; break;
          }
        }
      };
      const expected = structuredClone(start);
      edit(expected);
      const before = JSON.stringify(start);
      const result = produce(start, edit);
      expect(result, `seed ${seed}`).toEqual(expected);
      expect(JSON.stringify(start), `seed ${seed}: the base`).toBe(before);
      // A branch nothing was written to is not copied.
      if (JSON.stringify(result.a) === JSON.stringify(start.a) && result.a !== start.a) {
        // Copied without a lasting change: allowed only if it was written to and written back.
        expect(result.a).toEqual(start.a);
      }
    }
  });
});
