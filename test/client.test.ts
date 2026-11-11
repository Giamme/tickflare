import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomClient } from "../src/client/index.js";
import { PING, PONG } from "../src/protocol.js";

/** A socket the test drives by hand: nothing happens on it unless the test says so. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  #listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener]);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  /** Like a connection that has silently died: closing it reports nothing back. */
  close(): void {
    this.readyState = 2;
  }

  welcome(): void {
    this.readyState = 1;
    this.receive({ t: "welcome", v: 1, you: "p1", seq: 0, tick: 0, tickRate: 0, state: {}, players: [] });
  }

  receive(data: unknown): void {
    this.#emit("message", { data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  drop(code: number, reason = ""): void {
    this.readyState = 3;
    this.#emit("close", { code, reason });
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

describe("RoomClient", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const statuses = () => {
    const seen: string[] = [];
    const onStatus = (status: string, detail?: { code: number; reason: string }) =>
      seen.push(detail ? `${status}:${detail.code}:${detail.reason}` : status);
    return { seen, onStatus };
  };

  it("replaces a connection that stops answering keepalives", () => {
    const { seen, onStatus } = statuses();
    const client = new RoomClient("wss://tickflare.test/rooms/r", { pingIntervalMs: 1000, onStatus });
    const first = FakeSocket.all[0]!;
    first.welcome();

    vi.advanceTimersByTime(1000);
    expect(first.sent).toEqual([PING]);
    first.receive(PONG);
    vi.advanceTimersByTime(1000);
    expect(first.sent).toEqual([PING, PING]);
    expect(client.status).toBe("open");

    // No answer to the second one by the time the third is due.
    vi.advanceTimersByTime(1000);
    expect(first.sent).toEqual([PING, PING]);
    expect(seen).toEqual(["open", "connecting:1006:keepalive_timeout"]);

    vi.advanceTimersByTime(250);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.welcome();
    expect(client.status).toBe("open");

    // When the dead socket's close finally arrives, it is no longer anyone's business.
    first.drop(1006);
    vi.advanceTimersByTime(500);
    expect(client.status).toBe("open");
    expect(FakeSocket.all).toHaveLength(2);
    client.close();
  });

  it("takes any frame from the room as a sign of life", () => {
    const client = new RoomClient("wss://tickflare.test/rooms/r", { pingIntervalMs: 1000 });
    const socket = FakeSocket.all[0]!;
    socket.welcome();
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      socket.receive({ t: "presence", players: [] });
    }
    expect(client.status).toBe("open");
    expect(FakeSocket.all).toHaveLength(1);
    client.close();
  });

  it("reports every attempt that fails, with the close code", () => {
    const { seen, onStatus } = statuses();
    const client = new RoomClient("wss://tickflare.test/rooms/r", { onStatus });
    // Turned away before the room is reached, as with an expired token: the socket never opens.
    FakeSocket.all[0]!.drop(1006);
    vi.advanceTimersByTime(250);
    FakeSocket.all[1]!.drop(1006);
    vi.advanceTimersByTime(500);
    FakeSocket.all[2]!.drop(1006);

    expect(seen).toEqual(["connecting:1006:", "connecting:1006:", "connecting:1006:"]);
    client.close();
    expect(client.status).toBe("closed");
  });

  it("follows a handover it is told about before it was ever welcomed", () => {
    const moved: string[] = [];
    const client = new RoomClient("wss://tickflare.test/rooms/old?token=t", { onMoved: (room) => moved.push(room) });
    FakeSocket.all[0]!.drop(4004, "new");

    expect(moved).toEqual(["new"]);
    expect(FakeSocket.all[1]!.url).toBe("wss://tickflare.test/rooms/new?token=t");
    client.close();
  });
});
