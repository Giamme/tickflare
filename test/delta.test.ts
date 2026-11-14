import { describe, expect, it, vi } from "vitest";
import { decodePatchFrame, MOST_KEYS } from "../src/binary.js";
import { applyPatch, type Patch } from "../src/patch.js";
import type { PatchFrame } from "../src/protocol.js";
import { DeltaSender } from "../src/server/delta.js";

/** A socket that keeps what it was sent applied, the way RoomClient does. */
class Mirror {
  frames: string[] = [];
  state: unknown;
  readonly ws = { send: (frame: string) => this.#receive(frame) } as unknown as WebSocket;

  constructor(readonly id: string) {}

  #receive(frame: string): void {
    this.frames.push(frame);
    const message = JSON.parse(frame) as { t: string; state?: unknown; p?: Patch };
    this.state = message.t === "state" ? message.state : applyPatch(this.state, message.p!);
  }
}

/** Counts how often something lists the keys of an object: a diff does so once per call. */
function counted<T extends object>(target: T): { value: T; listed: () => number } {
  let listed = 0;
  const value = new Proxy(target, {
    ownKeys(object) {
      listed += 1;
      return Reflect.ownKeys(object);
    },
  });
  return { value, listed: () => listed };
}

describe("DeltaSender with a custom view", () => {
  it("diffs a field that several views share once for everyone who holds the same copy", () => {
    const sender = new DeltaSender();
    const players = [new Mirror("a"), new Mirror("b"), new Mirror("c")];
    const sockets = players.map((player) => ({ ws: player.ws, id: player.id }));
    let world = { units: { u1: { x: 1 } }, turn: 1 };
    const send = (seq: number, shared: object) =>
      sender.send(sockets, seq, seq, undefined, (id) => ({ world: shared, me: { id, seq } }));

    send(1, world);
    world = { units: { u1: { x: 2 } }, turn: 2 };
    send(2, world);

    // Everyone now holds the same copy of the world, so the next change is worked out once.
    const shared = counted({ units: { u1: { x: 3 } }, turn: 3 });
    send(3, shared.value);
    expect(shared.listed()).toBe(1);
    for (const player of players) {
      expect(JSON.parse(player.frames.at(-1)!).p.world).toEqual({ units: { u1: { x: [3] } }, turn: [3] });
      expect(player.state).toEqual({ world: { units: { u1: { x: 3 } }, turn: 3 }, me: { id: player.id, seq: 3 } });
    }
  });

  it("brings in a latecomer and then works their copy out with everyone else's", () => {
    const sender = new DeltaSender();
    const early = new Mirror("early");
    const late = new Mirror("late");
    const view = (shared: object) => (id: string) => ({ world: shared, me: id });

    sender.send([{ ws: early.ws, id: "early" }], 1, 1, undefined, view({ n: 1 }));
    sender.send([{ ws: early.ws, id: "early" }], 2, 2, undefined, view({ n: 2 }));
    const both = [{ ws: early.ws, id: "early" }, { ws: late.ws, id: "late" }];
    sender.send(both, 3, 3, undefined, view({ n: 3 }));
    expect(JSON.parse(late.frames[0]!).t).toBe("state");

    const shared = counted({ n: 4 });
    sender.send(both, 4, 4, undefined, view(shared.value));
    expect(shared.listed()).toBe(1);
    expect(early.state).toEqual({ world: { n: 4 }, me: "early" });
    expect(late.state).toEqual({ world: { n: 4 }, me: "late" });
  });

  it("keeps every client's copy equal to its view through additions, removals and private fields", () => {
    const sender = new DeltaSender();
    const players = ["a", "b", "c", "d"].map((id) => new Mirror(id));
    let units: Record<string, { x: number; path: number[] }> = {};
    let seq = 0;
    for (let round = 0; round < 60; round++) {
      // Units come and go and move; players join in turn; one has an extra field now and then.
      if (round % 3 === 0) units[`u${round}`] = { x: round, path: [round, round + 1] };
      if (round % 7 === 0) delete units[`u${round - 7}`];
      units = Object.fromEntries(Object.entries(units).map(([id, unit]) => [id, { ...unit, x: unit.x + 1 }]));
      const world = { units, round, banner: round % 10 < 5 ? "day" : undefined };
      const present = players.slice(0, 1 + Math.floor(round / 15));
      seq += 1;
      sender.send(present.map((player) => ({ ws: player.ws, id: player.id })), seq, seq, undefined, (id) => ({
        world,
        mine: { id, secret: id === "b" && round % 4 === 0 ? [round] : undefined },
        round,
      }));
      for (const player of present) {
        expect(player.state).toEqual(
          JSON.parse(JSON.stringify({ world, mine: { id: player.id, secret: player.id === "b" && round % 4 === 0 ? [round] : undefined }, round })),
        );
      }
    }
  });

  it("sends nothing to a player whose view did not change", () => {
    const sender = new DeltaSender();
    const player = new Mirror("a");
    const world = { n: 1 };
    sender.send([{ ws: player.ws, id: "a" }], 1, 1, undefined, () => ({ world, me: "a" }));
    sender.send([{ ws: player.ws, id: "a" }], 2, 2, undefined, () => ({ world: { n: 1 }, me: "a" }));
    expect(player.frames).toHaveLength(1);
  });

  it("catches up a player whose view threw once the view works again", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sender = new DeltaSender();
    const ok = new Mirror("ok");
    const flaky = new Mirror("flaky");
    const sockets = [{ ws: ok.ws, id: "ok" }, { ws: flaky.ws, id: "flaky" }];
    sender.send(sockets, 1, 1, undefined, (id) => ({ n: 1, id }));
    sender.send(sockets, 2, 2, undefined, (id) => {
      if (id === "flaky") throw new Error("broken view");
      return { n: 2, id };
    });
    expect(ok.state).toEqual({ n: 2, id: "ok" });
    expect(flaky.state).toEqual({ n: 1, id: "flaky" });

    sender.send(sockets, 3, 3, undefined, (id) => ({ n: 3, id }));
    expect(flaky.state).toEqual({ n: 3, id: "flaky" });
    expect(JSON.parse(flaky.frames.at(-1)!).t).toBe("patch");
    error.mockRestore();
  });

  it("falls back to whole-view diffs for a view that is not an object", () => {
    const sender = new DeltaSender();
    const player = new Mirror("a");
    sender.send([{ ws: player.ws, id: "a" }], 1, 1, undefined, () => [1, 2]);
    sender.send([{ ws: player.ws, id: "a" }], 2, 2, undefined, () => [1, 2, 3]);
    expect(player.state).toEqual([1, 2, 3]);
  });
});

describe("DeltaSender and sockets that asked for binary", () => {
  /** A socket whose client reads binary frames, with the keys it has been told. */
  class BinaryMirror {
    frames: (string | Uint8Array)[] = [];
    patches: PatchFrame[] = [];
    state: unknown;
    keys: string[] = [];
    readonly ws = { send: (frame: string | Uint8Array) => this.#receive(frame) } as unknown as WebSocket;

    #receive(frame: string | Uint8Array): void {
      this.frames.push(frame);
      const message = typeof frame === "string" ? (JSON.parse(frame) as { t: string; state?: unknown; p?: Patch }) : decodePatchFrame(frame, this.keys);
      if (message.t === "patch") this.patches.push(message as PatchFrame);
      this.state = message.t === "state" ? message.state : applyPatch(this.state, message.p!);
    }
    get binary(): Uint8Array[] {
      return this.frames.filter((frame): frame is Uint8Array => typeof frame !== "string");
    }
  }

  it("encodes a patch once for all of them, and once in JSON for the rest", () => {
    const sender = new DeltaSender();
    const plain = new Mirror("plain");
    const first = new BinaryMirror();
    const second = new BinaryMirror();
    const sockets = [{ ws: plain.ws, id: "plain" }, { ws: first.ws, id: "first", binary: true }, { ws: second.ws, id: "second", binary: true }];
    let state = { units: { a: { x: 1 } }, round: 1 };
    sender.send(sockets, 1, 1, state, undefined);
    for (let seq = 2; seq <= 5; seq++) {
      state = { units: { a: { x: seq }, [`n${seq}`]: { x: 0 } }, round: seq };
      sender.send(sockets, seq, seq, state, undefined);
    }
    for (const mirror of [plain, first, second]) expect(mirror.state).toEqual(state);
    // The whole state first, in JSON, to everyone. Then patches: binary to those who asked.
    expect(first.frames.map((frame) => typeof frame)).toEqual(["string", "object", "object", "object", "object"]);
    expect(plain.frames.every((frame) => typeof frame === "string")).toBe(true);
    // The two that asked hold the same keys and, from the second patch on, are sent the same bytes.
    expect(second.keys).toEqual(first.keys);
    expect(second.binary.at(-1)).toEqual(first.binary.at(-1));
    expect(first.patches).toEqual(plain.frames.slice(1).map((frame) => JSON.parse(frame)));
  });

  it("starts the key table again once it is full, without a client noticing", () => {
    const sender = new DeltaSender();
    const client = new BinaryMirror();
    const sockets = [{ ws: client.ws, id: "a", binary: true }];
    let state: Record<string, number> = {};
    sender.send(sockets, 0, 0, state, undefined);
    // Each change brings three thousand names never seen before: the table fills in three.
    const forgets: number[] = [];
    for (let seq = 1; seq <= 8; seq++) {
      state = Object.fromEntries(Array.from({ length: 3000 }, (_, n) => [`s${seq}k${n}`, n]));
      sender.send(sockets, seq, seq, state, undefined);
      expect(client.state, `change ${seq}`).toEqual(state);
      forgets.push(client.binary.at(-1)![1]! & 4);
      expect(client.keys.length).toBeLessThanOrEqual(MOST_KEYS);
    }
    // Told to forget on its first frame, and again each time the table was started over.
    expect(forgets[0]).toBe(4);
    expect(forgets.slice(1).filter((flag) => flag === 4).length).toBeGreaterThanOrEqual(2);
    expect(forgets.slice(1).filter((flag) => flag === 0).length).toBeGreaterThanOrEqual(2);
  });

  it("sends a frame in JSON when it cannot be said in binary, and the client reads it all the same", () => {
    const sender = new DeltaSender();
    const client = new BinaryMirror();
    const sockets = [{ ws: client.ws, id: "a", binary: true }];
    sender.send(sockets, 0, 0, { n: 0 }, undefined);
    // A command numbered with something that is not a whole number: `c` has no binary form.
    sender.send(sockets, 1, 0, { n: 1 }, undefined, true, new Map([[client.ws, 1.5]]));
    expect(typeof client.frames.at(-1)).toBe("string");
    expect(client.patches.at(-1)).toEqual({ t: "patch", seq: 1, tick: 0, from: 0, c: 1.5, p: { n: [1] } });
    // The next one is binary, and the keys it needs are all there.
    sender.send(sockets, 2, 0, { n: 2, m: 1 }, undefined, true, new Map([[client.ws, 7]]));
    expect(typeof client.frames.at(-1)).toBe("object");
    expect(client.patches.at(-1)).toEqual({ t: "patch", seq: 2, tick: 0, from: 1, c: 7, p: { n: [2], m: [1] } });
    expect(client.state).toEqual({ n: 2, m: 1 });
  });

  it("sends each player their own view in binary, with the names shared between them", () => {
    const sender = new DeltaSender();
    const players = { a: new BinaryMirror(), b: new BinaryMirror() };
    const sockets = Object.entries(players).map(([id, mirror]) => ({ ws: mirror.ws, id, binary: true }));
    for (let seq = 1; seq <= 6; seq++) {
      const world = { units: { u1: { x: seq, y: seq * 1.5 } }, turn: seq };
      sender.send(sockets, seq, seq, undefined, (id) => ({ world, hand: { [id]: seq % 3 } }));
      expect(players.a.state).toEqual({ world, hand: { a: seq % 3 } });
      expect(players.b.state).toEqual({ world, hand: { b: seq % 3 } });
    }
    expect(players.a.binary).toHaveLength(5);
    // One table: each was told the other's private key too, and holds it at the same number.
    expect(players.a.keys).toEqual(players.b.keys);
    expect(players.a.keys).toEqual(expect.arrayContaining(["a", "b", "world", "hand"]));
  });
});
