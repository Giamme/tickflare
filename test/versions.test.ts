import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { connect, follow, freshRoom, sleep, until } from "./helpers.js";

/** What a player of a ZoneRoom sees. */
interface ZoneView {
  mine: { n: number; v: number } | null;
}

/** How many times the room has built each player's view so far, and the tick it is at. */
async function built(prefix: string, room: string): Promise<{ built: Record<string, number>; tick: number }> {
  const response = await exports.default.fetch(`https://tickflare.test${prefix}/${room}/how?player=p1`);
  return (await response.json()) as { built: Record<string, number>; tick: number };
}

/** Waits until the room has run `ticks` more ticks: a player who is sent nothing cannot tell. */
async function ticksPass(prefix: string, room: string, ticks: number): Promise<void> {
  const start = (await built(prefix, room)).tick;
  for (let waited = 0; (await built(prefix, room)).tick < start + ticks; waited += 10) {
    if (waited > 3000) throw new Error(`Timed out waiting for ${ticks} ticks`);
    await sleep(10);
  }
}

describe("views with versions", () => {
  it("builds and sends a view in a ticking room only when its version changes", async () => {
    const room = freshRoom();
    const p1 = await follow<ZoneView>("/zones", room, "p1");
    const p2 = await follow<ZoneView>("/zones", room, "p2");
    await until(() => p1.state?.mine !== null && p2.state?.mine !== null, "both zones");

    const before = await built("/zones", room);
    const framesBefore = { p1: p1.frames.length, p2: p2.frames.length };
    await ticksPass("/zones", room, 10);
    const idle = await built("/zones", room);
    // Ten ticks and more, and neither view was built again or sent.
    expect(idle.tick).toBeGreaterThanOrEqual(before.tick + 10);
    expect(idle.built).toEqual(before.built);
    expect(p1.of("patch").slice(framesBefore.p1)).toEqual([]);

    p1.send({ type: "poke", zone: "p1" });
    await until(() => p1.state!.mine!.n === 1, "p1's change");
    await sleep(60);
    const poked = await built("/zones", room);
    expect(poked.built.p1).toBe(idle.built.p1! + 1);
    expect(poked.built.p2).toBe(idle.built.p2);
    // p2 was sent nothing but what is not a patch: clock frames, presence.
    expect(p2.frames.slice(framesBefore.p2).filter((frame) => frame.t === "patch" || frame.t === "state")).toEqual([]);
  });

  it("leaves a change out until the version moves, which is the contract", async () => {
    const room = freshRoom();
    const p1 = await follow<ZoneView>("/zones", room, "p1");
    await until(() => p1.state?.mine !== null, "the zone");

    p1.send({ type: "sneak", zone: "p1" });
    await ticksPass("/zones", room, 5);
    expect(p1.state!.mine).toEqual({ n: 0, v: 0 });

    p1.send({ type: "poke", zone: "p1" });
    await until(() => p1.state!.mine!.n === 2, "both changes");
    expect(p1.state!.mine).toEqual({ n: 2, v: 1 });
  });

  it("builds only the views whose version changed in event mode", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, "/eventzones");
    await p1.next("welcome");
    const p2 = await connect(room, "p2", {}, "/eventzones");
    await p2.next("welcome");
    await p1.next("presence");
    await sleep(30);
    p1.kinds.length = 0;
    p2.kinds.length = 0;

    const before = await built("/eventzones", room);
    p1.command({ type: "poke", zone: "p1" } as never);
    const state = await p1.next("state");
    expect(state.state).toMatchObject({ mine: { n: 1, v: 1 } });
    await sleep(30);
    const after = await built("/eventzones", room);
    expect(after.built.p1).toBe(before.built.p1! + 1);
    expect(after.built.p2).toBe(before.built.p2);
    expect(p2.kinds.filter((kind) => kind === "patch" || kind === "state")).toEqual([]);
  });
});
