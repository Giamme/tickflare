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
