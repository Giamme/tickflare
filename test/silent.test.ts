import { afterEach, describe, expect, it } from "vitest";
import { applyPatch } from "../src/patch.js";
import { CloseCode, type ServerMessage } from "../src/protocol.js";
import { freshRoom, sleep, until, upgrade } from "./helpers.js";
import type { TickState } from "./worker.js";

const sockets: WebSocket[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
afterEach(() => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  for (const ws of sockets.splice(0)) {
    try {
      ws.close(1000, "test_done");
    } catch {
      // Already closed.
    }
  }
});

/** A seat in a room that closes connections after 600 ms of silence, or in one that waits two minutes. */
async function sit(room: string, player: string, prefix = "/quiet") {
  const response = await upgrade(`${prefix}/${room}?player=${player}&v=3`);
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  const frames: ServerMessage<TickState>[] = [];
  let state: TickState | undefined;
  let end: { code: number; reason: string } | undefined;
  ws.addEventListener("message", (event) => {
    if (event.data === "pong") return;
    const frame = JSON.parse(event.data as string) as ServerMessage<TickState>;
    frames.push(frame);
    if (frame.t === "welcome" || frame.t === "state") state = frame.state;
    if (frame.t === "patch") state = applyPatch(state!, frame.p);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => {
      end = { code: event.code, reason: event.reason };
      // As a client that is there after all does: it answers the close.
      try {
        ws.close(1000, "");
      } catch {
        // Closed already.
      }
      resolve(end);
    });
  });
  ws.accept();
  sockets.push(ws);
  let id = 1;
  return {
    ws,
    frames,
    closed,
    end: () => end,
    state: () => state,
    command: (data: unknown) => ws.send(JSON.stringify({ t: "cmd", id: id++, data })),
    /** Says something every 50 ms, as a client's keepalive does every 25 seconds. */
    keep(what: () => void) {
      timers.push(setInterval(what, 50));
    },
  };
}

describe("a connection that has gone silent", () => {
  it("is closed by a ticking room, and the player is away, once", async () => {
    const room = freshRoom();
    const there = await sit(room, "p1");
    there.keep(() => there.ws.send("ping"));
    const silent = await sit(room, "p2");
    const started = Date.now();

    expect(await silent.closed).toEqual({ code: CloseCode.Silent, reason: "silent" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(590);
    await until(
      () => there.frames.some((frame) => frame.t === "presence" && frame.set?.[0]?.id === "p2" && !frame.set[0].connected),
      "the others to be told",
    );
    await until(() => there.state()?.log.includes("gone:p2") === true, "onDisconnect");

    // The close was answered, which is not a second drop. And keepalives alone kept the other one.
    await sleep(700);
    expect(there.state()!.log.filter((entry) => entry === "gone:p2")).toHaveLength(1);
    expect(there.end()).toBeUndefined();
  });

  it("is not one that sends commands", async () => {
    const room = freshRoom();
    const busy = await sit(room, "p1");
    busy.keep(() => busy.command({ type: "bump" }));
    await sleep(1300);
    expect(busy.end()).toBeUndefined();
    expect(busy.state()!.bumps).toBeGreaterThan(3);
  });

  it("is left alone by a room that is not ticking: it costs nothing there", async () => {
    const room = freshRoom();
    const p1 = await sit(room, "p1");
    p1.command({ type: "stop" });
    await until(() => p1.state()?.phase === "lobby", "the simulation to stop");
    await sleep(1300);
    expect(p1.end()).toBeUndefined();

    // Once it ticks again, silence counts from when the room last heard something: the command.
    p1.command({ type: "start" });
    expect(await p1.closed).toEqual({ code: CloseCode.Silent, reason: "silent" });
  });

  it("comes back as any dropped player does", async () => {
    const room = freshRoom();
    const first = await sit(room, "p1");
    expect((await first.closed).code).toBe(CloseCode.Silent);

    const again = await sit(room, "p1");
    again.keep(() => again.ws.send("ping"));
    await until(() => again.frames.some((frame) => frame.t === "welcome"), "the welcome");
    const welcome = again.frames.find((frame) => frame.t === "welcome")!;
    expect(welcome.players).toEqual([{ id: "p1", connected: true }]);
    await sleep(900);
    expect(again.end()).toBeUndefined();
  });

  it("is given two minutes by default", async () => {
    const room = freshRoom();
    const quiet = await sit(room, "p1", "/ticks");
    await sleep(1300);
    expect(quiet.end()).toBeUndefined();
  });
});
