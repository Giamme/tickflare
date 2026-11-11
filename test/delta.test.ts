import { describe, expect, it, vi } from "vitest";
import { applyPatch, type Patch } from "../src/patch.js";
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
