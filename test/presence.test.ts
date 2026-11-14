import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomClient } from "../src/client/index.js";
import { PROTOCOL_VERSION, type Player } from "../src/protocol.js";
import { connect, freshRoom, sleep, until } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";

/** Rooms in which a join changes nothing but who is there. */
const ROOMS = "/shapes";

/** A player whose client speaks the latest version of the protocol, and one whose client speaks the first. */
async function newAndOld(room = freshRoom()) {
  const modern = await connect(room, `p1&v=${PROTOCOL_VERSION}`, {}, ROOMS);
  expect((await modern.next("welcome")).v).toBe(PROTOCOL_VERSION);
  const old = await connect(room, "p2", {}, ROOMS);
  expect((await old.next("welcome")).v).toBe(1);
  return { room, modern, old };
}

describe("presence", () => {
  it("tells a client of version 3 who is new, and an older one the whole list", async () => {
    const { room, modern, old } = await newAndOld();
    // The second of two: saying who came is shorter than the list of both.
    expect(await modern.next("presence")).toEqual({ t: "presence", set: [{ id: "p2", connected: true }] });

    const third = await connect(room, "p3&v=3", {}, ROOMS);
    expect((await third.next("welcome")).players).toEqual([
      { id: "p1", connected: true },
      { id: "p2", connected: true },
      { id: "p3", connected: true },
    ]);
    expect(await modern.next("presence")).toEqual({ t: "presence", set: [{ id: "p3", connected: true }] });
    expect((await old.next("presence")).players).toHaveLength(3);
  });

  it("says who dropped, who came back and who left", async () => {
    const { room, modern, old } = await newAndOld();
    await modern.next("presence");
    const third = await connect(room, "p3&v=3", {}, ROOMS);
    await third.next("welcome");
    await modern.next("presence");
    await old.next("presence");

    third.ws.close(1000, "bye");
    expect(await modern.next("presence")).toEqual({ t: "presence", set: [{ id: "p3", connected: false }] });
    expect((await old.next("presence")).players![2]).toEqual({ id: "p3", connected: false });

    const back = await connect(room, "p3&v=3", {}, ROOMS);
    await back.next("welcome");
    expect(await modern.next("presence")).toEqual({ t: "presence", set: [{ id: "p3", connected: true }] });
    await old.next("presence");

    old.leave();
    expect(await modern.next("presence")).toEqual({ t: "presence", gone: ["p2"] });
    expect(await back.next("presence")).toEqual({ t: "presence", gone: ["p2"] });
  });

  it("sends the whole list when that is no longer than the change", async () => {
    const { modern, old } = await newAndOld();
    await modern.next("presence");
    old.leave();
    // One gone, one left: the list is as short.
    expect(await modern.next("presence")).toEqual({ t: "presence", players: [{ id: "p1", connected: true }] });
  });

  it("sends the whole list after the room was out of memory, when it no longer knows what it told", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1&v=3", {}, ROOMS);
    await p1.next("welcome");
    const p2 = await connect(room, "p2&v=3", {}, ROOMS);
    await p2.next("welcome");
    await p1.next("presence");
    await sleep(20);
    await evictDurableObject(env.SHAPES.get(env.SHAPES.idFromName(room)));

    const p3 = await connect(room, "p3&v=3", {}, ROOMS);
    await p3.next("welcome");
    const whole = [
      { id: "p1", connected: true },
      { id: "p2", connected: true },
      { id: "p3", connected: true },
    ];
    expect(await p1.next("presence")).toEqual({ t: "presence", players: whole });
    expect(await p2.next("presence")).toEqual({ t: "presence", players: whole });
    // From here on it knows again.
    p3.leave();
    expect(await p1.next("presence")).toEqual({ t: "presence", gone: ["p3"] });
  });
});

describe("the client's list of players", () => {
  const clients: RoomClient[] = [];
  beforeEach(() => {
    WorkerSocket.all = [];
    vi.stubGlobal("WebSocket", WorkerSocket);
  });
  afterEach(() => {
    for (const client of clients.splice(0)) client.close();
    vi.unstubAllGlobals();
  });

  function join(room: string, player: string) {
    const client = new RoomClient(`wss://tickflare.test${ROOMS}/${room}?player=${player}`);
    clients.push(client);
    const seen: Player[][] = [];
    client.on("presence", (players) => seen.push(players));
    return { client, seen };
  }
  const ids = (players: readonly Player[]) => players.map((player) => `${player.id}${player.connected ? "" : " (away)"}`);

  it("follows joins, drops, returns and leaves, in join order, as the room has it", async () => {
    const room = freshRoom();
    const first = join(room, "a");
    await until(() => first.client.status === "open", "the first welcome");
    const others = ["b", "c", "d", "e"].map((player) => join(room, player));
    await until(() => first.client.players.length === 5, "everyone");
    expect(ids(first.client.players)).toEqual(["a", "b", "c", "d", "e"]);

    // Every list the client was given is a new array: what was drawn from an older one stays as it was.
    expect(new Set(first.seen).size).toBe(first.seen.length);

    others[1]!.client.close();
    await until(() => first.client.players[2]?.connected === false, "the drop");
    expect(ids(first.client.players)).toEqual(["a", "b", "c (away)", "d", "e"]);

    await others[0]!.client.leave().catch(() => {});
    await until(() => first.client.players.length === 4, "the leave");
    expect(ids(first.client.players)).toEqual(["a", "c (away)", "d", "e"]);

    const returned = join(room, "c");
    await until(() => returned.client.status === "open", "the return");
    const late = join(room, "f");
    await until(() => late.client.status === "open", "the last join");
    await until(() => first.client.players.length === 5 && first.client.players[1]?.connected === true, "the news of both");

    // Everyone who is connected holds the same list, however much of it they were there for.
    const expected = ["a", "c", "d", "e", "f"];
    for (const { client } of [first, others[2]!, others[3]!, returned, late]) {
      await until(() => client.players.length === 5 && client.players.every((player) => player.connected), "the same list everywhere");
      expect(ids(client.players)).toEqual(expected);
    }
  });
});
