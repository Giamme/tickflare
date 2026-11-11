import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { CloseCode } from "../src/protocol.js";
import { connect, freshRoom, twoPlayers, upgrade } from "./helpers.js";

describe("joining", () => {
  it("welcomes a new player with the state after onJoin", async () => {
    const p1 = await connect(freshRoom(), "p1");
    const welcome = await p1.next("welcome");

    expect(welcome).toMatchObject({
      v: 1,
      you: "p1",
      seq: 1,
      state: { total: 0, log: ["join:p1"] },
      players: [{ id: "p1", connected: true }],
    });
  });

  it("tells the players already seated", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1");
    await p1.next("welcome");
    const p2 = await connect(room, "p2");

    expect((await p2.next("welcome")).players).toEqual([
      { id: "p1", connected: true },
      { id: "p2", connected: true },
    ]);
    expect((await p1.next("state")).state.log).toEqual(["join:p1", "join:p2"]);
    expect((await p1.next("presence")).players).toHaveLength(2);
  });

  it("closes with RoomFull when every seat is taken", async () => {
    const { room } = await twoPlayers();
    const p3 = await connect(room, "p3");

    expect(await p3.closed).toEqual({ code: CloseCode.RoomFull, reason: "room_full" });
  });

  it("closes with the reason when onJoin refuses, and leaves the seat free", async () => {
    const room = freshRoom();
    const banned = await connect(room, "banned");
    expect(await banned.closed).toEqual({ code: CloseCode.JoinRejected, reason: "not_welcome" });

    const { p2 } = await twoPlayers(room);
    p2.command({ type: "noop" });
    await p2.next("ack");
  });
});

describe("commands", () => {
  it("applies a command, sends everyone the state, then acks the sender", async () => {
    const { p1, p2 } = await twoPlayers();
    const id = p1.command({ type: "add", n: 5 });

    expect(await p1.next("state")).toMatchObject({ seq: 3, state: { total: 5 } });
    expect(await p1.next("ack")).toEqual({ t: "ack", id, seq: 3 });
    expect(await p2.next("state")).toMatchObject({ seq: 3, state: { total: 5 } });
  });

  it("acks without a state frame when nothing changed", async () => {
    const { p1 } = await twoPlayers();
    const id = p1.command({ type: "noop" });

    expect(await p1.next("ack")).toEqual({ t: "ack", id, seq: 2 });
  });

  it("rolls back what a hook did before calling reject()", async () => {
    const { p1 } = await twoPlayers();
    const id = p1.command({ type: "half" });
    expect(await p1.next("reject")).toEqual({ t: "reject", id, reason: "changed_my_mind" });

    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.total).toBe(1);
  });

  it("rolls back and hides the details when a hook throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { p1 } = await twoPlayers();
    const id = p1.command({ type: "boom" });
    expect(await p1.next("reject")).toEqual({ t: "reject", id, reason: "internal_error" });
    expect(error).toHaveBeenCalled();
    error.mockRestore();

    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.total).toBe(1);
  });

  it("refuses a hook that returns a promise", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { p1 } = await twoPlayers();
    const id = p1.command({ type: "async" });

    expect(await p1.next("reject")).toEqual({ t: "reject", id, reason: "internal_error" });
    error.mockRestore();
  });

  it("refuses what parseCommand does not accept", async () => {
    const { p1 } = await twoPlayers();

    p1.raw(JSON.stringify({ t: "cmd", id: 7, data: { type: "fly" } }));
    expect(await p1.next("reject")).toEqual({ t: "reject", id: 7, reason: "invalid_command" });

    p1.raw(JSON.stringify({ t: "cmd", id: 8, data: { type: "add", n: "five" } }));
    expect(await p1.next("reject")).toEqual({ t: "reject", id: 8, reason: "n_must_be_a_number" });
  });

  it("answers frames it cannot read with an error and keeps the connection", async () => {
    const { p1 } = await twoPlayers();

    p1.raw("not json");
    expect((await p1.next("error")).reason).toBe("invalid_json");
    p1.raw(JSON.stringify({ t: "hello" }));
    expect((await p1.next("error")).reason).toBe("invalid_message");
    p1.raw(JSON.stringify({ t: "cmd", id: 1, data: { type: "secret", value: "x".repeat(300) } }));
    expect((await p1.next("error")).reason).toBe("message_too_large");
    p1.raw(new Uint8Array([1, 2, 3]).buffer);
    expect((await p1.next("error")).reason).toBe("binary_not_supported");

    p1.command({ type: "noop" });
    await p1.next("ack");
  });
});

describe("views", () => {
  it("sends each player only what view() returns for them", async () => {
    const { p1, p2 } = await twoPlayers();

    p1.command({ type: "secret", value: "mine" });
    expect((await p1.next("state")).state.secrets).toEqual({ p1: "mine" });
    expect((await p2.next("state")).state.secrets).toEqual({});

    p2.command({ type: "secret", value: "theirs" });
    expect((await p2.next("state")).state.secrets).toEqual({ p2: "theirs" });
    await p1.next("ack");
    expect((await p1.next("state")).state.secrets).toEqual({ p1: "mine" });
  });
});

describe("connections", () => {
  it("keeps the seat of a player who drops, and resumes them with the current state", async () => {
    const { room, p1, p2 } = await twoPlayers();
    p1.command({ type: "add", n: 3 });
    await p1.next("state");
    await p1.next("ack");

    p2.ws.close(1000, "bye");
    expect((await p1.next("state")).state.log).toContain("leave:p2");
    expect((await p1.next("presence")).players).toEqual([
      { id: "p1", connected: true },
      { id: "p2", connected: false },
    ]);

    const back = await connect(room, "p2");
    const welcome = await back.next("welcome");
    expect(welcome.state.total).toBe(3);
    expect(welcome.state.log).toContain("back:p2");
    expect(welcome.players).toEqual([
      { id: "p1", connected: true },
      { id: "p2", connected: true },
    ]);
    expect((await p1.next("state")).state.log).toContain("back:p2");
    expect((await p1.next("presence")).players[1]).toEqual({ id: "p2", connected: true });
  });

  it("lets the newest connection of a player replace the older one", async () => {
    const { room, p1, p2 } = await twoPlayers();
    const again = await connect(room, "p1");

    const welcome = await again.next("welcome");
    expect(await p1.closed).toEqual({ code: CloseCode.Replaced, reason: "replaced" });
    expect(welcome.state.log).toEqual(["join:p1", "join:p2"]);

    // The replaced socket closing must not count as p1 leaving.
    again.command({ type: "add", n: 1 });
    expect((await again.next("state")).state.log).toEqual(["join:p1", "join:p2"]);
    expect((await p2.next("presence")).players[0]).toEqual({ id: "p1", connected: true });
  });

  it("picks up from storage after the room is evicted, with sockets still open", async () => {
    const { room, p1, p2 } = await twoPlayers();
    p1.command({ type: "add", n: 2 });
    await p1.next("state");
    await p1.next("ack");
    await p2.next("state");

    await evictDurableObject(env.ROOMS.get(env.ROOMS.idFromName(room)));

    const id = p2.command({ type: "add", n: 3 });
    expect(await p2.next("state")).toMatchObject({ seq: 4, state: { total: 5 } });
    expect(await p2.next("ack")).toEqual({ t: "ack", id, seq: 4 });
    expect(await p1.next("state")).toMatchObject({ seq: 4, state: { total: 5 } });

    // Sockets that slept through the eviction still count as connected.
    const again = await connect(room, "p1");
    expect((await again.next("welcome")).players).toEqual([
      { id: "p1", connected: true },
      { id: "p2", connected: true },
    ]);
  });

  it("only talks to callers the gateway identified", async () => {
    const stub = env.ROOMS.get(env.ROOMS.idFromName(freshRoom()));
    const response = await stub.fetch("https://tickflare.test/", {
      headers: { Upgrade: "websocket" },
    });

    expect(response.status).toBe(401);
    expect((await upgrade("/rooms/x", {})).status).toBe(401);
  });
});
