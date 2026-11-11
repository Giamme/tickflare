import { exports } from "cloudflare:workers";
import { afterEach, expect } from "vitest";
import { applyPatch } from "../src/patch.js";
import type { ServerMessage } from "../src/protocol.js";
import type { TestCommand, TestState } from "./worker.js";

type Message = ServerMessage<TestState>;

export interface Connection {
  ws: WebSocket;
  /** The next frame from the room, which must be of type `t`. */
  next<T extends Message["t"]>(t: T): Promise<Extract<Message, { t: T }>>;
  /** Send a command and return the id it was sent under. */
  command(command: TestCommand): number;
  /** Ask to give up the seat and return the id the request was sent under. */
  leave(): number;
  /** Send a raw frame, for the malformed cases. */
  raw(frame: string | ArrayBuffer): void;
  /** Resolves when the room closes the connection. */
  closed: Promise<{ code: number; reason: string }>;
}

const open: WebSocket[] = [];
let rooms = 0;

afterEach(() => {
  for (const ws of open.splice(0)) {
    try {
      ws.close(1000, "test_done");
    } catch {
      // Already closed.
    }
  }
});

/** A room name no other test uses. */
export function freshRoom(): string {
  return `room-${Date.now()}-${rooms++}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function upgrade(path: string, headers: Record<string, string> = {}): Promise<Response> {
  return exports.default.fetch(`https://tickflare.test${path}`, {
    headers: { Upgrade: "websocket", ...headers },
  });
}

export async function connect(
  room: string,
  player: string,
  headers: Record<string, string> = {},
): Promise<Connection> {
  const response = await upgrade(`/rooms/${room}?player=${player}`, headers);
  expect(response.status).toBe(101);
  const ws = response.webSocket!;

  const inbox: Message[] = [];
  const waiting: ((message: Message) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as Message;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason }));
  });
  ws.accept();
  open.push(ws);

  let nextId = 1;
  return {
    ws,
    closed,
    async next(t) {
      const message =
        inbox.shift() ??
        (await new Promise<Message>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`No "${t}" frame within 2s`)), 2000);
          waiting.push((m) => {
            clearTimeout(timer);
            resolve(m);
          });
        }));
      expect(message.t, JSON.stringify(message)).toBe(t);
      return message as Extract<Message, { t: typeof t }>;
    },
    command(command) {
      const id = nextId++;
      ws.send(JSON.stringify({ t: "cmd", id, data: command }));
      return id;
    },
    leave() {
      const id = nextId++;
      ws.send(JSON.stringify({ t: "leave", id }));
      return id;
    },
    raw(frame) {
      ws.send(frame);
    },
  };
}

/** Two seated players with the join chatter already consumed. */
export async function twoPlayers(room = freshRoom()) {
  const p1 = await connect(room, "p1");
  await p1.next("welcome");
  const p2 = await connect(room, "p2");
  await p2.next("welcome");
  await p1.next("state");
  await p1.next("presence");
  return { room, p1, p2 };
}

export async function until(condition: () => boolean, what = "condition"): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > 3000) throw new Error(`Timed out waiting for ${what}`);
    await sleep(5);
  }
}

/**
 * A connection that rebuilds the state from frames the way the real client
 * does, for rooms that tick. `prefix` picks the fixture room class.
 */
export async function follow<State>(prefix: string, room: string, player: string) {
  const response = await upgrade(`${prefix}/${room}?player=${player}`);
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  type Frame = ServerMessage<State>;
  const seen = {
    ws,
    frames: [] as Frame[],
    state: undefined as State | undefined,
    tick: 0,
    /** The state as this client saw it at each tick. */
    history: new Map<number, State>(),
    send(command: unknown) {
      ws.send(JSON.stringify({ t: "cmd", id: seen.frames.length + 1, data: command }));
    },
    of<T extends Frame["t"]>(t: T) {
      return seen.frames.filter((f): f is Extract<Frame, { t: T }> => f.t === t);
    },
  };
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as Frame;
    seen.frames.push(frame);
    if (frame.t === "welcome" || frame.t === "state") seen.state = frame.state;
    if (frame.t === "patch") seen.state = applyPatch(seen.state!, frame.p);
    if (frame.t === "welcome" || frame.t === "patch" || (frame.t === "state" && frame.tick !== undefined)) {
      seen.tick = frame.tick!;
      seen.history.set(seen.tick, seen.state!);
    }
  });
  ws.accept();
  open.push(ws);
  await until(() => seen.state !== undefined);
  return seen;
}
