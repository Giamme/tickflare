import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { connect, freshRoom, type Connection } from "./helpers.js";
import { initialShapes, SCRIPTS, type Holder } from "./shapes.js";

/** What the scripts leave of the initial state when they are run on a plain copy of it. */
function after(...scripts: string[]): string {
  const room: Holder = { state: initialShapes() };
  for (const script of scripts) SCRIPTS[script]!(room);
  return JSON.stringify(room.state);
}

const run = (player: Connection, script: string, then?: "reject" | "throw") =>
  (player.raw(JSON.stringify({ t: "cmd", id: 1, data: { script, then } })), undefined);

/** The state of a room as it is in storage. */
const saved = (rooms: DurableObjectNamespace, room: string) =>
  runInDurableObject(rooms.get(rooms.idFromName(room)), (_instance, state) =>
    state.storage.sql.exec<{ state: string }>("SELECT state FROM tickflare_room").one().state,
  );

const CHANGES = ["mark", "move", "spawn", "remove", "copy", "replace", "shuffle", "everything", "identity", "plainClone"];

// Every room behaves the same whether the kernel follows a hook's writes or compares the whole
// state after it. The first is the default; the second is `trackChanges = false`.
describe.each([
  ["tracked", "/shapes", () => env.SHAPES as unknown as DurableObjectNamespace],
  ["plain", "/plain", () => env.PLAIN as unknown as DurableObjectNamespace],
])("a hook's changes to the state, %s", (mode, prefix, rooms) => {
  async function seated(room = freshRoom()) {
    const p1 = await connect(room, "p1", {}, prefix);
    const welcome = await p1.next("welcome");
    expect(JSON.stringify(welcome.state)).toBe(after());
    return { room, p1, seq: welcome.seq };
  }

  it.each(CHANGES)("%s: is sent and saved as it was made", async (script) => {
    const { room, p1, seq } = await seated();
    run(p1, script);

    const frame = await p1.next("state");
    expect(JSON.stringify(frame.state)).toBe(after(script));
    expect(frame.seq).toBe(seq + 1);
    expect(await p1.next("ack")).toMatchObject({ seq: seq + 1 });
    expect(await saved(rooms(), room)).toBe(after(script));
  });

  it.each(CHANGES.flatMap((script) => [[script, "reject"] as const, [script, "throw"] as const]))(
    "%s, then %s: leaves no trace",
    async (script, then) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const { room, p1, seq } = await seated();
      run(p1, script, then);
      expect(await p1.next("reject")).toMatchObject({ reason: then === "reject" ? "changed_my_mind" : "internal_error" });

      // The next change is made to the state as it was, down to the order of its keys.
      run(p1, "mark");
      const frame = await p1.next("state");
      expect(JSON.stringify(frame.state)).toBe(after("mark"));
      expect(frame.seq).toBe(seq + 1);
      await p1.next("ack");
      expect(await saved(rooms(), room)).toBe(after("mark"));
      error.mockRestore();
    },
  );

  it("carries one hook's changes into the next", async () => {
    const { room, p1 } = await seated();
    const scripts = ["spawn", "copy", "move", "shuffle", "replace", "remove", "mark"];
    for (const [done, script] of scripts.entries()) {
      run(p1, script);
      expect(JSON.stringify((await p1.next("state")).state)).toBe(after(...scripts.slice(0, done + 1)));
      await p1.next("ack");
    }
    expect(await saved(rooms(), room)).toBe(after(...scripts));

    // And a second player is welcomed to the same.
    const p2 = await connect(room, "p2", {}, prefix);
    expect(JSON.stringify((await p2.next("welcome")).state)).toBe(after(...scripts));
  });

  it.each(["same", "nothing"])("%s: a hook that changes nothing sends and saves nothing", async (script) => {
    const { room, p1, seq } = await seated();
    const before = await saved(rooms(), room);
    run(p1, script);
    expect(await p1.next("ack")).toMatchObject({ seq });
    expect(await saved(rooms(), room)).toBe(before);
  });

  it("refuses a state that JSON cannot hold, and keeps the one it had", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { p1, seq } = await seated();
    run(p1, "bigint");
    expect(await p1.next("reject")).toMatchObject({ reason: "internal_error" });
    run(p1, "mark");
    expect(await p1.next("state")).toMatchObject({ seq: seq + 1, state: { total: 1 } });
    error.mockRestore();
  });

  it(mode === "tracked" ? "cannot clone the state inside a hook, and says what to use" : "can clone the state inside a hook", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { p1 } = await seated();
    run(p1, "clone");
    if (mode === "tracked") {
      expect(await p1.next("reject")).toMatchObject({ reason: "internal_error" });
      expect(error.mock.calls.flat().join(" ")).toContain("plain(value)");
    } else {
      expect(await p1.next("state")).toMatchObject({ state: { total: 1 } });
    }
    error.mockRestore();
  });
});
