import { exports } from "cloudflare:workers";
import { afterEach, expect } from "vitest";
import type { ServerMessage } from "../src/protocol.js";
import type { TestCommand, TestState } from "./worker.js";

type Message = ServerMessage<TestState>;

export interface Connection {
  ws: WebSocket;
  /** The next frame from the room, which must be of type `t`. */
  next<T extends Message["t"]>(t: T): Promise<Extract<Message, { t: T }>>;
  /** Send a command and return the id it was sent under. */
  command(command: TestCommand): number;
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
    raw(frame) {
      ws.send(frame);
    },
  };
}
