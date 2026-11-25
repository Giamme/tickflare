import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRejected, RoomClient } from "../src/client/index.js";
import { PROTOCOL_VERSION } from "../src/protocol.js";
import { connect, follow, freshRoom, sleep, until, type Connection } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";
import type { TestCommand, TestState, TickState } from "./worker.js";

/**
 * Protocol version 5: a client that names itself is told, when it connects
 * again, which of its commands the room has handled. It sends the others
 * again, and the room applies none of them twice.
 */

/** Connects as a client of version 5 that goes by `client`. */
const named = (room: string, player: string, client: string, prefix = "/rooms") =>
  connect(room, `${player}&v=5&client=${client}`, {}, prefix);
/** Sends a command under an id of the test's choosing, as a client that sends one again does. */
const send = (to: Connection, id: number, data: TestCommand) => to.raw(JSON.stringify({ t: "cmd", id, data }));
/** What the room's row says was handled. */
const stored = (stub: DurableObjectStub) =>
  runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ handled: string }>("SELECT handled FROM tickflare_room").one().handled);
const rooms = (room: string) => env.ROOMS.get(env.ROOMS.idFromName(room));

describe("a room and a client that names itself", () => {
  it("says nothing of earlier commands when the seat is new, and how far it got when the client is back", async () => {
    const room = freshRoom();
    const first = await named(room, "p1", "abc");
    const welcome = await first.next("welcome");
    expect(welcome.v).toBe(PROTOCOL_VERSION);
    expect("c" in welcome).toBe(false);

    send(first, 1, { type: "add", n: 5 });
    expect((await first.next("state")).state.total).toBe(5);
    expect(await first.next("ack")).toMatchObject({ id: 1 });

    const back = await named(room, "p1", "abc");
    const again = await back.next("welcome");
    expect(again.c).toBe(1);
    expect("refused" in again).toBe(false);
    expect(again.state.total).toBe(5);
  });

  it("answers a command that is sent again, without applying it twice, and applies the ones that never arrived", async () => {
    const room = freshRoom();
    const first = await named(room, "p1", "abc");
    await first.next("welcome");
    send(first, 1, { type: "add", n: 5 });
    await first.next("state");
    const { seq } = await first.next("ack");

    const back = await named(room, "p1", "abc");
    expect((await back.next("welcome")).c).toBe(1);
    // The answer to 1 never arrived, as far as the client can tell: it would not send it again
    // after this welcome, but a room must not mind if one does.
    send(back, 1, { type: "add", n: 5 });
    expect(await back.next("ack")).toEqual({ t: "ack", id: 1, seq });
    // 2 was lost with the connection, and is new to the room.
    send(back, 2, { type: "add", n: 1 });
    expect((await back.next("state")).state.total).toBe(6);
    expect(await back.next("ack")).toMatchObject({ id: 2 });
  });

  it("remembers what it refused, and why", async () => {
    const room = freshRoom();
    const first = await named(room, "p1", "abc");
    await first.next("welcome");
    send(first, 1, { type: "add", n: 5 });
    await first.next("state");
    await first.next("ack");
    send(first, 2, { type: "half" });
    expect(await first.next("reject")).toEqual({ t: "reject", id: 2, reason: "changed_my_mind" });
    send(first, 3, { type: "add", n: "x" } as unknown as TestCommand);
    expect(await first.next("reject")).toEqual({ t: "reject", id: 3, reason: "n_must_be_a_number" });

    const back = await named(room, "p1", "abc");
    const welcome = await back.next("welcome");
    expect(welcome.c).toBe(3);
    expect(welcome.refused).toEqual([
      [2, "changed_my_mind"],
      [3, "n_must_be_a_number"],
    ]);
    send(back, 2, { type: "half" });
    expect(await back.next("reject")).toEqual({ t: "reject", id: 2, reason: "changed_my_mind" });
    expect(welcome.state.total).toBe(5);
  });

  it("keeps the reasons of the last eight refusals", async () => {
    const room = freshRoom();
    const first = await named(room, "p1", "abc");
    await first.next("welcome");
    for (let id = 1; id <= 10; id++) {
      send(first, id, { type: "half" });
      await first.next("reject");
    }
    const back = await named(room, "p1", "abc");
    const welcome = await back.next("welcome");
    expect(welcome.c).toBe(10);
    expect(welcome.refused!.map(([id]) => id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("tells another client of the same player nothing, and then the first one nothing either", async () => {
    const room = freshRoom();
    const first = await named(room, "p1", "abc");
    await first.next("welcome");
    send(first, 1, { type: "add", n: 5 });
    await first.next("state");
    await first.next("ack");

    // The page was loaded again, say: a client that counts from 1 once more.
    const other = await named(room, "p1", "xyz");
    expect("c" in (await other.next("welcome"))).toBe(false);
    send(other, 1, { type: "add", n: 1 });
    expect((await other.next("state")).state.total).toBe(6);
    await other.next("ack");

    // The room remembers one client a seat. The first one, back again, is not it any more.
    const back = await named(room, "p1", "abc");
    expect("c" in (await back.next("welcome"))).toBe(false);
    // And the other, back after that, is not either.
    const last = await named(room, "p1", "xyz");
    expect("c" in (await last.next("welcome"))).toBe(false);
  });

  it("starts over when the seat is given up and taken again", async () => {
    const room = freshRoom();
    const first = await named(room, "p1", "abc");
    await first.next("welcome");
    send(first, 1, { type: "add", n: 5 });
    await first.next("state");
    await first.next("ack");
    first.raw(JSON.stringify({ t: "leave", id: 2 }));
    await first.closed;

    const back = await named(room, "p1", "abc");
    expect("c" in (await back.next("welcome"))).toBe(false);
    // The same numbers again, to a new seat: they are new commands.
    send(back, 1, { type: "add", n: 1 });
    expect((await back.next("state")).state.total).toBe(6);
    expect(await back.next("ack")).toMatchObject({ id: 1 });
  });

  it("says nothing to a client that did not name itself, named itself badly or speaks an older version", async () => {
    const room = freshRoom();
    const plain = await connect(room, "p1&v=5");
    expect(await plain.next("welcome")).toMatchObject({ v: 5 });
    plain.command({ type: "add", n: 1 });
    await plain.next("state");
    await plain.next("ack");
    for (const asked of ["p1&v=5", `p1&v=5&client=${"x".repeat(65)}`, "p1&v=5&client=a%20b", "p1&v=4&client=abc"]) {
      const back = await connect(room, asked);
      const welcome = await back.next("welcome");
      expect("c" in welcome, asked).toBe(false);
      // Its commands are applied as they come, whatever their number.
      back.command({ type: "add", n: 1 });
      await back.next("state");
      expect(await back.next("ack")).toMatchObject({ id: 1 });
    }
    expect(await stored(rooms(room))).toBe("");
  });

  it("knows a client it has only been connected to, after it has slept", async () => {
    const room = freshRoom();
    // The seat is taken by a client of the old kind, then the page is loaded again with a new one.
    const old = await connect(room, "p1");
    await old.next("welcome");
    const first = await named(room, "p1", "abc");
    expect("c" in (await first.next("welcome"))).toBe(false);
    expect(JSON.parse(await stored(rooms(room)))).toEqual({ p1: ["abc", 0] });

    await evictDurableObject(rooms(room));
    // Its first command was lost on the way, and the connection with it.
    const back = await named(room, "p1", "abc");
    expect((await back.next("welcome")).c).toBe(0);
    send(back, 1, { type: "add", n: 5 });
    expect((await back.next("state")).state.total).toBe(5);
  });

  it("saves what it handled with the state, so that it knows after it has slept", async () => {
    const room = freshRoom();
    const first = await named(room, "p1", "abc");
    await first.next("welcome");
    // A seat taken by a client that names itself is saved with its name.
    expect(JSON.parse(await stored(rooms(room)))).toEqual({ p1: ["abc", 0] });
    send(first, 1, { type: "add", n: 5 });
    await first.next("state");
    await first.next("ack");
    send(first, 2, { type: "half" });
    await first.next("reject");
    // A command that changed nothing is not worth a row: it is saved with the next that does.
    expect(JSON.parse(await stored(rooms(room)))).toEqual({ p1: ["abc", 1] });
    send(first, 3, { type: "add", n: 1 });
    await first.next("state");
    await first.next("ack");
    expect(JSON.parse(await stored(rooms(room)))).toEqual({ p1: ["abc", 3, [[2, "changed_my_mind"]]] });

    await evictDurableObject(rooms(room));
    const back = await named(room, "p1", "abc");
    const welcome = await back.next("welcome");
    expect(welcome).toMatchObject({ c: 3, refused: [[2, "changed_my_mind"]] });
    send(back, 3, { type: "add", n: 1 });
    expect(await back.next("ack")).toMatchObject({ id: 3 });
    send(back, 4, { type: "add", n: 1 });
    expect((await back.next("state")).state.total).toBe(7);
  });

  it("forgets the clients of seats that were given up", async () => {
    const room = freshRoom();
    const p1 = await named(room, "p1", "abc");
    await p1.next("welcome");
    const p2 = await named(room, "p2", "def");
    await p2.next("welcome");
    expect(JSON.parse(await stored(rooms(room)))).toEqual({ p1: ["abc", 0], p2: ["def", 0] });
    p2.raw(JSON.stringify({ t: "leave", id: 1 }));
    await p2.closed;
    send(p1, 1, { type: "add", n: 1 });
    await until(() => p1.kinds.includes("ack"), "the answer");
    expect(JSON.parse(await stored(rooms(room)))).toEqual({ p1: ["abc", 1] });
  });

  it("gives a room saved before version 5 the column it lacks", async () => {
    const room = freshRoom();
    const old = await connect(room, "p1");
    await old.next("welcome");
    old.command({ type: "add", n: 5 });
    await old.next("state");
    await old.next("ack");
    await runInDurableObject(rooms(room), (_instance, state) => {
      state.storage.sql.exec("ALTER TABLE tickflare_room DROP COLUMN handled");
    });
    await abortAllDurableObjects();

    const first = await named(room, "p1", "abc");
    expect((await first.next("welcome")).state.total).toBe(5);
    send(first, 1, { type: "add", n: 1 });
    expect((await first.next("state")).state.total).toBe(6);
    await first.next("ack");
    expect(JSON.parse(await stored(rooms(room)))).toEqual({ p1: ["abc", 1] });
  });

  it("ignores what still arrives on a connection that a newer one has replaced", async () => {
    const total = (room: string) =>
      runInDurableObject(rooms(room), (_instance, state) => (JSON.parse(state.storage.sql.exec<{ state: string }>("SELECT state FROM tickflare_room").one().state) as TestState).total);
    /** Hands the room a frame on the connection `player` had before the one they have now. */
    const straggler = async (room: string, who: string, frame: unknown) => {
      let old: WebSocket | undefined;
      await runInDurableObject(rooms(room), (_instance, state) => {
        old = state.getWebSockets("p1")[0];
      });
      const back = await connect(room, who);
      await back.next("welcome");
      await runInDurableObject(rooms(room), (instance) => instance.webSocketMessage(old!, JSON.stringify(frame)));
      return back;
    };

    // The client that named itself sends again what the room had not handled when it welcomed
    // the new connection. The copy that was still on its way on the old one must not count.
    const room = freshRoom();
    await (await named(room, "p1", "abc")).next("welcome");
    const back = await straggler(room, "p1&v=5&client=abc", { t: "cmd", id: 1, data: { type: "add", n: 5 } });
    expect(await total(room)).toBe(0);
    send(back, 1, { type: "add", n: 5 });
    expect((await back.next("state")).state.total).toBe(5);
    expect(await back.next("ack")).toMatchObject({ id: 1 });

    // A client that did not name itself sends nothing again, and is treated as it always was.
    const plain = freshRoom();
    await (await connect(plain, "p1")).next("welcome");
    await straggler(plain, "p1", { t: "cmd", id: 1, data: { type: "add", n: 5 } });
    expect(await total(plain)).toBe(5);
  });

  it("is told nothing in a lockstep room, which keeps its own record of what was sent", async () => {
    const room = freshRoom();
    const first = await follow<unknown>("/turns", room, "p1&v=5&client=abc");
    expect(first.of("welcome")[0]).toMatchObject({ v: 5 });
    const back = await follow<unknown>("/turns", room, "p1&v=5&client=abc");
    expect("c" in back.of("welcome")[0]!).toBe(false);
  });
});

describe("a ticking room and a client that names itself", () => {
  const ticks = (room: string) => env.TICKS.get(env.TICKS.idFromName(room));
  const join = (room: string, client = "abc") => follow<TickState>("/ticks", room, `p1&v=5&client=${client}`);
  const cmd = (to: { ws: WebSocket }, id: number, type: string) => to.ws.send(JSON.stringify({ t: "cmd", id, data: { type } }));
  const row = (room: string) =>
    runInDurableObject(ticks(room), (_instance, state) =>
      state.storage.sql.exec<{ seq: number; state: string; tick: number; handled: string }>("SELECT seq, state, tick, handled FROM tickflare_room").one(),
    );

  it("answers a command that is sent again with the next tick, and does not apply it twice", async () => {
    const room = freshRoom();
    const first = await join(room);
    cmd(first, 1, "bump");
    await until(() => first.of("ack").length === 1, "the answer");
    expect(first.state!.bumps).toBe(1);

    const back = await join(room);
    expect(back.of("welcome")[0]).toMatchObject({ c: 1 });
    cmd(back, 1, "bump");
    cmd(back, 2, "bump");
    await until(() => back.of("ack").length === 2, "both answers");
    expect(back.of("ack").map((ack) => ack.id)).toEqual([1, 2]);
    expect(back.of("ack").every((ack) => ack.tick !== undefined)).toBe(true);
    expect(back.state!.bumps).toBe(2);
  });

  it("takes again, once, the commands its last save does not hold", async () => {
    const room = freshRoom();
    const first = await join(room);
    cmd(first, 1, "bump");
    await until(() => first.of("ack").length === 1, "the first answer");
    let saved = await row(room);
    for (let waited = 0; !saved.handled.includes('"abc",1'); waited += 20) {
      if (waited > 2000) throw new Error("the save that holds the first command never came");
      await sleep(20);
      saved = await row(room);
    }
    expect((JSON.parse(saved.state) as TickState).bumps).toBe(1);

    // The second command is applied and answered. Then the room goes down, and comes back as
    // its save of before that command: what a deploy does, when it falls between two saves.
    cmd(first, 2, "bump");
    await until(() => first.of("ack").length === 2, "the second answer");
    expect(first.state!.bumps).toBe(2);
    await abortAllDurableObjects();
    await runInDurableObject(ticks(room), (_instance, state) => {
      state.storage.sql.exec("UPDATE tickflare_room SET seq = ?, state = ?, tick = ?, handled = ?", saved.seq, saved.state, saved.tick, saved.handled);
    });

    const back = await join(room);
    // The room says so: it has 1, and not 2.
    expect(back.of("welcome")[0]).toMatchObject({ c: 1 });
    expect(back.state!.bumps).toBe(1);
    // A client that still held 2 sends it again, and 3, which never arrived at all.
    cmd(back, 2, "bump");
    cmd(back, 3, "bump");
    await until(() => back.of("ack").length === 2, "the answers");
    expect(back.state!.bumps).toBe(3);
    cmd(back, 2, "bump");
    await until(() => back.of("ack").length === 3, "the answer to a command sent a third time");
    expect(back.state!.bumps).toBe(3);
  });

  it("saves a client it meets on a seat that was there, with the state as it is then", async () => {
    const room = freshRoom();
    const old = await follow<TickState>("/ticks", room, "p1");
    await until(() => old.tick >= 3, "some ticks");
    const first = await join(room);
    expect("c" in first.of("welcome")[0]!).toBe(false);
    const saved = await row(room);
    expect(JSON.parse(saved.handled)).toEqual({ p1: ["abc", 0] });
    expect(saved.tick).toBeGreaterThanOrEqual(3);
  });

  it("no longer goes by the numbers on a connection it came back from an older save under", async () => {
    const room = freshRoom();
    const first = await join(room);
    cmd(first, 1, "bump");
    await until(() => first.of("ack").length === 1, "the answer");

    // As in restarts.test.ts: a room whose ticks keep failing pauses, and can be taken out of
    // memory with its players connected, which is how a room looks that went down mid-simulation.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    cmd(first, 2, "break");
    await until(() => first.state!.broken === true, "the break");
    for (let count = -1; count !== first.frames.length; ) {
      count = first.frames.length;
      await sleep(300);
    }
    await evictDurableObject(ticks(room));

    // A command wakes it. It is welcomed again on the connection it has, and told nothing of
    // its commands: which of them the save holds cannot be told from their numbers any more.
    cmd(first, 3, "fix");
    await until(() => first.of("welcome").length === 2, "the second welcome");
    errors.mockRestore();
    expect("c" in first.of("welcome")[1]!).toBe(false);
    await until(() => first.state!.broken === false, "the fix");
    // What arrives on this connection is applied as it comes, even under a number it has seen.
    cmd(first, 1, "bump");
    await until(() => first.state!.bumps === 2, "the bump");

    // And when the client connects again, the room does not claim to know what it handled.
    const back = await join(room);
    expect("c" in back.of("welcome")[0]!).toBe(false);
    // From there on it does again.
    cmd(back, 7, "bump");
    await until(() => back.of("ack").length === 1, "the answer");
    const last = await join(room);
    expect(last.of("welcome")[0]).toMatchObject({ c: 7 });
    expect(last.state!.bumps).toBe(3);
  });
});

describe("RoomClient and a room, over a connection that drops", () => {
  beforeEach(() => {
    WorkerSocket.all = [];
    vi.stubGlobal("WebSocket", WorkerSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const open = async (room: string, options: ConstructorParameters<typeof RoomClient<TestState, TestCommand>>[1] = {}) => {
    const client = new RoomClient<TestState, TestCommand>(`wss://tickflare.test/rooms/${room}?player=p1`, options);
    await until(() => client.status === "open", "the connection");
    return client;
  };
  /** The network takes what the client sends from now on, and delivers none of it. */
  const swallow = () => {
    WorkerSocket.all.at(-1)!.send = () => {};
  };

  it("settles a command whose answer was lost, and the room applies it once", async () => {
    const room = freshRoom();
    const client = await open(room);
    const sent = client.send({ type: "add", n: 5 });
    // The command is on its way to the room. The answer will find nobody.
    WorkerSocket.all[0]!.drop();
    expect(client.status).toBe("connecting");
    expect(client.unconfirmed.map((command) => command.id)).toEqual([1]);

    await sent;
    expect(client.status).toBe("open");
    expect(client.state!.total).toBe(5);
    expect(client.unconfirmed).toEqual([]);
    expect(WorkerSocket.all).toHaveLength(2);
    // And the next one counts on from there.
    await client.send({ type: "add", n: 1 });
    expect(client.state!.total).toBe(6);
    client.close();
  });

  it("sends again a command that never arrived, and one that was refused is refused", async () => {
    const room = freshRoom();
    const client = await open(room);
    await client.send({ type: "add", n: 1 });
    swallow();
    const lost = client.send({ type: "add", n: 5 });
    const refused = client.send({ type: "half" });
    WorkerSocket.all[0]!.drop();
    // Sent while there is no connection: it waits for one, behind the other two.
    const late = client.send({ type: "add", n: 10 });
    expect(client.unconfirmed.map((command) => command.id)).toEqual([2, 3, 4]);

    await lost;
    await expect(refused).rejects.toMatchObject({ reason: "changed_my_mind" });
    await late;
    expect(client.state!.total).toBe(16);
    expect(client.unconfirmed).toEqual([]);
    client.close();
  });

  it("learns that a command was refused though the refusal never arrived", async () => {
    const room = freshRoom();
    const client = await open(room);
    const refused = client.send({ type: "half" });
    WorkerSocket.all[0]!.drop();
    await expect(refused).rejects.toMatchObject({ reason: "changed_my_mind" });
    expect(client.state!.total).toBe(0);
    client.close();
  });

  it("loses and repeats nothing when the room is restarted while the connection is down", async () => {
    const room = freshRoom();
    const client = await open(room);
    const arrived = client.send({ type: "add", n: 5 });
    WorkerSocket.all[0]!.drop();
    await until(() => WorkerSocket.all.length === 1 && client.status === "connecting");
    await abortAllDurableObjects();
    await arrived;
    expect(client.state!.total).toBe(5);

    swallow();
    const lost = client.send({ type: "add", n: 2 });
    WorkerSocket.all.at(-1)!.drop();
    await abortAllDurableObjects();
    await lost;
    expect(client.state!.total).toBe(7);
    client.close();
  });

  it("gives a command up when it has waited as long as it may, and does not send it later", async () => {
    const room = freshRoom();
    const client = await open(room, { keepCommandsMs: 60 });
    swallow();
    const lost = client.send({ type: "add", n: 5 });
    WorkerSocket.all[0]!.drop();
    const never = client.send({ type: "add", n: 7 });
    // The first attempt to reconnect comes after 125 ms at the earliest.
    await expect(lost).rejects.toMatchObject({ reason: "disconnected" });
    await expect(never).rejects.toMatchObject({ reason: "not_connected" });
    expect(client.status).toBe("connecting");
    expect(client.unconfirmed).toEqual([]);

    await until(() => client.status === "open", "the connection again");
    await client.send({ type: "add", n: 1 });
    expect(client.state!.total).toBe(1);
    client.close();
  });

  it("gives up what was in flight, as it always did, when it may keep no commands", async () => {
    const room = freshRoom();
    const client = await open(room, { keepCommandsMs: 0 });
    const sent = client.send({ type: "add", n: 5 });
    WorkerSocket.all[0]!.drop();
    await expect(sent).rejects.toBeInstanceOf(CommandRejected);
    await expect(sent).rejects.toMatchObject({ reason: "disconnected" });
    await expect(client.send({ type: "add", n: 1 })).rejects.toMatchObject({ reason: "not_connected" });
    await until(() => client.status === "open", "the connection again");
    // The room did get it. Nobody told the client, which is what this option turns off.
    expect(client.state!.total).toBe(5);
    client.close();
  });
});
