import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { CloseCode } from "../src/protocol.js";
import { connect, freshRoom, sleep, twoPlayers } from "./helpers.js";

/** What a room still owes: finished matches and handovers not delivered yet. */
const owedBy = (rooms: DurableObjectNamespace, room: string) =>
  runInDurableObject(rooms.get(rooms.idFromName(room)), (_instance, state) =>
    state.storage.sql.exec<{ body: string }>("SELECT body FROM tickflare_outbox").toArray().map((row) => row.body),
  );

/** The room row as it is in storage, which is what a restart would resume from. */
const storedIn = (rooms: DurableObjectNamespace, room: string) =>
  runInDurableObject(rooms.get(rooms.idFromName(room)), (_instance, state) => {
    const row = state.storage.sql
      .exec<{ players: string; state: string }>("SELECT players, state FROM tickflare_room")
      .one();
    return { players: JSON.parse(row.players) as string[], state: JSON.parse(row.state) as { total: number } };
  });

describe("deliveries", () => {
  it("delivers a handover that is committed while another one is on its way", async () => {
    const { room, p1, p2 } = await twoPlayers(freshRoom(), "/edge");
    const next = freshRoom();
    p1.command({ type: "move", to: next, gold: 1 });
    await sleep(30); // p1's handover takes 100 ms and is now under way
    p2.command({ type: "move", to: next, gold: 2 });

    expect(await p1.closed).toEqual({ code: CloseCode.Moved, reason: next });
    const second = await Promise.race([p2.closed, sleep(1500).then(() => "p2 is still waiting")]);
    expect(second).toEqual({ code: CloseCode.Moved, reason: next });
    expect(await owedBy(env.EDGE, room)).toEqual([]);
  });

  it("does the same when the two handovers are asked for back to back", async () => {
    const { room, p1, p2 } = await twoPlayers();
    const next = freshRoom();
    p1.command({ type: "move", to: next, gold: 1 });
    p2.command({ type: "move", to: next, gold: 2 });

    expect(await p1.closed).toEqual({ code: CloseCode.Moved, reason: next });
    const second = await Promise.race([p2.closed, sleep(1500).then(() => "p2 is still waiting")]);
    expect(second).toEqual({ code: CloseCode.Moved, reason: next });
    expect(await owedBy(env.ROOMS, room)).toEqual([]);
  });

  it("does not let one delivery that fails hold up the ones after it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { room, p1, p2 } = await twoPlayers(freshRoom(), "/edge");
    const next = freshRoom();
    p1.command({ type: "move", to: `nowhere-${next}`, gold: 1 });
    p2.command({ type: "move", to: next, gold: 2 });

    expect(await p2.closed).toEqual({ code: CloseCode.Moved, reason: next });
    error.mockRestore();
    const owed = await owedBy(env.EDGE, room);
    expect(owed).toHaveLength(1);
    expect(JSON.parse(owed[0]!).move.player).toBe("p1");
  });
});

describe("commits", () => {
  it("saves nothing when a finished match cannot be written down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { room, p1 } = await twoPlayers(freshRoom(), "/edge");
    const id = p1.command({ type: "edge:finishBig" } as never);
    expect(await p1.next("reject")).toEqual({ t: "reject", id, reason: "internal_error" });
    error.mockRestore();

    expect((await storedIn(env.EDGE, room)).state.total).toBe(0);
    expect(await owedBy(env.EDGE, room)).toEqual([]);
  });

  it("keeps the seat of a player whose handover cannot be written down, also after a restart", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { room, p1 } = await twoPlayers(freshRoom(), "/edge");
    const id = p1.command({ type: "edge:carryBad", to: freshRoom() } as never);
    expect(await p1.next("reject")).toEqual({ t: "reject", id, reason: "internal_error" });
    error.mockRestore();

    expect((await storedIn(env.EDGE, room)).players).toEqual(["p1", "p2"]);

    await evictDurableObject(env.EDGE.get(env.EDGE.idFromName(room)));
    const back = await connect(room, "p1", {}, "/edge");
    expect((await back.next("welcome")).state.total).toBe(0);
  });

  it("takes back what a refused hook wrote to the room's database itself", async () => {
    const { room, p1 } = await twoPlayers(freshRoom(), "/edge");
    const id = p1.command({ type: "edge:scribble" } as never);
    expect(await p1.next("reject")).toEqual({ t: "reject", id, reason: "changed_my_mind" });

    const tables = await runInDurableObject(env.EDGE.get(env.EDGE.idFromName(room)), (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'notes'")
        .toArray(),
    );
    expect(tables).toEqual([]);
  });
});
