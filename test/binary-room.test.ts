import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomClient } from "../src/client/index.js";
import { connect, follow, freshRoom, until, type Connection } from "./helpers.js";
import { initialShapes, SCRIPTS, type Holder, type Shapes } from "./shapes.js";
import { WorkerSocket } from "./worker-socket.js";
import type { TickCommand, TickState } from "./worker.js";

const run = (player: Connection, script: string) => void player.raw(JSON.stringify({ t: "cmd", id: 1, data: { script } }));
/** The state after these scripts, as JSON gives it back. */
function after(...scripts: string[]): unknown {
  const room: Holder = { state: initialShapes() };
  for (const script of scripts) SCRIPTS[script]!(room);
  return JSON.parse(JSON.stringify(room.state));
}
/** The next state a player is sent, past the acks of their own commands. */
async function nextState(player: Connection): Promise<unknown> {
  for (;;) {
    const frame = await player.any();
    if (frame.t === "state") return frame.state;
    expect(["ack", "presence"]).toContain(frame.t);
  }
}
/** Joining under this name asks for patches in binary. */
const binary = (player: string) => `${player}&patches=b1`;
const FORGET = 4;

describe("a client that asked for patches in binary", () => {
  it("is sent the same patches as one that did not, as binary messages, and nothing else in binary", async () => {
    const room = freshRoom();
    const plain = await connect(room, "p1", {}, "/shapes");
    await plain.next("welcome");
    const asked = await connect(room, binary("p2"), {}, "/shapes");
    // The welcome and the news of who is here are JSON, as for everyone.
    expect((await asked.next("welcome")).state).toEqual(initialShapes());
    await plain.next("presence");
    expect(asked.binary).toEqual([]);

    const done: string[] = [];
    for (const [index, script] of ["mark", "move", "spawn", "copy", "shuffle", "replace", "remove", "mark"].entries()) {
      run(index % 2 ? plain : asked, script);
      done.push(script);
      expect(await nextState(plain), script).toEqual(after(...done));
      expect(await nextState(asked), script).toEqual(after(...done));
    }
    // Patch for patch the same, apart from which of the two is told that the command was theirs.
    const bare = (frames: typeof plain.patches) => frames.map(({ c: _c, ...frame }) => frame);
    expect(bare(asked.patches)).toEqual(bare(plain.patches));
    expect(asked.patches.length).toBeGreaterThan(5);
    expect(asked.binary).toHaveLength(asked.patches.length);
    expect(plain.binary).toEqual([]);
    // And the player whose command it was is told so in binary too.
    expect(asked.patches.filter((frame) => frame.c !== undefined).length).toBeGreaterThan(0);
    expect(asked.patches.filter((frame) => frame.c !== undefined).length + plain.patches.filter((frame) => frame.c !== undefined).length).toBe(asked.patches.length);
  });

  it("is sent its whole view as JSON when the room no longer knows what it holds, and binary patches after", async () => {
    // A room with a view for each player. What a player holds is known only while the room is in
    // memory, so the first change after a sleep is sent whole, which is never binary.
    const room = freshRoom();
    const asked = await connect(room, binary("p1"));
    await asked.next("welcome");
    asked.command({ type: "add", n: 2 });
    expect(await nextState(asked)).toMatchObject({ total: 2 });
    expect(asked.binary).toHaveLength(1);

    await evictDurableObject(env.ROOMS.get(env.ROOMS.idFromName(room)));
    const start = asked.kinds.length;
    asked.command({ type: "add", n: 1 });
    expect(await nextState(asked)).toMatchObject({ total: 3 });
    asked.command({ type: "add", n: 1 });
    expect(await nextState(asked)).toMatchObject({ total: 4 });
    expect(asked.kinds.slice(start).filter((kind) => kind !== "ack")).toEqual(["state", "patch"]);
    expect(asked.binary).toHaveLength(2);
    expect(asked.binary[1]![1]! & FORGET).toBe(FORGET);
  });

  it("is told to forget its keys, and given them again, after the room has slept", async () => {
    const room = freshRoom();
    const stub = (env.SHAPES as unknown as DurableObjectNamespace).get((env.SHAPES as unknown as DurableObjectNamespace).idFromName(room));
    const asked = await connect(room, binary("p1"), {}, "/shapes");
    await asked.next("welcome");
    run(asked, "move");
    await nextState(asked);
    run(asked, "mark");
    await nextState(asked);
    // The first frame on a connection says to forget; the one after it does not.
    expect(asked.binary.map((frame) => frame[1]! & FORGET)).toEqual([FORGET, 0]);

    await evictDurableObject(stub);
    run(asked, "move");
    expect(await nextState(asked)).toEqual(after("move", "mark", "move"));
    expect(asked.binary.at(-1)![1]! & FORGET).toBe(FORGET);
    run(asked, "mark");
    expect(await nextState(asked)).toEqual(after("move", "mark", "move", "mark"));
    expect(asked.binary.at(-1)![1]! & FORGET).toBe(0);
  });

  it("sees a simulation as everyone else does, each player in their own view, in fewer bytes", async () => {
    const room = freshRoom();
    const plain = await follow<TickState>("/ticks", room, "p1");
    const asked = await follow<TickState>("/ticks", room, binary("p2"));
    await until(() => plain.tick >= 5 && asked.tick >= 5, "five ticks");
    plain.send({ type: "bump" });
    asked.send({ type: "bump" });
    await until(() => plain.state!.bumps === 2 && asked.state!.bumps === 2, "the bumps");
    const from = Math.max(plain.tick, asked.tick);
    await until(() => plain.tick >= from + 20 && asked.tick >= from + 20, "twenty more ticks");

    // Each player's view has their own secret in it and not the other's, so the two are not the
    // same state: compare what both can see.
    const shared = ({ secrets: _secrets, ...rest }: TickState) => rest;
    const tick = Math.min(plain.tick, asked.tick);
    expect(shared(asked.history.get(tick)!)).toEqual(shared(plain.history.get(tick)!));
    expect(Object.keys(asked.state!.secrets)).toEqual(["p2"]);

    // Every tick's patch came in binary, and the frame that showed the bump said so.
    expect(asked.binary).toHaveLength(asked.of("patch").length);
    expect(plain.binary).toEqual([]);
    expect(asked.of("patch").filter((frame) => frame.c !== undefined)).toHaveLength(1);
    expect(asked.of("ack")).toHaveLength(1);
    const ticks = asked.of("patch").filter((frame) => frame.tick > from && frame.tick <= from + 20);
    const sameAsJson = plain.of("patch").filter((frame) => frame.tick > from && frame.tick <= from + 20);
    const jsonBytes = sameAsJson.reduce((sum, frame) => sum + JSON.stringify(frame).length, 0);
    const binaryBytes = asked.binary.slice(-asked.of("patch").length).filter((_, index) => ticks.includes(asked.of("patch")[index]!)).reduce((sum, frame) => sum + frame.length, 0);
    expect(ticks).toHaveLength(sameAsJson.length);
    expect(binaryBytes).toBeLessThan(jsonBytes / 2);
  });
});

describe("a client that says it speaks version 2 of the protocol", () => {
  it("is welcomed in it and sent arrays element by element, in JSON and in binary", async () => {
    const room = freshRoom();
    const first = await connect(room, "p1", {}, "/shapes");
    const second = await connect(room, "p2&v=2", {}, "/shapes");
    const third = await connect(room, "p3&v=2&patches=b1", {}, "/shapes");
    // Each is answered in the version it asked for; one that did not ask, in the first.
    expect((await first.next("welcome")).v).toBe(1);
    expect((await second.next("welcome")).v).toBe(2);
    expect((await third.next("welcome")).v).toBe(2);

    // `spawn` adds a unit and puts its name at the end of `order`.
    run(first, "spawn");
    for (const player of [first, second, third]) expect(await nextState(player), "spawn").toEqual(after("spawn"));
    expect(first.patches.at(-1)!.p.order).toEqual([["a", "b", "c"]]);
    expect(second.patches.at(-1)!.p.order).toEqual([{ 2: ["c"] }, 3]);
    expect(third.patches.at(-1)!.p.order).toEqual([{ 2: ["c"] }, 3]);
    expect(third.binary).toHaveLength(1);

    for (const script of ["copy", "shuffle", "replace", "remove", "mark"]) {
      run(second, script);
      const done = ["spawn", "copy", "shuffle", "replace", "remove", "mark"];
      const state = after(...done.slice(0, done.indexOf(script) + 1));
      for (const player of [first, second, third]) expect(await nextState(player), script).toEqual(state);
    }
  });
});

describe("RoomClient with `binary`", () => {
  const rooms: RoomClient<any, any>[] = [];
  beforeEach(() => {
    WorkerSocket.all = [];
    vi.stubGlobal("WebSocket", WorkerSocket);
  });
  afterEach(() => {
    for (const room of rooms.splice(0)) room.close();
    vi.unstubAllGlobals();
  });
  const play = <View, Command>(path: string, options: { binary?: boolean } = {}) => {
    const room = new RoomClient<View, Command>(`wss://tickflare.test${path}`, options);
    rooms.push(room);
    return room;
  };

  it("asks for binary patches, and ends up with the state a plain client has", async () => {
    const room = freshRoom();
    const plain = play<TickState, TickCommand>(`/ticks/${room}?player=p1`);
    const asked = play<TickState, TickCommand>(`/ticks/${room}?player=p1b`, { binary: true });
    await until(() => plain.state !== undefined && asked.state !== undefined, "the welcomes");
    expect(new URL(WorkerSocket.all[1]!.url).searchParams.get("patches")).toBe("b1");
    expect(new URL(WorkerSocket.all[0]!.url).searchParams.has("patches")).toBe(false);

    await asked.send({ type: "bump" });
    expect(asked.state!.bumps).toBe(1);
    await plain.send({ type: "bump" });
    await until(() => asked.state!.bumps === 2 && asked.tick >= plain.tick, "the second bump");
    // Tick by tick, both see the same count.
    const counts = { plain: new Map<number, number>(), asked: new Map<number, number>() };
    plain.on("state", (state) => counts.plain.set(plain.tick, state.count));
    asked.on("state", (state) => counts.asked.set(asked.tick, state.count));
    const both = () => [...counts.asked.keys()].filter((tick) => counts.plain.has(tick));
    await until(() => both().length >= 10, "ten ticks seen by both");
    for (const tick of both()) expect(counts.asked.get(tick), `tick ${tick}`).toBe(counts.plain.get(tick));
    expect(WorkerSocket.all[1]!.binaryMessages).toBeGreaterThan(10);
    expect(WorkerSocket.all[0]!.binaryMessages).toBe(0);
  });

  it.each([
    ["in JSON", {}],
    ["in binary", { binary: true }],
  ])("asks for version 2, and follows a state full of arrays %s", async (_how, options) => {
    const client = play<Shapes, { script: string }>(`/shapes/${freshRoom()}?player=p1`, options);
    await until(() => client.state !== undefined, "the welcome");
    expect(new URL(WorkerSocket.all[0]!.url).searchParams.get("v")).toBe("2");
    const done: string[] = [];
    for (const script of ["spawn", "copy", "shuffle", "move", "replace", "remove", "mark"]) {
      await client.send({ script });
      done.push(script);
      expect(client.state, script).toEqual(after(...done));
    }
  });

  it("is out of step with the room if a binary frame cannot be read, and starts again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const asked = play<Shapes, { script: string }>(`/shapes/${freshRoom()}?player=p1`, { binary: true });
    await until(() => asked.state !== undefined, "the welcome");
    await asked.send({ script: "mark" });
    // Bytes that are no frame of this format.
    WorkerSocket.all[0]!.deliver(new Uint8Array([0xb1, 0, 9, 9, 0, 1, 77]).buffer);
    await until(() => WorkerSocket.all.length === 2 && asked.status === "open", "a new connection");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    // The new connection starts from a welcome, and its keys from nothing.
    await asked.send({ script: "mark" });
    expect(asked.state).toEqual(after("mark", "mark"));
  });
});
