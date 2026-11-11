import { describe, expect, it } from "vitest";
import { CloseCode } from "../src/protocol.js";
import { connect, sleep, twoPlayers } from "./helpers.js";

describe("leaving", () => {
  it("lets a player go: ack, close, and the seat is free again", async () => {
    const { room, p1, p2 } = await twoPlayers();
    const id = p2.leave();

    expect(await p2.next("ack")).toEqual({ t: "ack", id, seq: 3 });
    expect(await p2.closed).toEqual({ code: CloseCode.Removed, reason: "left" });
    expect((await p1.next("state")).state.log).toEqual(["join:p1", "join:p2", "left:p2"]);
    expect((await p1.next("presence")).players).toEqual([{ id: "p1", connected: true }]);

    const p3 = await connect(room, "p3");
    expect((await p3.next("welcome")).players.map((p) => p.id)).toEqual(["p1", "p3"]);
  });

  it("keeps the player seated when onLeave rejects", async () => {
    const { p1, p2 } = await twoPlayers();
    p1.command({ type: "lock" });
    await p2.next("state");

    const id = p2.leave();
    expect(await p2.next("reject")).toEqual({ t: "reject", id, reason: "locked" });
    p2.command({ type: "noop" });
    await p2.next("ack");
  });

  it("does not count a departure as a disconnect", async () => {
    const { p1, p2 } = await twoPlayers();
    p2.leave();
    await p2.closed;
    await p1.next("state");
    await p1.next("presence");
    await sleep(50);

    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.log).toEqual(["join:p1", "join:p2", "left:p2"]);
  });
});

describe("removePlayer", () => {
  it("closes the removed player's connection and tells the rest", async () => {
    const { p1, p2 } = await twoPlayers();
    p1.command({ type: "kick", id: "p2" });

    await p1.next("ack");
    expect((await p1.next("presence")).players).toEqual([{ id: "p1", connected: true }]);
    expect(await p2.closed).toEqual({ code: CloseCode.Removed, reason: "kicked" });

    // onLeave and onDisconnect are not called for a removal.
    await sleep(50);
    p1.command({ type: "add", n: 1 });
    expect((await p1.next("state")).state.log).toEqual(["join:p1", "join:p2"]);
  });

  it("is undone when the hook rejects afterwards", async () => {
    const { p1, p2 } = await twoPlayers();
    p1.command({ type: "kickThenReject", id: "p2" });
    await p1.next("reject");

    p2.command({ type: "add", n: 1 });
    expect((await p2.next("state")).state.total).toBe(1);
    await p2.next("ack");
    expect((await p1.next("state")).state.total).toBe(1);
  });

  it("makes a returning player join from scratch", async () => {
    const { room, p1, p2 } = await twoPlayers();
    p1.command({ type: "kick", id: "p2" });
    await p2.closed;

    const back = await connect(room, "p2");
    expect((await back.next("welcome")).state.log).toEqual(["join:p1", "join:p2", "join:p2"]);
  });

  it("stops sending state to the removed player", async () => {
    const { p1, p2 } = await twoPlayers();
    // p1 removes themselves through a command: they get the ack, then the close, and no state.
    const id = p1.command({ type: "kick", id: "p1" });

    expect(await p1.next("ack")).toEqual({ t: "ack", id, seq: 2 });
    expect(await p1.closed).toEqual({ code: CloseCode.Removed, reason: "kicked" });
    expect((await p2.next("presence")).players).toEqual([{ id: "p2", connected: true }]);
  });
});
