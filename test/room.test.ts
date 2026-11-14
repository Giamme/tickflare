import { evictDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { CloseCode } from "../src/protocol.js";
import { connect, freshRoom, sleep, twoPlayers, upgrade } from "./helpers.js";

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

describe("hooks", () => {
  it("count the player who is connecting as connected while their join hook runs", async () => {
    const p1 = await connect(freshRoom(), "p1", {}, "/edge");
    expect((await p1.next("welcome")).state.log).toEqual(["join:p1:true"]);
  });

  it("do not get to keep what they change after being refused for returning a promise", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { p1 } = await twoPlayers();
    p1.command({ type: "async" });
    await p1.next("reject");
    await sleep(20); // the promise has run on and added 1000 to the total

    const id = p1.command({ type: "noop" });
    expect(await p1.any()).toEqual({ t: "ack", id, seq: 2 });
    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.total).toBe(1);
    error.mockRestore();
  });

  it("do not get to keep what onHttp changes", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { room, p1 } = await twoPlayers(freshRoom(), "/edge");
    const response = await exports.default.fetch(`https://tickflare.test/edge/${room}/poke?player=p1`);
    expect(await response.text()).toBe("poked");

    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.total).toBe(1);
    error.mockRestore();
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

  it("refuses frames beyond the per-player rate, then lets the player back in", async () => {
    const { p1, p2 } = await twoPlayers();
    const sent = 60;
    for (let i = 0; i < sent; i++) p1.command({ type: "noop" });

    let acks = 0;
    const refusals = new Set<string>();
    for (let i = 0; i < sent; i++) {
      const frame = await p1.any();
      if (frame.t === "ack") acks += 1;
      else if (frame.t === "reject") refusals.add(frame.reason);
    }
    // The default allows 30 a second, and a burst of 30.
    expect(acks).toBeGreaterThanOrEqual(30);
    expect(acks).toBeLessThan(40);
    expect([...refusals]).toEqual(["rate_limited"]);

    // The limit is per player, and it refills.
    p2.command({ type: "noop" });
    await p2.next("ack");
    await sleep(1100);
    p1.command({ type: "noop" });
    await p1.next("ack");
  });

  it("does not refill a player's allowance when they reconnect", async () => {
    const room = freshRoom();
    let p1 = await connect(room, "p1");
    await p1.next("welcome");
    let acks = 0;
    for (let round = 0; round < 4; round++) {
      for (let i = 0; i < 30; i++) p1.command({ type: "noop" });
      for (let i = 0; i < 30; i++) if ((await p1.any()).t === "ack") acks += 1;
      p1.ws.close(1000, "bye");
      await sleep(20);
      p1 = await connect(room, "p1");
      await p1.next("welcome");
    }
    // 30 a second with a burst of 30: four rounds in well under a second cannot all pass.
    expect(acks).toBeLessThan(70);
  });

  it("counts the frames it refuses unread against the limit as well", async () => {
    const { p1 } = await twoPlayers();
    const tooLarge = JSON.stringify({ t: "cmd", id: 1, data: { type: "secret", value: "x".repeat(300) } });
    // Many more than the limit lets through in a burst, so that a slow machine, on which the
    // allowance refills while they arrive, still runs out of it.
    for (let i = 0; i < 200; i++) p1.raw(tooLarge);

    const reasons: string[] = [];
    for (let i = 0; i < 200; i++) reasons.push((await p1.next("error")).reason);
    expect(reasons.slice(0, 30)).toEqual(Array(30).fill("message_too_large"));
    expect(reasons.filter((reason) => reason === "rate_limited").length).toBeGreaterThan(50);
    expect(new Set(reasons)).toEqual(new Set(["message_too_large", "rate_limited"]));
  });

  it("lets single frames through at a rate below one a second", async () => {
    const p1 = await connect(freshRoom(), "p1", {}, "/half");
    await p1.next("welcome");
    p1.command({ type: "noop" });
    expect((await p1.any()).t).toBe("ack");
    const id = p1.command({ type: "noop" });
    expect(await p1.any()).toEqual({ t: "reject", id, reason: "rate_limited" });
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
    await p1.next("ack");

    p2.command({ type: "secret", value: "theirs" });
    expect((await p2.next("state")).state.secrets).toEqual({ p2: "theirs" });
    await p2.next("ack");

    // A change both can see reaches both, each with their own secret and not the other's.
    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state).toMatchObject({ total: 1, secrets: { p1: "mine" } });
    expect((await p2.next("state")).state).toMatchObject({ total: 1, secrets: { p2: "theirs" } });
  });

  it("sends a player nothing when a change is not in their view", async () => {
    const { p1, p2 } = await twoPlayers();
    p1.command({ type: "secret", value: "mine" });
    await p1.next("state");
    await p1.next("ack");
    p1.command({ type: "add", n: 1 });
    await p1.next("state");

    // The first thing p2 hears is the change it can see. That is two changes on from what it
    // holds, and the patch says so.
    const frame = await p2.next("state");
    expect(frame.state).toMatchObject({ total: 1, secrets: {} });
    expect(p2.patches).toHaveLength(1);
    expect(p2.patches[0]).toMatchObject({ seq: frame.seq, from: frame.seq - 2, p: { total: [1] } });
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
    expect((await p1.next("presence")).players![1]).toEqual({ id: "p2", connected: true });
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
    expect((await p2.next("presence")).players![0]).toEqual({ id: "p1", connected: true });
  });

  it("reports a player dropping once, even when an older connection of theirs closes later", async () => {
    const room = freshRoom();
    const watcher = await connect(room, "w");
    await watcher.next("welcome");
    const first = await connect(room, "p1");
    await first.next("welcome");
    // Replace the connection and drop the replacement in the same breath.
    const second = await connect(room, "p1");
    second.ws.close(1000, "bye");
    await sleep(300);

    watcher.command({ type: "noop" });
    let log: string[] = [];
    for (;;) {
      const frame = await watcher.any();
      if (frame.t === "state") log = frame.state.log;
      if (frame.t === "ack") break;
    }
    expect(log.filter((line) => line === "leave:p1")).toHaveLength(1);
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
