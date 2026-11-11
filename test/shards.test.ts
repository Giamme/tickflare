import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { CloseCode } from "../src/protocol.js";
import { cellOf, shardFor } from "../src/world.js";
import { connect, freshRoom, sleep, twoPlayers } from "./helpers.js";

describe("movePlayer", () => {
  it("hands a player to another room, with what they carry", async () => {
    const { room, p1, p2 } = await twoPlayers();
    const next = freshRoom();
    const id = p1.command({ type: "move", to: next, gold: 5 });

    expect(await p1.next("ack")).toMatchObject({ id });
    expect(await p1.closed).toEqual({ code: CloseCode.Moved, reason: next });
    expect((await p2.next("presence")).players).toEqual([{ id: "p2", connected: true }]);

    const arrived = await connect(next, "p1");
    const welcome = await arrived.next("welcome");
    expect(welcome.state.log).toEqual([`arrive:p1:${JSON.stringify({ from: room, gold: 5 })}`]);
    expect(welcome.players).toEqual([{ id: "p1", connected: true }]);

    // Leaving through a handover is neither a disconnect nor a leave for the room left behind.
    await sleep(50);
    p2.command({ type: "add", n: 1 });
    expect((await p2.next("state")).state.log).toEqual(["join:p1", "join:p2"]);
  });

  it("delivers what they carry once: coming back later is an ordinary reconnect", async () => {
    const { p1 } = await twoPlayers();
    const next = freshRoom();
    p1.command({ type: "move", to: next, gold: 1 });
    await p1.closed;

    const first = await connect(next, "p1");
    await first.next("welcome");
    first.ws.close(1000, "bye");
    await sleep(50);
    const again = await connect(next, "p1");
    const log = (await again.next("welcome")).state.log;
    expect(log.filter((line) => line.startsWith("arrive:"))).toHaveLength(1);
    expect(log).toContain("back:p1");
  });

  it("is undone when the hook rejects afterwards", async () => {
    const { p1, p2 } = await twoPlayers();
    p1.command({ type: "moveThenReject", to: freshRoom() });
    await p1.next("reject");

    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.total).toBe(1);
    await p1.next("ack");
    expect((await p2.next("state")).state.total).toBe(1);
  });

  it("lets an arriving player into a room that is already full", async () => {
    const full = await twoPlayers();
    const { p1 } = await twoPlayers();
    // The destination holds two players called p1 and p2, so the traveller needs another name.
    const origin = freshRoom();
    const traveller = await connect(origin, "p9");
    await traveller.next("welcome");
    traveller.command({ type: "move", to: full.room, gold: 0 });
    await traveller.closed;

    const arrived = await connect(full.room, "p9");
    expect((await arrived.next("welcome")).players.map((p) => p.id)).toEqual(["p1", "p2", "p9"]);
    // Someone who was not handed over is still turned away.
    const stranger = await connect(full.room, "p8");
    expect(await stranger.closed).toEqual({ code: CloseCode.RoomFull, reason: "room_full" });
    p1.ws.close();
  });
});

describe("handing over a player who is away", () => {
  /** p1 stays; p2 has a seat but no connection. */
  async function oneAway(room: string) {
    const p1 = await connect(room, "p1", {}, "/edge");
    await p1.next("welcome");
    const p2 = await connect(room, "p2", {}, "/edge");
    await p2.next("welcome");
    p2.ws.close(1000, "tab reloading");
    await sleep(50);
    return p1;
  }

  const seatsIn = (room: string) =>
    runInDurableObject(env.EDGE.get(env.EDGE.idFromName(room)), (_instance, state) =>
      JSON.parse(state.storage.sql.exec<{ players: string }>("SELECT players FROM tickflare_room").one().players),
    );

  it("sends them on to the new room when they come back", async () => {
    const room = freshRoom();
    const next = freshRoom();
    const p1 = await oneAway(room);
    p1.command({ type: "edge:moveOther", id: "p2", to: next } as never);
    await sleep(300); // the handover has been delivered

    const back = await connect(room, "p2", {}, "/edge");
    expect(await back.closed).toEqual({ code: CloseCode.Moved, reason: next });
    expect(await seatsIn(room)).toEqual(["p1"]);

    const arrived = await connect(next, "p2", {}, "/edge");
    expect((await arrived.next("welcome")).state.log).toEqual([`arrive:p2:${JSON.stringify({ gold: 7 })}`]);
  });

  it("holds them without a seat if they come back while the handover is under way", async () => {
    const room = freshRoom();
    const next = freshRoom();
    const p1 = await oneAway(room);
    p1.command({ type: "edge:moveOther", id: "p2", to: next } as never);
    await sleep(30); // the handover takes 100 ms

    const back = await connect(room, "p2", {}, "/edge");
    const first = await Promise.race([
      back.closed.then((closed) => ({ closed })),
      back.any().then((frame) => ({ frame: frame.t })),
    ]);
    expect(first).toEqual({ closed: { code: CloseCode.Moved, reason: next } });
    expect(await seatsIn(room)).toEqual(["p1"]);
  });

  it("tells a player again who comes straight back, in case the news did not reach them", async () => {
    const { room, p1 } = await twoPlayers();
    const next = freshRoom();
    p1.command({ type: "move", to: next, gold: 1 });
    expect(await p1.closed).toEqual({ code: CloseCode.Moved, reason: next });

    const again = await connect(room, "p1");
    expect(await again.closed).toEqual({ code: CloseCode.Moved, reason: next });
  });

  it("lets them join afresh once that has been a while", async () => {
    const { room, p1 } = await twoPlayers();
    const next = freshRoom();
    p1.command({ type: "move", to: next, gold: 1 });
    expect(await p1.closed).toEqual({ code: CloseCode.Moved, reason: next });

    // Half a minute later, as far as the room can tell.
    await runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(room)), (_instance, state) => {
      state.storage.sql.exec("UPDATE tickflare_forwards SET expires = 1");
    });
    const fresh = await connect(room, "p1");
    expect((await fresh.next("welcome")).state.log).toEqual(["join:p1", "join:p2", "join:p1"]);
  });

  it("seats a player normally when another room hands them back", async () => {
    const { room, p1 } = await twoPlayers();
    const next = freshRoom();
    p1.command({ type: "move", to: next, gold: 1 });
    expect(await p1.closed).toEqual({ code: CloseCode.Moved, reason: next });

    const there = await connect(next, "p1");
    await there.next("welcome");
    there.command({ type: "move", to: room, gold: 2 });
    expect(await there.closed).toEqual({ code: CloseCode.Moved, reason: room });

    const home = await connect(room, "p1");
    const welcome = await home.next("welcome");
    expect(welcome.state.log.at(-1)).toBe(`arrive:p1:${JSON.stringify({ from: next, gold: 2 })}`);
  });
});

describe("shardFor", () => {
  it("maps positions to the room of their cell, negative ones included", () => {
    expect(shardFor(0, 0, 100)).toBe("world_0_0");
    expect(shardFor(99.9, 100, 100)).toBe("world_0_1");
    expect(shardFor(-1, -100.5, 100, "overworld")).toBe("overworld_-1_-2");
    expect(shardFor(250, 30, 100)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("reads the cell back from a shard id", () => {
    expect(cellOf("overworld_-1_-2", "overworld")).toEqual({ cx: -1, cy: -2 });
    expect(cellOf(shardFor(250, 30, 100))).toEqual({ cx: 2, cy: 0 });
    expect(cellOf("lobby")).toBeUndefined();
    expect(cellOf("other_1_1")).toBeUndefined();
  });
});
