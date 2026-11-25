import { evictDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRejected, RoomClient } from "../src/client/index.js";
import { applyPatch } from "../src/patch.js";
import { CloseCode, type Player, type ServerMessage } from "../src/protocol.js";
import { LINGER_MS, SpectatorLine } from "../src/server/spectators.js";
import { follow, freshRoom, sleep, until, upgrade } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";
import type { WatchedState } from "./worker.js";

/**
 * Spectators: connections that watch a room without a seat in it, which a
 * room may keep behind its players. The fixtures: `/watched` in event mode
 * with two places to watch from, `/late` the same 400 ms behind, `/closed`
 * and `/hidden` with a `view()` of their own, the second with a
 * `spectatorView()` too, and `/lateticks` ticking, 300 ms behind.
 */
const watchers: WebSocket[] = [];
afterEach(() => {
  for (const ws of watchers.splice(0)) {
    try {
      ws.close(1000, "test_done");
    } catch {
      // Already closed.
    }
  }
});

/** A spectator's connection, which keeps what it is sent and when. */
async function watch<View = WatchedState>(prefix: string, room: string, id: string) {
  const response = await upgrade(`${prefix}/${room}?player=${id}&spectate=1`);
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  type Frame = ServerMessage<View>;
  const seen = {
    ws,
    frames: [] as { frame: Frame; at: number }[],
    state: undefined as View | undefined,
    tick: 0,
    players: undefined as Player[] | undefined,
    messages: [] as unknown[],
    closed: undefined as { code: number; reason: string } | undefined,
    of<T extends Frame["t"]>(t: T) {
      return seen.frames.flatMap(({ frame }) => (frame.t === t ? [frame as Extract<Frame, { t: T }>] : []));
    },
    /** When the first frame of this kind came. */
    when(t: Frame["t"]) {
      return seen.frames.find(({ frame }) => frame.t === t)?.at;
    },
  };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as Frame;
    seen.frames.push({ frame, at: Date.now() });
    if (frame.t === "spectating") seen.players = frame.players;
    if (frame.t === "state") {
      seen.state = frame.state;
      seen.tick = frame.tick ?? 0;
    }
    if (frame.t === "patch") {
      seen.state = applyPatch(seen.state!, frame.p);
      seen.tick = frame.tick;
    }
    if (frame.t === "presence") seen.players = frame.players ?? seen.players;
    if (frame.t === "msg") seen.messages.push(frame.d);
  });
  ws.addEventListener("close", (event) => {
    seen.closed = { code: event.code, reason: event.reason };
  });
  ws.accept();
  watchers.push(ws);
  return seen;
}

const play = (prefix: string, room: string, player = "p1") => follow<WatchedState>(prefix, room, player);

describe("a room that takes spectators", () => {
  it("shows a spectator what the players see, and keeps it up to date, without a seat", async () => {
    const room = freshRoom();
    const p1 = await play("/watched", room);
    p1.send({ type: "add", n: 2 });
    await until(() => p1.state!.count === 2);

    const s1 = await watch("/watched", room, "s1");
    await until(() => s1.state !== undefined);
    // Who they are and how the room runs first, then the view.
    expect(s1.frames.map(({ frame }) => frame.t).slice(0, 2)).toEqual(["spectating", "state"]);
    expect(s1.of("spectating")[0]).toMatchObject({ v: 5, you: "s1", tickRate: 0, delay: 0 });
    expect(s1.state).toMatchObject({ count: 2, hands: { p1: 7 } });

    p1.send({ type: "add", n: 3 });
    await until(() => s1.state!.count === 5);
    expect(s1.of("patch")).toHaveLength(1);

    // No seat: nobody was told of a join, no hook for one ran, and the player is alone in the room.
    expect(p1.of("presence")).toHaveLength(0);
    expect(p1.of("welcome")[0]!.players).toEqual([{ id: "p1", connected: true }]);
    expect(s1.state!.log).toEqual(["join:p1", "watch:s1:unseated"]);
    expect(s1.players).toEqual([{ id: "p1", connected: true }]);
  });

  it("tells a spectator who comes and goes, and what the room broadcasts, but not what it tells one player", async () => {
    const room = freshRoom();
    const p1 = await play("/watched", room);
    const s1 = await watch("/watched", room, "s1");
    await until(() => s1.state !== undefined);

    const p2 = await play("/watched", room, "p2");
    await until(() => s1.players?.length === 2);
    expect(s1.players).toEqual([
      { id: "p1", connected: true },
      { id: "p2", connected: true },
    ]);
    p2.ws.close(1000, "bye");
    await until(() => s1.players?.[1]?.connected === false);

    p1.send({ type: "shout", text: "hello" });
    await until(() => s1.messages.length === 1);
    await until(() => p1.of("msg").length === 2);
    expect(s1.messages).toEqual([{ said: "hello", by: "p1" }]);
  });

  it("refuses what a spectator sends", async () => {
    const room = freshRoom();
    const p1 = await play("/watched", room);
    const s1 = await watch("/watched", room, "s1");
    await until(() => s1.state !== undefined);
    s1.ws.send(JSON.stringify({ t: "cmd", id: 1, data: { type: "add", n: 5 } }));
    s1.ws.send(JSON.stringify({ t: "leave", id: 2 }));
    await until(() => s1.of("reject").length === 2);
    expect(s1.of("reject")).toEqual([
      { t: "reject", id: 1, reason: "spectator" },
      { t: "reject", id: 2, reason: "spectator" },
    ]);
    // Nothing happened, and they are still watching.
    p1.send({ type: "add", n: 1 });
    await until(() => s1.state!.count === 1);
    expect(s1.closed).toBeUndefined();
  });

  it("takes as many as it says, counts each once, and tells the room how many there are", async () => {
    const room = freshRoom();
    const p1 = await play("/watched", room);
    const s1 = await watch("/watched", room, "s1");
    const s2 = await watch("/watched", room, "s2");
    await until(() => s2.state !== undefined);

    const s3 = await watch("/watched", room, "s3");
    await until(() => s3.closed !== undefined);
    expect(s3.closed).toEqual({ code: CloseCode.RoomFull, reason: "spectators_full" });
    expect(s3.frames).toHaveLength(0);

    // The same spectator again takes the place they had: the newest connection wins.
    const again = await watch("/watched", room, "s1");
    await until(() => again.state !== undefined && s1.closed !== undefined);
    expect(s1.closed).toEqual({ code: CloseCode.Replaced, reason: "replaced" });

    p1.send({ type: "census" });
    await until(() => p1.state!.log.includes("watching:2"));

    // A place is free once a spectator has gone.
    s2.ws.close(1000, "bye");
    await until(() => s2.closed !== undefined);
    const s4 = await watch("/watched", room, "s4");
    await until(() => s4.state !== undefined);
  });

  it("takes none unless it says so, and a lockstep room takes none at all", async () => {
    const plain = await watch("/rooms", freshRoom(), "s1");
    await until(() => plain.closed !== undefined);
    expect(plain.closed).toEqual({ code: CloseCode.JoinRejected, reason: "no_spectators" });

    const turns = await watch("/turns", freshRoom(), "s1");
    await until(() => turns.closed !== undefined);
    expect(turns.closed).toEqual({ code: CloseCode.JoinRejected, reason: "no_spectators" });
  });

  it("lets the room turn a spectator away, and keeps what the room noted of one it took", async () => {
    const room = freshRoom();
    const p1 = await play("/watched", room);
    const banned = await watch("/watched", room, "banned-1");
    await until(() => banned.closed !== undefined);
    expect(banned.closed).toEqual({ code: CloseCode.JoinRejected, reason: "banned" });

    // A player may watch too, if the room lets them: it is told they hold a seat.
    const own = await watch("/watched", room, "p1");
    await until(() => own.state !== undefined);
    await until(() => p1.state!.log.length === 2);
    expect(p1.state!.log).toEqual(["join:p1", "watch:p1:seated"]);
    // Their seat's connection is not the one that was replaced.
    expect(p1.ws.readyState).toBe(1);
  });

  it("does not show spectators what a room hides from its players, until the room says what they may see", async () => {
    const closed = freshRoom();
    await follow<unknown>("/closed", closed, "p1");
    const refused = await watch("/closed", closed, "s1");
    await until(() => refused.closed !== undefined);
    expect(refused.closed).toEqual({ code: CloseCode.JoinRejected, reason: "no_spectators" });

    const hidden = freshRoom();
    const p1 = await follow<{ count: number; hand: number }>("/hidden", hidden, "p1");
    const s1 = await watch<{ count: number; hands: number }>("/hidden", hidden, "s1");
    await until(() => s1.state !== undefined);
    expect(s1.state).toEqual({ count: 0, hands: 1 });
    p1.send({ type: "add", n: 4 });
    await until(() => s1.state!.count === 4);
    expect(s1.state).toEqual({ count: 4, hands: 1 });
    expect(p1.state).toEqual({ count: 4, hand: 7 });
  });

  it("takes a spectator by the gateway's header or by the query, whichever it is given", async () => {
    const room = freshRoom();
    const stub = env.WATCHED.get(env.WATCHED.idFromName(room));
    const first = async (url: string, headers: Record<string, string>) => {
      const response = await stub.fetch(new Request(url, { headers: { Upgrade: "websocket", ...headers } }));
      const ws = response.webSocket!;
      const frame = new Promise<{ t: string; you: string }>((resolve) =>
        ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string) as { t: string; you: string }), { once: true }),
      );
      ws.accept();
      watchers.push(ws);
      return frame;
    };
    // As `routeToRoom` names them.
    expect(await first("https://tickflare.test/watched/x", { "x-tickflare-spectator": "s1" })).toMatchObject({ t: "spectating", you: "s1" });
    // As a gateway of one's own might: the player's header, and the query the client sent.
    expect(await first("https://tickflare.test/watched/x?spectate=1", { "x-tickflare-player": "s2" })).toMatchObject({ t: "spectating", you: "s2" });
  });

  it("is empty with nobody but spectators connected", async () => {
    const room = freshRoom();
    const p1 = await play("/watched", room);
    const s1 = await watch("/watched", room, "s1");
    await until(() => s1.state !== undefined);
    p1.send({ type: "kick", who: "p1" });
    await until(() => s1.state!.log.includes("empty"));
    expect(s1.players).toEqual([]);
    expect(s1.closed).toBeUndefined();
  });

  it("gives the spectators their view again after it has slept", async () => {
    const room = freshRoom();
    const p1 = await play("/watched", room);
    const s1 = await watch("/watched", room, "s1");
    await until(() => s1.state !== undefined);
    p1.send({ type: "add", n: 1 });
    await until(() => s1.state!.count === 1);

    await evictDurableObject(env.WATCHED.get(env.WATCHED.idFromName(room)));
    p1.send({ type: "add", n: 2 });
    await until(() => s1.state!.count === 3);
    // What they held is not known to the room that woke, so it sends the whole view.
    expect(s1.of("state")).toHaveLength(2);
    expect(s1.players).toEqual([{ id: "p1", connected: true }]);
  });
});

describe("a room that keeps its spectators behind", () => {
  it("makes the first spectator wait for the view, and sends nothing of the room before", async () => {
    const room = freshRoom();
    const p1 = await play("/late", room);
    p1.send({ type: "add", n: 2 });
    await until(() => p1.state!.count === 2);

    const s1 = await watch("/late", room, "s1");
    await until(() => s1.frames.length > 0);
    // In at once, and told nothing of the game: not even who plays.
    expect(s1.frames).toHaveLength(1);
    expect(s1.frames[0]!.frame).toEqual({ t: "spectating", v: 5, you: "s1", tickRate: 0, delay: 400, players: [] });
    await sleep(200);
    expect(s1.frames).toHaveLength(1);

    await until(() => s1.state !== undefined && s1.players!.length > 0);
    expect(s1.when("state")! - s1.when("spectating")!).toBeGreaterThanOrEqual(380);
    expect(s1.state).toMatchObject({ count: 2 });
    expect(s1.players).toEqual([{ id: "p1", connected: true }]);
  });

  it("sends spectators every change, every arrival and every broadcast that much later, in order", async () => {
    const room = freshRoom();
    const p1 = await play("/late", room);
    const s1 = await watch("/late", room, "s1");
    await until(() => s1.state !== undefined && s1.players!.length === 1);

    const before = p1.frames.length;
    const from = Date.now();
    p1.send({ type: "add", n: 1 });
    p1.send({ type: "shout", text: "one" });
    p1.send({ type: "add", n: 1 });
    const p2 = await play("/late", room, "p2");
    await until(() => p1.state!.count === 2 && p1.of("presence").length === 1 && p1.of("msg").length === 2);
    // The player has it all, and the spectator none of it yet.
    expect(p1.frames.length).toBeGreaterThan(before);
    expect(s1.state!.count).toBe(0);
    expect(s1.messages).toEqual([]);
    expect(s1.players).toHaveLength(1);

    // In the order the player was sent them: two changes, what was said, and the arrival, which
    // changes the state too, since `onJoin` deals a hand. What was said to the player alone is not there.
    const told = p1.frames
      .slice(before)
      .filter((frame) => frame.t === "patch" || frame.t === "presence" || (frame.t === "msg" && "said" in (frame.d as object)))
      .map((frame) => frame.t);
    expect(told.filter((t) => t === "patch")).toHaveLength(3);
    const late = () => s1.frames.filter(({ at }) => at >= from);
    await until(() => late().length >= told.length);
    for (const { at } of late()) expect(at - from).toBeGreaterThanOrEqual(380);
    expect(late().map(({ frame }) => frame.t)).toEqual(told);
    expect(s1.state!.count).toBe(2);
    expect(s1.messages).toEqual([{ said: "one", by: "p1" }]);
    expect(p2.state!.count).toBe(2);
  });

  it("welcomes a second spectator with what the first has been shown, not with the room as it is", async () => {
    const room = freshRoom();
    const p1 = await play("/late", room);
    const s1 = await watch("/late", room, "s1");
    await until(() => s1.state !== undefined);

    p1.send({ type: "add", n: 9 });
    await until(() => p1.state!.count === 9);
    const s2 = await watch("/late", room, "s2");
    await until(() => s2.state !== undefined);
    // At once, since there is a view that has been let out, and it is the one from before the change.
    expect(s2.when("state")! - s2.when("spectating")!).toBeLessThan(200);
    expect(s2.state!.count).toBe(0);
    expect(s2.of("spectating")[0]!.players).toEqual([{ id: "p1", connected: true }]);
    await until(() => s1.state!.count === 9 && s2.state!.count === 9);
  });

  it("keeps back a broadcast and a departure that have no change to wait behind", async () => {
    const room = freshRoom();
    const p1 = await play("/late", room);
    const s1 = await watch("/late", room, "s1");
    await until(() => s1.state !== undefined && s1.players!.length === 1);

    const said = Date.now();
    p1.send({ type: "shout", text: "alone" });
    await until(() => s1.messages.length === 1);
    expect(s1.frames.at(-1)!.at - said).toBeGreaterThanOrEqual(380);

    await play("/late", room, "p2");
    await until(() => s1.players!.length === 2);
    // Removed by the room, which changes nothing in the state.
    const kicked = Date.now();
    p1.send({ type: "kick", who: "p2" });
    await until(() => s1.players!.length === 1);
    expect(s1.frames.at(-1)!.frame.t).toBe("presence");
    expect(s1.frames.at(-1)!.at - kicked).toBeGreaterThanOrEqual(380);
  });

  it("gives its spectators the whole view again when it wakes, whatever woke it", async () => {
    const room = freshRoom();
    const p1 = await play("/late", room);
    const s1 = await watch("/late", room, "s1");
    await until(() => s1.state !== undefined);
    p1.send({ type: "add", n: 1 });
    await until(() => s1.state!.count === 1);

    // The room that wakes does not know what its spectators hold, nor whether something was on
    // its way to them when it was taken out of memory. A command that changes nothing wakes it:
    // no change would ever bring them what they might have missed.
    await evictDurableObject(env.LATE.get(env.LATE.idFromName(room)));
    p1.send({ type: "add", n: 0 });
    await until(() => s1.of("state").length === 2);
    expect(s1.state!.count).toBe(1);
    expect(s1.players).toEqual([{ id: "p1", connected: true }]);
  });

  it("keeps the spectators of a ticking room as far behind, tick after tick, and tells them no clock", async () => {
    const room = freshRoom();
    const p1 = await follow<{ n: number }>("/lateticks", room, "p1");
    const s1 = await watch<{ n: number }>("/lateticks", room, "s1");
    await until(() => s1.of("patch").length >= 10);

    expect(s1.of("spectating")[0]).toEqual({ t: "spectating", v: 5, you: "s1", tickRate: 50, delay: 300, players: [] });
    expect(s1.of("clock")).toHaveLength(0);
    // 300 ms are fifteen ticks. The room may wake late, so not to the tick.
    expect(p1.tick - s1.tick).toBeGreaterThanOrEqual(12);
    expect(p1.tick - s1.tick).toBeLessThanOrEqual(22);
    // Every tick's view in order, each the state of its tick.
    const ticks = s1.frames.flatMap(({ frame }) => (frame.t === "patch" || frame.t === "state" ? [frame.tick!] : []));
    expect(ticks).toEqual([...ticks].sort((a, b) => a - b));
    expect(s1.state!.n).toBe(s1.tick);
    // A broadcast from a tick comes after the patch of that tick.
    await until(() => s1.messages.length >= 1);
    const beat = s1.frames.findIndex(({ frame }) => frame.t === "msg");
    const shown = s1.frames[beat - 1]!.frame;
    expect(shown.t === "patch" && shown.tick).toBe((s1.messages[0] as { beat: number }).beat);
  });

  it("does not tick for spectators alone", async () => {
    const room = freshRoom();
    const p1 = await follow<{ n: number }>("/lateticks", room, "p1");
    const s1 = await watch<{ n: number }>("/lateticks", room, "s1");
    await until(() => s1.of("patch").length >= 3);
    p1.ws.close(1000, "bye");
    // What had happened by then still reaches the spectator, and then nothing more does.
    await until(() => s1.players?.[0]?.connected === false);
    await sleep(450);
    const stoppedAt = s1.tick;
    await sleep(200);
    expect(s1.tick).toBe(stoppedAt);
    expect(s1.closed).toBeUndefined();
  });
});

describe("the spectators' line", () => {
  /** A line that sends to one socket, which keeps what it is sent. */
  const line = () => {
    const sent: { t: string; tick?: number }[] = [];
    const socket = { send: (frame: string) => sent.push(JSON.parse(frame) as { t: string }) } as unknown as WebSocket;
    return { sent, line: new SpectatorLine(() => [socket]) };
  };

  it("lets each frame out when its time has come, and knows what the spectators hold", () => {
    const { sent, line: l } = line();
    l.take({ n: 1 }, 1, 1, 100, 1000);
    l.tell([{ id: "p1", connected: true }], 100, 1000);
    l.take({ n: 2 }, 2, 2, 100, 1050);
    expect(sent).toEqual([]);
    expect(l.shown).toBeUndefined();

    l.release(1100);
    expect(sent.map((frame) => frame.t)).toEqual(["state", "presence"]);
    expect(l.shown).toEqual({ seq: 1, tick: 1, view: { n: 1 } });
    expect(l.players).toEqual([{ id: "p1", connected: true }]);
    l.release(1150);
    expect(sent.map((frame) => frame.t)).toEqual(["state", "presence", "patch"]);
    expect(l.shown).toEqual({ seq: 2, tick: 2, view: { n: 2 } });
    l.stop();
  });

  it("keeps a copy of each view, and queues nothing for a view that did not change", () => {
    const { sent, line: l } = line();
    const state = { n: 1, deep: { x: 1 } };
    l.take(state, 1, 1, 0, 1000);
    state.deep.x = 2;
    expect(l.shown!.view).toEqual({ n: 1, deep: { x: 1 } });
    l.take(state, 2, 2, 0, 1000);
    l.take(state, 2, 3, 0, 1000);
    expect(sent).toHaveLength(2);
    expect(l.shown).toEqual({ seq: 2, tick: 2, view: { n: 1, deep: { x: 2 } } });
    l.stop();
  });

  it("keeps the order when the delay is made shorter", () => {
    const { sent, line: l } = line();
    l.take({ n: 1 }, 1, 1, 500, 1000);
    l.take({ n: 2 }, 2, 2, 100, 1010);
    l.release(1200);
    expect(sent).toEqual([]);
    l.release(1500);
    expect(sent.map((frame) => frame.tick)).toEqual([1, 2]);
    l.stop();
  });

  it("starts over rather than hold more than a room has memory for", () => {
    const { sent, line: l } = line();
    const complaints = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      l.take({ blob: "" }, 0, 0, 0, 1000);
      // A megabyte that changes every time, kept back for a minute. With what goes around it in
      // a frame, the sixteenth is too much.
      for (let i = 1; i <= 15; i++) l.take({ blob: `${i}`.padEnd(1_000_000, "x") }, i, i, 60_000, 1000 + i);
      expect(complaints).not.toHaveBeenCalled();
      expect(l.running).toBe(true);
      l.take({ blob: "16".padEnd(1_000_000, "x") }, 16, 16, 60_000, 1016);
      expect(complaints).toHaveBeenCalledOnce();
      expect(l.running).toBe(false);
      expect(l.shown).toBeUndefined();

      l.take({ blob: "after" }, 18, 18, 0, 1018);
      expect(sent.at(-1)).toMatchObject({ t: "state", state: { blob: "after" } });
    } finally {
      complaints.mockRestore();
      l.stop();
    }
  });

  it("goes on for a while with nobody watching, then stops, and starts over with a whole view", () => {
    const { sent, line: l } = line();
    l.take({ n: 1 }, 1, 1, 0, 1000);
    expect(l.keep(true, 1000)).toBe(true);
    expect(l.keep(false, 2000)).toBe(true);
    expect(l.keep(false, 2000 + LINGER_MS - 1)).toBe(true);
    // Someone came back in time: the count starts again when they leave.
    expect(l.keep(true, 2000 + LINGER_MS)).toBe(true);
    expect(l.keep(false, 3000 + LINGER_MS)).toBe(true);
    expect(l.keep(false, 3000 + 2 * LINGER_MS)).toBe(false);
    expect(l.running).toBe(false);
    expect(l.shown).toBeUndefined();

    l.take({ n: 2 }, 2, 2, 0, 90_000);
    expect(sent.map((frame) => frame.t)).toEqual(["state", "state"]);
    l.stop();
  });
});

describe("RoomClient as a spectator", () => {
  beforeEach(() => {
    WorkerSocket.all = [];
    vi.stubGlobal("WebSocket", WorkerSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const socket of WorkerSocket.all) socket.close();
  });

  it("watches, says so, and sends nothing", async () => {
    const room = freshRoom();
    const p1 = await play("/late", room);
    const seen: string[] = [];
    const client = new RoomClient<WatchedState, { type: "add"; n: number }>(`wss://tickflare.test/late/${room}?player=s1`, {
      spectate: true,
      onMessage: (message) => seen.push(JSON.stringify(message)),
    });
    await until(() => client.status === "open", "the connection");
    expect(client.spectating).toBe(true);
    expect(client.delayMs).toBe(400);
    expect(client.you).toBe("s1");
    // Connected, and waiting for a view that is 400 ms away.
    expect(client.state).toBeUndefined();
    await until(() => client.state !== undefined && client.players.length === 1, "the view");
    expect(client.state).toMatchObject({ count: 0 });

    await expect(client.send({ type: "add", n: 1 })).rejects.toEqual(new CommandRejected("spectator"));
    await expect(client.leave()).rejects.toEqual(new CommandRejected("spectator"));
    expect(client.unconfirmed).toEqual([]);

    p1.send({ type: "add", n: 4 });
    p1.send({ type: "shout", text: "hi" });
    await until(() => client.state!.count === 4 && seen.length === 1, "the change");
    expect(seen).toEqual(['{"said":"hi","by":"p1"}']);

    // A connection that drops is opened again, and goes on from what the others are shown.
    WorkerSocket.all.at(-1)!.drop();
    await until(() => client.status === "connecting");
    await until(() => client.status === "open", "the connection again");
    expect(client.state!.count).toBe(4);
    client.close();
  });
});
