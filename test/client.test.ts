import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LockstepClient, RoomClient } from "../src/client/index.js";
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

  /** Turned away at the upgrade, as Node's WebSocket reports it: an error, and no close. */
  refuse(): void {
    this.#emit("error", {});
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

  it("takes a connection that errs before it opened for a failed one, close event or not", () => {
    const { seen, onStatus } = statuses();
    const client = new RoomClient("wss://tickflare.test/rooms/r", { onStatus, reconnect: false });
    FakeSocket.all[0]!.refuse();
    expect(seen).toEqual(["closed:1006:"]);
    expect(client.status).toBe("closed");
    // The close a browser sends after the error changes nothing.
    FakeSocket.all[0]!.drop(1006);
    expect(seen).toEqual(["closed:1006:"]);
  });

  it("follows a handover it is told about before it was ever welcomed", () => {
    const moved: string[] = [];
    const client = new RoomClient("wss://tickflare.test/rooms/old?token=t", { onMoved: (room) => moved.push(room) });
    FakeSocket.all[0]!.drop(4004, "new");

    expect(moved).toEqual(["new"]);
    expect(FakeSocket.all[1]!.url).toBe("wss://tickflare.test/rooms/new?token=t");
    client.close();
  });

  describe("with a token source", () => {
    /** Hands out t1, t2, ... and remembers which room each was asked for. */
    const counter = () => {
      const askedFor: string[] = [];
      const token = (room: string) => {
        askedFor.push(room);
        return Promise.resolve(`t${askedFor.length}`);
      };
      return { askedFor, token };
    };
    const urls = () => FakeSocket.all.map((socket) => socket.url);

    it("asks for a token before every attempt, so an expired one is never sent again", async () => {
      const { askedFor, token } = counter();
      const client = new RoomClient("wss://tickflare.test/rooms/r", { token });
      await vi.advanceTimersByTimeAsync(0);
      FakeSocket.all[0]!.welcome();
      FakeSocket.all[0]!.drop(1006);
      await vi.advanceTimersByTimeAsync(250);
      FakeSocket.all[1]!.drop(1006);
      await vi.advanceTimersByTimeAsync(500);

      expect(urls()).toEqual([
        "wss://tickflare.test/rooms/r?token=t1",
        "wss://tickflare.test/rooms/r?token=t2",
        "wss://tickflare.test/rooms/r?token=t3",
      ]);
      expect(askedFor).toEqual(["r", "r", "r"]);
      client.close();
    });

    it("asks for one for the new room when the player is handed over", async () => {
      const { askedFor, token } = counter();
      const client = new RoomClient("wss://tickflare.test/rooms/old?token=stale&lang=it", { token });
      await vi.advanceTimersByTimeAsync(0);
      FakeSocket.all[0]!.welcome();
      FakeSocket.all[0]!.drop(4004, "new");
      await vi.advanceTimersByTimeAsync(0);

      expect(urls()).toEqual([
        "wss://tickflare.test/rooms/old?token=t1&lang=it",
        "wss://tickflare.test/rooms/new?token=t2&lang=it",
      ]);
      expect(askedFor).toEqual(["old", "new"]);
      client.close();
    });

    it("counts a token that cannot be had as a failed attempt and tries again", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { seen, onStatus } = statuses();
      let calls = 0;
      const token = () => (++calls === 1 ? Promise.reject(new Error("offline")) : "t2");
      const client = new RoomClient("wss://tickflare.test/rooms/r", { token, onStatus });
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeSocket.all).toHaveLength(0);
      expect(seen).toEqual(["connecting:1006:token_failed"]);

      await vi.advanceTimersByTimeAsync(250);
      expect(urls()).toEqual(["wss://tickflare.test/rooms/r?token=t2"]);
      warn.mockRestore();
      client.close();
    });

    it("does not connect if it is closed while the token is on its way", async () => {
      const { token } = counter();
      const client = new RoomClient("wss://tickflare.test/rooms/r", { token });
      client.close();
      await vi.advanceTimersByTimeAsync(1000);

      expect(FakeSocket.all).toHaveLength(0);
      expect(client.status).toBe("closed");
    });

    it("asks again before loading a lockstep recording", async () => {
      const { askedFor, token } = counter();
      const loaded: string[] = [];
      const client = new LockstepClient("wss://tickflare.test/rooms/r", {
        token,
        create: () => ({}),
        step: () => {},
        loadReplay: (url) => {
          loaded.push(url);
          return Promise.resolve({ v: 1, seed: 1, turnRate: 10, turn: 0, turns: [] });
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      const socket = FakeSocket.all[0]!;
      socket.readyState = 1;
      socket.receive({
        t: "welcome", v: 1, you: "p1", seq: 0, tick: 0, tickRate: 10, players: [],
        state: { seed: 1, turn: 0, entries: [], desync: null },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(loaded).toEqual(["https://tickflare.test/rooms/r/replay?token=t2"]);
      expect(askedFor).toEqual(["r", "r"]);
      client.close();
    });
  });
});
