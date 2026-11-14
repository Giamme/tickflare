import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { recentMatches } from "../src/server/matches.js";
import { pieces, ROW_BYTES } from "../src/server/storage.js";
import { connect, freshRoom, sleep, type Connection } from "./helpers.js";
import { BLOB, initialShapes, SCRIPTS, type Holder } from "./shapes.js";

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe("cutting a text into pieces that fit in a row", () => {
  it("leaves a text that fits as it is, without measuring it", () => {
    const text = "x".repeat(1000);
    expect(pieces(text)).toEqual([text]);
    expect(pieces("")).toEqual([""]);
    expect(pieces("é".repeat(ROW_BYTES / 3))).toHaveLength(1);
  });

  it("cuts by bytes, not by characters", () => {
    const ascii = "x".repeat(25);
    expect(pieces(ascii, 10).map((piece) => piece.length)).toEqual([10, 10, 5]);
    // Three bytes each: three to a piece of ten bytes.
    expect(pieces("日".repeat(7), 10)).toEqual(["日日日", "日日日", "日"]);
    // A text of one-byte characters that is longer than a third of the limit still fits whole.
    expect(pieces("x".repeat(9), 10)).toEqual(["xxxxxxxxx"]);
  });

  it("never cuts a character in two", () => {
    // Four bytes each, and two UTF-16 units: the cut must not fall between the two.
    for (const limit of [4, 5, 6, 7, 8, 9, 10, 11]) {
      for (const lead of ["", "a", "ab", "é", "日"]) {
        const text = lead + "🎲".repeat(9) + "z";
        const cut = pieces(text, limit);
        expect(cut.join(""), `limit ${limit}, lead ${lead}`).toBe(text);
        for (const piece of cut) {
          expect(bytes(piece), `limit ${limit}, lead ${lead}`).toBeLessThanOrEqual(limit);
          // A piece that is well formed survives the trip to UTF-8 and back.
          expect(new TextDecoder().decode(new TextEncoder().encode(piece))).toBe(piece);
        }
      }
    }
  });

  it("puts any text back together", () => {
    const alphabet = ["a", "é", "日", "🎲", '"', "\\", "\n"];
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let round = 0; round < 200; round++) {
      const text = Array.from({ length: Math.floor(next() * 400) }, () => alphabet[Math.floor(next() * alphabet.length)]).join("");
      const limit = 4 + Math.floor(next() * 60);
      const cut = pieces(text, limit);
      expect(cut.join("")).toBe(text);
      expect(cut.every((piece) => bytes(piece) <= limit && piece.length > 0)).toBe(true);
    }
  });

  it("cuts the test's own long text into several", () => {
    expect(bytes(BLOB)).toBeGreaterThan(2 * ROW_BYTES);
    const cut = pieces(BLOB);
    expect(cut.length).toBeGreaterThanOrEqual(3);
    expect(cut.every((piece) => bytes(piece) <= ROW_BYTES)).toBe(true);
    expect(cut.join("")).toBe(BLOB);
  });
});

function after(...scripts: string[]): unknown {
  const room: Holder = { state: initialShapes() };
  for (const script of scripts) SCRIPTS[script]!(room);
  return JSON.parse(JSON.stringify(room.state));
}

const run = (player: Connection, script: string, then?: "reject" | "finish") =>
  void player.raw(JSON.stringify({ t: "cmd", id: 1, data: { script, then } }));

/** How the room's state lies in storage: the length of its first row, and of each further piece. */
const rows = (rooms: DurableObjectNamespace, room: string) =>
  runInDurableObject(rooms.get(rooms.idFromName(room)), (_instance, state) => {
    const sql = state.storage.sql;
    const first = sql.exec<{ state: string }>("SELECT state FROM tickflare_room").one().state;
    const table = sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'tickflare_parts'").toArray().length > 0;
    const rest = table
      ? sql.exec<{ owner: string; part: string }>("SELECT owner, part FROM tickflare_parts ORDER BY owner, n").toArray()
      : [];
    return { table, first: bytes(first), rest: rest.map((row) => `${row.owner}:${bytes(row.part) <= ROW_BYTES ? "fits" : "too long"}`) };
  });

// A row may hold 2 MB, and the state used to be one row.
describe.each([
  ["following a hook's writes", "/shapes", () => env.SHAPES as unknown as DurableObjectNamespace],
  ["comparing the whole state", "/plain", () => env.PLAIN as unknown as DurableObjectNamespace],
])("a state too long for one row, %s", (_mode, prefix, rooms) => {
  it("stays in one row, and has no table for more, while it fits", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, prefix);
    await p1.next("welcome");
    run(p1, "everything");
    await p1.next("state");

    expect(await rows(rooms(), room)).toMatchObject({ table: false, rest: [] });
  });

  it("is saved across rows, and read back whole when the room returns to memory", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, prefix);
    await p1.next("welcome");
    run(p1, "bloat");
    expect((await p1.next("state")).state).toEqual(after("bloat"));
    await p1.next("ack");

    const stored = await rows(rooms(), room);
    expect(stored.first).toBeLessThanOrEqual(ROW_BYTES);
    expect(stored.rest.length).toBeGreaterThanOrEqual(2);
    expect(stored.rest.every((row) => row === "state:fits")).toBe(true);

    await evictDurableObject(rooms().get(rooms().idFromName(room)));
    run(p1, "move");
    expect((await p1.next("state")).state).toEqual(after("bloat", "move"));
    const p2 = await connect(room, "p2", {}, prefix);
    expect((await p2.next("welcome")).state).toEqual(after("bloat", "move"));
  });

  it("goes back to one row when it fits again", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, prefix);
    await p1.next("welcome");
    for (const script of ["bloat", "shrink"]) {
      run(p1, script);
      await p1.next("state");
      await p1.next("ack");
    }

    expect(await rows(rooms(), room)).toMatchObject({ table: true, rest: [] });
    await evictDurableObject(rooms().get(rooms().idFromName(room)));
    const p2 = await connect(room, "p2", {}, prefix);
    expect((await p2.next("welcome")).state).toEqual(after("bloat", "shrink"));
  });

  it("is not left half written by a hook that is refused", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, prefix);
    await p1.next("welcome");
    run(p1, "bloat", "reject");
    await p1.next("reject");
    run(p1, "mark");
    await p1.next("state");
    await p1.next("ack");

    expect(await rows(rooms(), room)).toMatchObject({ table: false, rest: [] });
    // And the room still knows that nothing of its state is elsewhere.
    run(p1, "bloat");
    expect((await p1.next("state")).state).toEqual(after("mark", "bloat"));
    expect((await rows(rooms(), room)).rest.length).toBeGreaterThanOrEqual(2);
  });

  it("hands a recording too long for one row to R2 whole", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, prefix);
    await p1.next("welcome");
    run(p1, "mark", "finish");
    await p1.next("state");

    let match;
    for (let waited = 0; waited < 8000 && !match; waited += 100) {
      match = (await recentMatches(env.DB, 100)).find((m) => m.room === room);
      if (!match) await sleep(100);
    }
    expect(match?.replayKey).toBeTruthy();
    const replay = (await (await env.REPLAYS.get(match!.replayKey!))!.json()) as { recording: string };
    expect(replay.recording === BLOB).toBe(true);
    // Delivered, and nothing of it left behind.
    expect((await rows(rooms(), room)).rest).toEqual([]);
  });
});
