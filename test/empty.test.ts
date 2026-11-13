import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { CloseCode } from "../src/protocol.js";
import { connect, freshRoom, sleep, twoPlayers } from "./helpers.js";

/** The log of a room as it is in storage, or null for a room that stores nothing. */
const savedLog = (rooms: DurableObjectNamespace, room: string) =>
  runInDurableObject(rooms.get(rooms.idFromName(room)), (_instance, state) => {
    const sql = state.storage.sql;
    if (sql.exec("SELECT name FROM sqlite_master WHERE name = 'tickflare_room'").toArray().length === 0) return null;
    const row = sql.exec<{ state: string }>("SELECT state FROM tickflare_room").toArray()[0];
    return row ? (JSON.parse(row.state) as { log: string[] }).log : null;
  });

describe("onEmpty", () => {
  it("is called when the last player leaves, and not before", async () => {
    const { room, p1, p2 } = await twoPlayers(`hollow-${freshRoom()}`);
    p2.leave();
    await p2.closed;
    expect((await p1.next("state")).state.log).toEqual(["join:p1", "join:p2", "left:p2"]);

    p1.leave();
    expect(await p1.closed).toEqual({ code: CloseCode.Removed, reason: "left" });
    // After onLeave, in a hook of its own, with nobody left in `players`.
    expect(await savedLog(env.ROOMS, room)).toEqual(["join:p1", "join:p2", "left:p2", "left:p1", "empty:0"]);
  });

  it("is called when the last seat times out", async () => {
    const room = `hollow-${freshRoom()}`;
    const p1 = await connect(room, "p1", {}, "/away");
    await p1.next("welcome");
    p1.ws.close(1000, "bye");
    await sleep(400);

    expect(await savedLog(env.AWAY, room)).toEqual(["join:p1", "leave:p1", "left:p1", "empty:0"]);
  });

  it("is called when the last player is removed, though onLeave is not", async () => {
    const room = `hollow-${freshRoom()}`;
    const p1 = await connect(room, "p1");
    await p1.next("welcome");
    p1.command({ type: "kick", id: "p1" });
    await p1.closed;

    expect(await savedLog(env.ROOMS, room)).toEqual(["join:p1", "empty:0"]);
  });

  it("is called each time the room empties, and not for a join that was refused", async () => {
    const room = `hollow-${freshRoom()}`;
    const banned = await connect(room, "banned");
    await banned.closed;
    expect(await savedLog(env.ROOMS, room)).toBeNull();

    for (const id of ["p1", "p2"]) {
      const player = await connect(room, id);
      await player.next("welcome");
      player.leave();
      await player.closed;
    }
    expect(await savedLog(env.ROOMS, room)).toEqual(["join:p1", "left:p1", "empty:0", "join:p2", "left:p2", "empty:0"]);
  });

  it("can delete the room", async () => {
    const room = `fleeting-${freshRoom()}`;
    const p1 = await connect(room, "p1");
    await p1.next("welcome");
    p1.command({ type: "add", n: 4 });
    await p1.next("state");
    await p1.next("ack");
    p1.leave();
    await p1.closed;

    for (let waited = 0; (await savedLog(env.ROOMS, room)) !== null; waited += 20) {
      expect(waited).toBeLessThan(3000);
      await sleep(20);
    }
    const again = await connect(room, "p2");
    expect((await again.next("welcome")).state).toMatchObject({ total: 0, log: ["join:p2"] });
  });

  it("is undone alone when it fails: the player is still gone", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const room = `sour-${freshRoom()}`;
    const p1 = await connect(room, "p1");
    await p1.next("welcome");
    p1.leave();
    expect(await p1.closed).toEqual({ code: CloseCode.Removed, reason: "left" });

    expect(await savedLog(env.ROOMS, room)).toEqual(["join:p1", "left:p1"]);
    const p2 = await connect(room, "p2");
    expect((await p2.next("welcome")).players.map((p) => p.id)).toEqual(["p2"]);
    error.mockRestore();
  });
});
