import { plain } from "../src/server/tracked.js";

/** A state with one of everything a hook might change. */
export interface Shapes {
  units: Record<string, { x: number; tags: string[] }>;
  order: string[];
  meta: { round: number; note: string | null };
  total: number;
}

export const initialShapes = (): Shapes => ({
  units: { a: { x: 1, tags: ["first"] }, b: { x: 2, tags: [] } },
  order: ["a", "b"],
  meta: { round: 0, note: null },
  total: 0,
});

/** Something that holds a state the way a room does: the scripts run against a room and against a plain copy. */
export interface Holder {
  state: Shapes;
}

/** Ways of changing the state, by name. Each is run in a hook by the room, and on a plain copy by the test. */
export const SCRIPTS: Record<string, (room: Holder) => void> = {
  mark: (room) => {
    room.state.total += 1;
  },
  move: (room) => {
    room.state.units.a!.x += 5;
    room.state.meta.round += 1;
  },
  spawn: (room) => {
    const unit = { x: 0, tags: ["new"] };
    room.state.units.c = unit;
    room.state.order.push("c");
    // Still the hook's own object: this write is part of what the hook put in.
    unit.x = 3;
    room.state.units.c.tags.push("seen");
  },
  remove: (room) => {
    delete room.state.units.a;
    room.state.order.splice(room.state.order.indexOf("a"), 1);
  },
  copy: (room) => {
    room.state.units.b = { ...room.state.units.b!, x: 9 };
    room.state.units.b.tags.push("copied");
    room.state.units.d = room.state.units.a!;
  },
  replace: (room) => {
    room.state = { ...room.state, total: 99, order: [...room.state.order].reverse() };
    room.state.meta.note = "replaced";
  },
  shuffle: (room) => {
    room.state.order.push("z", "y");
    room.state.order.sort().reverse();
    room.state.order.length = 3;
    room.state.order.unshift("first");
  },
  everything: (room) => {
    for (const name of ["move", "spawn", "remove", "copy", "shuffle", "replace", "mark"]) SCRIPTS[name]!(room);
  },
  // Changes nothing, though it writes.
  same: (room) => {
    room.state.total = room.state.total + 0;
    room.state.meta.note = null;
    room.state.units.a!.x = 1;
    delete (room.state.units as Record<string, unknown>).nobody;
  },
  nothing: (room) => {
    void room.state.units.a!.tags.length;
  },
  identity: (room) => {
    const a = room.state.units.a!;
    if (a !== room.state.units.a) throw new Error("the same unit read twice is two things");
    const fresh = { x: 7, tags: [] as string[] };
    const list: { x: number; tags: string[] }[] = [];
    (room.state as unknown as { list: unknown[] }).list = list;
    (room.state as unknown as { list: unknown[] }).list.push(fresh);
    if (!(room.state as unknown as { list: unknown[] }).list.includes(fresh)) throw new Error("the new unit is not found");
    delete (room.state as unknown as { list?: unknown[] }).list;
    room.state.total += 1;
  },
  clone: (room) => {
    structuredClone(room.state.units);
    room.state.total += 1;
  },
  plainClone: (room) => {
    const units = structuredClone(plain(room.state.units));
    room.state.total += Object.keys(units).length;
  },
  bigint: (room) => {
    room.state.total += 1;
    (room.state.meta as unknown as { big: unknown }).big = 10n;
  },
};
