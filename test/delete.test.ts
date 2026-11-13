import { runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { Replay } from "../src/lockstep.js";
import { CloseCode } from "../src/protocol.js";
import { recentMatches } from "../src/server/matches.js";
import { connect, follow, freshRoom, sleep, twoPlayers, upgrade } from "./helpers.js";

/** What a room has in storage: its tables, and whether an alarm is set. */
const kept = (rooms: DurableObjectNamespace, room: string) =>
  runInDurableObject(rooms.get(rooms.idFromName(room)), async (_instance, state) => ({
    tables: state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'")
      .toArray()
      .map((row) => row.name)
      .sort(),
    alarm: await state.storage.getAlarm(),
  }));

const NOTHING = { tables: [], alarm: null };

/** Waits until the room has nothing left in storage. */
async function gone(rooms: DurableObjectNamespace, room: string): Promise<void> {
  for (let waited = 0; waited < 3000; waited += 20) {
    if ((await kept(rooms, room)).tables.length === 0) return;
    await sleep(20);
  }
  throw new Error(`${room} still has ${JSON.stringify(await kept(rooms, room))}`);
}

describe("a room that was never used", () => {
  it("stores nothing when a join is refused", async () => {
    const room = freshRoom();
    const banned = await connect(room, "banned");
    expect((await banned.closed).code).toBe(CloseCode.JoinRejected);

    expect(await kept(env.ROOMS, room)).toEqual(NOTHING);
  });

  it("stores nothing when a request never becomes a connection", async () => {
    const room = freshRoom();
    const response = await upgrade(`/rooms/${room}`);
    expect(response.status).not.toBe(101);

    expect(await kept(env.ROOMS, room)).toEqual(NOTHING);
  });

  it("stores nothing when it is only asked something over HTTP", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = freshRoom();
    const response = await exports.default.fetch(`https://tickflare.test/edge/${room}/poke?player=p1`);
    expect(await response.text()).toBe("poked");
    error.mockRestore();

    expect(await kept(env.EDGE, room)).toEqual(NOTHING);
  });

  it("starts storing with the first player who is seated", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1");
    await p1.next("welcome");

    const { tables } = await kept(env.ROOMS, room);
    expect(tables).toContain("tickflare_room");
    const name = await runInDurableObject(env.ROOMS.get(env.ROOMS.idFromName(room)), (_instance, state) =>
      state.storage.sql.exec<{ value: string }>("SELECT value FROM tickflare_meta WHERE key = 'room'").one().value,
    );
    expect(name).toBe(room);
  });
});

describe("deleteRoom()", () => {
  it("disconnects everyone and leaves nothing behind", async () => {
    const { room, p1, p2 } = await twoPlayers();
    p1.command({ type: "add", n: 7 });
    await p1.next("state");
    await p1.next("ack");
    // A timer far in the future goes with the room: nothing is left to wake it.
    p1.command({ type: "timer", name: "later", ms: 60_000 });
    await p1.next("ack");

    p1.command({ type: "delete" });

    expect(await p1.closed).toEqual({ code: CloseCode.Removed, reason: "room_deleted" });
    expect(await p2.closed).toEqual({ code: CloseCode.Removed, reason: "room_deleted" });
    await gone(env.ROOMS, room);
    expect(await kept(env.ROOMS, room)).toEqual(NOTHING);
  });

  it("frees the room id for a new room", async () => {
    const { room, p1 } = await twoPlayers();
    p1.command({ type: "add", n: 7 });
    await p1.next("state");
    await p1.next("ack");
    p1.command({ type: "delete" });
    await p1.closed;
    await gone(env.ROOMS, room);

    const again = await connect(room, "p3");
    const welcome = await again.next("welcome");
    expect(welcome.state).toMatchObject({ total: 0, log: ["join:p3"] });
    expect(welcome.players.map((p) => p.id)).toEqual(["p3"]);
  });

  it("does nothing when the hook that asked for it rejects", async () => {
    const { room, p1 } = await twoPlayers();
    p1.command({ type: "deleteThenReject" });
    await p1.next("reject");
    await sleep(200);

    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.total).toBe(1);
    expect((await kept(env.ROOMS, room)).tables).toContain("tickflare_room");
  });

  it("can be called from a timer", async () => {
    const { room, p1 } = await twoPlayers();
    p1.command({ type: "timer", name: "close", ms: 50 });
    await p1.next("ack");

    expect(await p1.closed).toEqual({ code: CloseCode.Removed, reason: "room_deleted" });
    await gone(env.ROOMS, room);
  });

  it("takes the game's own tables too", async () => {
    const { room, p1 } = await twoPlayers(freshRoom(), "/edge");
    p1.raw(JSON.stringify({ t: "cmd", id: 1, data: { type: "edge:scribbleAndDelete" } }));

    await p1.closed;
    await gone(env.EDGE, room);
    expect(await kept(env.EDGE, room)).toEqual(NOTHING);
  });

  it("lets deferred work that is under way finish first", async () => {
    const { room, p1 } = await twoPlayers(freshRoom(), "/edge");
    p1.raw(JSON.stringify({ t: "cmd", id: 1, data: { type: "edge:tellThenDelete" } }));

    await p1.closed;
    await gone(env.EDGE, room);
    expect(await (await env.REPLAYS.get(`farewell/${room}`))?.text()).toBe("gone");
  });

  it("waits for as long as the room owes a delivery", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { room, p1, p2 } = await twoPlayers(freshRoom(), "/edge");
    p2.raw(JSON.stringify({ t: "cmd", id: 1, data: { type: "edge:moveAndDelete", to: `nowhere-${freshRoom()}` } }));
    await sleep(600);

    // The handover cannot be delivered, so the room and everyone in it are still there.
    const still = await kept(env.EDGE, room);
    expect(still.tables).toContain("tickflare_room");
    expect(still.alarm).not.toBeNull();
    p1.command({ type: "add", n: 3 });
    let total = 0;
    while (total !== 3) {
      const frame = await p1.any();
      if (frame.t === "state") total = frame.state.total;
    }
    expect(p2.ws.readyState).toBe(WebSocket.OPEN);
    error.mockRestore();
  });

  it("delivers a finished match before the room goes", async () => {
    const { room, p1 } = await twoPlayers();
    p1.command({ type: "finishAndDelete" });

    expect(await p1.closed).toEqual({ code: CloseCode.Removed, reason: "room_deleted" });
    await gone(env.ROOMS, room);
    let match;
    for (let waited = 0; waited < 8000 && !match; waited += 100) {
      match = (await recentMatches(env.DB, 100)).find((m) => m.room === room);
      if (!match) await sleep(100);
    }
    expect(match).toMatchObject({ room, players: ["p1", "p2"], result: { winner: "p1" } });
  });

  it("takes a lockstep room's recording with it, once the match has been handed over", async () => {
    const room = `once-${freshRoom()}`;
    const p1 = await follow<{ seed: number; turn: number }>("/turns", room, "p1");
    p1.send({ k: "i", d: { type: "add", n: 2 } });
    await sleep(150);
    expect((await kept(env.TURNS, room)).tables).toContain("tickflare_turns");

    p1.ws.send(JSON.stringify({ t: "leave", id: 99 }));
    await gone(env.TURNS, room);

    let match;
    for (let waited = 0; waited < 8000 && !match; waited += 100) {
      match = (await recentMatches(env.DB, 100)).find((m) => m.room === room);
      if (!match) await sleep(100);
    }
    expect(match?.replayKey).toBeTruthy();
    const replay = (await (await env.REPLAYS.get(match!.replayKey!))!.json()) as Replay<{ type: string; n: number }>;
    expect(replay.turns.flatMap(([, entries]) => entries.map((entry) => entry.input))).toContainEqual({ type: "add", n: 2 });
    expect(await kept(env.TURNS, room)).toEqual(NOTHING);
  });
});
