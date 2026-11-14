import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { connect, freshRoom, twoPlayers, type Connection } from "./helpers.js";
import { initialShapes, SCRIPTS, type Holder } from "./shapes.js";

const run = (player: Connection, script: string) => void player.raw(JSON.stringify({ t: "cmd", id: 1, data: { script } }));

function after(...scripts: string[]): unknown {
  const room: Holder = { state: initialShapes() };
  for (const script of scripts) SCRIPTS[script]!(room);
  return JSON.parse(JSON.stringify(room.state));
}

// Outside the simulation every change is sent as it is made. It used to be sent as the whole
// view; it is sent as what changed in it.
describe.each([
  ["following a hook's writes", "/shapes", () => env.SHAPES as unknown as DurableObjectNamespace],
  ["comparing the whole state", "/plain", () => env.PLAIN as unknown as DurableObjectNamespace],
])("a change in event mode, without a custom view, %s", (_mode, prefix, rooms) => {
  it("is sent as a patch of the state before it, holding only what changed", async () => {
    const p1 = await connect(freshRoom(), "p1", {}, prefix);
    await p1.next("welcome");

    run(p1, "move");
    expect((await p1.next("state")).state).toEqual(after("move"));
    run(p1, "remove");
    expect((await p1.next("ack")).seq).toBe(1);
    expect((await p1.next("state")).state).toEqual(after("move", "remove"));
    await p1.next("ack");

    expect(p1.kinds).toEqual(["welcome", "patch", "ack", "patch", "ack"]);
    expect(p1.patches).toEqual([
      { t: "patch", seq: 1, tick: 0, from: 0, p: { units: { a: { x: [6] } }, meta: { round: [1] } } },
      { t: "patch", seq: 2, tick: 0, from: 1, p: { units: { a: 0 }, order: [["b"]] } },
    ]);
  });

  it("reaches a player who joined after earlier changes as a patch of what they were welcomed with", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, prefix);
    await p1.next("welcome");
    run(p1, "move");
    await p1.next("state");
    await p1.next("ack");

    const p2 = await connect(room, "p2", {}, prefix);
    expect(await p2.next("welcome")).toMatchObject({ seq: 1, state: after("move") });
    await p1.next("presence");
    run(p1, "mark");

    for (const player of [p1, p2]) {
      expect((await player.next("state")).state).toEqual(after("move", "mark"));
      expect(player.patches.at(-1)).toEqual({ t: "patch", seq: 2, tick: 0, from: 1, p: { total: [1] } });
    }
  });

  it("is still a patch after the room has been out of memory, where it kept what each player holds", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, prefix);
    await p1.next("welcome");
    const p2 = await connect(room, "p2", {}, prefix);
    await p2.next("welcome");
    await p1.next("presence");
    run(p1, "spawn");
    await p1.next("state");
    await p1.next("ack");
    await p2.next("state");

    // What hibernation does: the room is gone from memory, and the connections stay.
    await evictDurableObject(rooms().get(rooms().idFromName(room)));
    run(p2, "mark");

    for (const player of [p1, p2]) {
      expect((await player.next("state")).state).toEqual(after("spawn", "mark"));
      expect(player.patches.at(-1)).toEqual({ t: "patch", seq: 2, tick: 0, from: 1, p: { total: [1] } });
    }
  });

  it("is sent whole when it replaces the state with something that cannot be patched into", async () => {
    const p1 = await connect(freshRoom(), "p1", {}, prefix);
    await p1.next("welcome");
    run(p1, "replace");
    expect((await p1.next("state")).state).toEqual(after("replace"));
    // Still a patch: both are objects, and only what differs is in it.
    expect(p1.patches.at(-1)!.p).toEqual({ total: [99], order: [["b", "a"]], meta: { note: ["replaced"] } });
  });
});

describe("a change in event mode, with a custom view", () => {
  it("is sent as a patch of the view each player was last sent", async () => {
    const { p1, p2 } = await twoPlayers();
    const start = p1.kinds.length;
    p1.command({ type: "add", n: 2 });
    const frame = await p1.next("state");
    expect(frame.state.total).toBe(2);
    await p2.next("state");

    expect(p1.kinds.slice(start)).toEqual(["patch"]);
    expect(p1.patches.at(-1)).toMatchObject({ seq: frame.seq, from: frame.seq - 1, p: { total: [2] } });
    expect(p2.patches.at(-1)).toMatchObject({ seq: frame.seq, from: frame.seq - 1, p: { total: [2] } });
  });

  it("is sent whole once after the room has been out of memory, and as a patch again from then on", async () => {
    const { room, p1, p2 } = await twoPlayers();
    p1.command({ type: "secret", value: "mine" });
    await p1.next("state");
    await p1.next("ack");

    // What a player was sent is known only for as long as the room is in memory: a view can
    // depend on more than the state, so it cannot be worked out again afterwards.
    await evictDurableObject(env.ROOMS.get(env.ROOMS.idFromName(room)));
    const start = p1.kinds.length;
    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state).toMatchObject({ total: 1, secrets: { p1: "mine" } });
    expect((await p2.next("state")).state).toMatchObject({ total: 1, secrets: {} });
    await p1.next("ack");
    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state).toMatchObject({ total: 2, secrets: { p1: "mine" } });

    expect(p1.kinds.slice(start)).toEqual(["state", "ack", "patch"]);
  });
});
