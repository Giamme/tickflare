import { describe, expect, it } from "vitest";
import { decodePatchFrame, encodePatch, encodePatchFrame, KeyTable, MOST_KEYS } from "../src/binary.js";
import { applyPatch, diff, type Patch } from "../src/patch.js";
import type { PatchFrame } from "../src/protocol.js";
import vectors from "./vectors/binary-patches.json";

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const unhex = (text: string) => new Uint8Array((text.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));

/** One socket's side of a room: what it has been told of the room's key table, and the keys its client holds. */
function socket(table: KeyTable, told?: { generation: number; known: number }) {
  const keys: string[] = [];
  return {
    keys,
    /** The frame the room would send this socket, and what its client reads from it. */
    send(frame: Omit<PatchFrame, "t">): { bytes: Uint8Array; read: PatchFrame } {
      table.renew();
      const patch = encodePatch(frame.p, table);
      const forget = told === undefined || told.generation !== table.generation;
      const bytes = encodePatchFrame(frame, table, forget ? 0 : told!.known, forget, patch);
      told = { generation: table.generation, known: table.size };
      return { bytes, read: decodePatchFrame(bytes, keys) };
    },
  };
}
const roundTrip = (p: Patch) => socket(new KeyTable()).send({ seq: 1, tick: 1, p }).read.p;

describe("binary patches", () => {
  it("say what the JSON frame says, in a fraction of the bytes", () => {
    const client = socket(new KeyTable());
    const frame: Omit<PatchFrame, "t"> = {
      seq: 310,
      tick: 300,
      p: { units: { u17: { x: [104.5], y: [88] }, u18: { x: [-3.25], hp: [0] }, u3: 0 }, phase: ["over"] },
    };
    const first = client.send(frame);
    expect(first.read).toEqual({ t: "patch", ...frame });
    // The names travel once. The second frame of the same shape is numbers only.
    const second = client.send({ ...frame, seq: 311, tick: 301 });
    expect(second.read).toEqual({ t: "patch", ...frame, seq: 311, tick: 301 });
    const json = JSON.stringify({ t: "patch", ...frame }).length;
    expect(json).toBe(132);
    expect(first.bytes.length).toBe(70);
    expect(second.bytes.length).toBe(40);
  });

  it("carry `from` and `c` when the JSON frame would", () => {
    const client = socket(new KeyTable());
    expect(client.send({ seq: 5, tick: 0, from: 4, c: 12, p: { a: [1] } }).read).toEqual({ t: "patch", seq: 5, tick: 0, from: 4, c: 12, p: { a: [1] } });
    expect(client.send({ seq: 6, tick: 0, from: 0, p: {} }).read).toEqual({ t: "patch", seq: 6, tick: 0, from: 0, p: {} });
    expect(client.send({ seq: 7, tick: 9, c: 0, p: {} }).read).toEqual({ t: "patch", seq: 7, tick: 9, c: 0, p: {} });
  });

  it("give back every number exactly, in as few bytes as it takes", () => {
    const sizeOf = (n: number) => encodePatch({ k: [n] }, new KeyTable()).length - 2; // less the count and the key
    const numbers: [number, number][] = [
      [0, 2], [1, 2], [127, 2], [128, 3], [-1, 2], [-300, 3], [16383, 3], [16384, 4],
      [0.5, 2], [12.7, 2], [12.8, 3], [-0.1, 2], [104.5, 3], [1638.3, 3], // tenths
      [0.25, 2], [-3.14, 3], [99.99, 3], // hundredths
      [0.125, 9], [1 / 3, 9], [0.1 + 0.2, 9], [1e300, 9], [-0, 9], [2 ** 53, 9], [1e15 + 0.5, 9], // as they are
      [Number.MAX_SAFE_INTEGER, 9], [-Number.MAX_SAFE_INTEGER, 9],
    ];
    for (const [n, size] of numbers) {
      const back = (roundTrip({ k: [n] }).k as [number])[0];
      expect(Object.is(back, n), `${n} came back as ${back}`).toBe(true);
      expect(sizeOf(n), `bytes for ${n}`).toBe(size);
    }
    // A sweep of the numbers games send: positions to one and two places, either side of zero.
    for (let i = -20_000; i <= 20_000; i += 7) {
      for (const n of [i / 10, i / 100, i * 1.37]) {
        expect(Object.is((roundTrip({ k: [n] }).k as [number])[0], n), String(n)).toBe(true);
      }
    }
  });

  it("carry any value a state can hold", () => {
    const value = {
      text: "día — 日本 — 🚀",
      empty: "",
      flags: [true, false, null],
      nested: { list: [1, [2, [3]], { deep: { deeper: [] as unknown[] } }], none: {} },
      // A key named __proto__ is a key like any other, as it is to JSON.parse.
      ...(JSON.parse('{"__proto__":{"own":1}}') as object),
      "": "a key with no name",
      [`a key longer than sixty-four characters is sent in full each time ${"x".repeat(40)}`]: 1,
    };
    expect(Object.keys(value)).toContain("__proto__");
    const back = roundTrip({ v: [value], gone: 0, into: { "a.b": { c: [value.text] } } });
    expect(back).toEqual({ v: [value], gone: 0, into: { "a.b": { c: [value.text] } } });
    expect(JSON.stringify(back)).toBe(JSON.stringify({ v: [value], gone: 0, into: { "a.b": { c: [value.text] } } }));
    // As JSON does: undefined is left out of an object and is null in an array.
    expect(roundTrip({ v: [{ a: undefined, b: [undefined, 1] }] })).toEqual({ v: [{ b: [null, 1] }] });
    expect(() => encodePatch({ v: [Number.NaN] }, new KeyTable())).toThrow();
    expect(() => encodePatch({ v: [10n] } as unknown as Patch, new KeyTable())).toThrow();
  });

  it("do to a state what the JSON patch does, over a long run of changes", () => {
    // A world that changes at random, sent to one client in JSON and to one in binary.
    let seed = 99;
    const random = (n: number) => Math.floor(((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296) * n);
    type World = { units: Record<string, { x: number; y: number; hp: number; tags?: string[] }>; round: number; note: string | null };
    let world: World = { units: {}, round: 0, note: null };
    let viaJson = structuredClone(world);
    let viaBinary = structuredClone(world);
    const client = socket(new KeyTable());
    let jsonBytes = 0;
    let binaryBytes = 0;
    for (let tick = 1; tick <= 400; tick++) {
      const next = structuredClone(world);
      for (let change = random(6); change >= 0; change--) {
        const id = `u${random(30)}`;
        const unit = next.units[id];
        const kind = random(10);
        if (!unit) next.units[id] = { x: random(10_000) / 10, y: random(10_000) / 10, hp: 100 };
        else if (kind < 6) Object.assign(unit, { x: Math.round((unit.x + random(100) / 10 - 5) * 10) / 10, y: unit.y + random(7) - 3 });
        else if (kind === 6) unit.hp -= random(30);
        else if (kind === 7) unit.tags = [...(unit.tags ?? []), `t${random(5)}`];
        else if (kind === 8) delete next.units[id];
        else next.note = random(2) ? null : `note ${random(1000)}`;
      }
      next.round = tick;
      const patch = diff(world, next) as Patch;
      world = next;
      const json = JSON.stringify({ t: "patch", seq: tick, tick, p: patch });
      jsonBytes += json.length;
      viaJson = applyPatch(viaJson, (JSON.parse(json) as PatchFrame).p);
      const sent = client.send({ seq: tick, tick, p: patch });
      binaryBytes += sent.bytes.length;
      expect(sent.read, `tick ${tick}`).toEqual(JSON.parse(json));
      viaBinary = applyPatch(viaBinary, sent.read.p);
    }
    expect(viaBinary).toEqual(world);
    expect(viaBinary).toEqual(viaJson);
    expect(binaryBytes / jsonBytes).toBeLessThan(0.4);
  });

  describe("the key table", () => {
    it("is one for the room: each socket is told, once, the names it has not been told", () => {
      const table = new KeyTable();
      const early = socket(table);
      early.send({ seq: 1, tick: 1, p: { units: { a: { x: [1] } } } });
      expect(early.keys).toEqual(["units", "a", "x"]);

      // A socket that joins later is told everything in its first frame, and both go on from there.
      const late = socket(table);
      const patch: Patch = { units: { b: { x: [2], y: [3] } } };
      const toEarly = early.send({ seq: 2, tick: 2, p: patch });
      const toLate = late.send({ seq: 2, tick: 2, p: patch });
      expect(toEarly.read.p).toEqual(patch);
      expect(toLate.read.p).toEqual(patch);
      expect(early.keys).toEqual(["units", "a", "x", "b", "y"]);
      expect(late.keys).toEqual(early.keys);
      expect(toLate.bytes.length).toBeGreaterThan(toEarly.bytes.length);
      // From now on the two are sent the very same bytes.
      expect(hex(late.send({ seq: 3, tick: 3, p: patch }).bytes)).toBe(hex(early.send({ seq: 3, tick: 3, p: patch }).bytes));
    });

    it("lets a socket that was sent nothing for a while catch up on the names since", () => {
      const table = new KeyTable();
      const busy = socket(table);
      const idle = socket(table);
      idle.send({ seq: 1, tick: 1, p: { a: [1] } });
      for (let n = 2; n < 6; n++) busy.send({ seq: n, tick: n, p: { [`k${n}`]: [n] } });
      expect(idle.send({ seq: 6, tick: 6, p: { k5: [0], a: [2], fresh: [3] } }).read.p).toEqual({ k5: [0], a: [2], fresh: [3] });
      expect(idle.keys).toEqual(["a", "k2", "k3", "k4", "k5", "fresh"]);
    });

    it("starts again when it is full, and tells every socket to forget", () => {
      const table = new KeyTable();
      const client = socket(table);
      const many: Patch = {};
      for (let n = 0; n < MOST_KEYS + 50; n++) many[`id${n}`] = [n];
      // More names than the table holds in one frame: the rest are spelled out, and still arrive.
      expect(client.send({ seq: 1, tick: 1, p: many }).read.p).toEqual(many);
      expect(table.size).toBe(MOST_KEYS);
      expect(client.keys).toHaveLength(MOST_KEYS);

      const before = table.generation;
      const next = client.send({ seq: 2, tick: 2, p: { id3: [0], other: [1] } });
      expect(table.generation).toBe(before + 1);
      expect(next.read.p).toEqual({ id3: [0], other: [1] });
      expect(client.keys).toEqual(["id3", "other"]);
      // A socket that knew the old table and hears of the new one for the first time.
      const other = socket(table);
      expect(other.send({ seq: 3, tick: 3, p: { other: [2] } }).read.p).toEqual({ other: [2] });
      expect(other.keys).toEqual(["id3", "other"]);
    });
  });

  it("refuse bytes that are not a frame, rather than guess", () => {
    const table = new KeyTable();
    const good = encodePatchFrame({ seq: 1, tick: 1 }, table, 0, true, encodePatch({ units: { a: { x: [1.5] } } }, table));
    expect(decodePatchFrame(good, []).p).toEqual({ units: { a: { x: [1.5] } } });
    // Cut short anywhere, it is refused.
    for (let length = 0; length < good.length; length++) {
      expect(() => decodePatchFrame(good.slice(0, length), []), `cut at ${length}`).toThrow(RangeError);
    }
    expect(() => decodePatchFrame(new Uint8Array([...good, 0]), [])).toThrow(/longer/);
    expect(() => decodePatchFrame(new Uint8Array([0x7b, ...good.slice(1)]), [])).toThrow(/not a binary patch/);
    // A key number nobody defined: the client is out of step with the room.
    const second = encodePatchFrame({ seq: 2, tick: 2 }, table, table.size, false, encodePatch({ units: [0] }, table));
    expect(() => decodePatchFrame(second, [])).toThrow(/never defined/);
    // A kind of value from some later version.
    expect(() => decodePatchFrame(new Uint8Array([0xb1, 0, 1, 1, 0, 1, 0, 1, 0x61, 0x3f]), [])).toThrow(/does not know/);
    // A number that goes on and on.
    expect(() => decodePatchFrame(new Uint8Array([0xb1, 0, ...Array<number>(12).fill(0xff)]), [])).toThrow(RangeError);
  });

  it("is what the published test vectors say it is", () => {
    // The vectors are for people writing a client in another language. Each is a connection:
    // frames in the order they were sent, as hex, and what each one means.
    expect(vectors.length).toBeGreaterThanOrEqual(8);
    for (const vector of vectors as (typeof vectors[number] & { tableBefore?: string[]; keysOfAnEarlierTable?: number })[]) {
      // Two of them start from a room that has been running: its table has keys already, or has
      // been started again since this socket was last sent anything.
      const table = new KeyTable();
      if (vector.tableBefore) encodePatch(Object.fromEntries(vector.tableBefore.map((key) => [key, 0])), table);
      const stale = vector.keysOfAnEarlierTable;
      const client = socket(table, stale === undefined ? undefined : { generation: -1, known: stale });
      const keys: string[] = [];
      for (const [index, step] of vector.frames.entries()) {
        const frame = step.frame as unknown as PatchFrame;
        expect(hex(client.send(frame).bytes), `${vector.name}, frame ${index}: encoding`).toBe(step.hex);
        expect(decodePatchFrame(unhex(step.hex), keys), `${vector.name}, frame ${index}: decoding`).toEqual(frame);
        expect(keys, `${vector.name}, frame ${index}: keys`).toEqual(step.keys);
      }
    }
  });
});
