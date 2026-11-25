import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloseCode, Predictor, RoomClient, type RoomClientOptions } from "../src/client/index.js";

/**
 * What `RoomClient` does with commands while its connection is away: which
 * it keeps, what it sends when the room is back, and in what order. The room
 * is played by the test. `test/resume.test.ts` has the real one.
 */

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
  close(): void {
    this.readyState = 2;
  }
  receive(data: unknown): void {
    for (const listener of this.#listeners.get("message") ?? []) listener({ data: JSON.stringify(data) });
  }
  /** The room's first frame: of version 5 unless the test says otherwise. */
  welcome(more: Record<string, unknown> = {}): void {
    this.readyState = 1;
    this.receive({ t: "welcome", v: 5, you: "p1", seq: 0, tick: 0, tickRate: 0, state: { n: 0 }, players: [], ...more });
  }
  drop(code = 1006, reason = ""): void {
    this.readyState = 3;
    for (const listener of this.#listeners.get("close") ?? []) listener({ code, reason });
  }
  /** The ids of the commands and leaves sent, in order. */
  get ids(): number[] {
    return this.sent.filter((frame) => frame.startsWith("{")).map((frame) => (JSON.parse(frame) as { id: number }).id);
  }
}

type Move = { add: number };
const latest = () => FakeSocket.all.at(-1)!;
/** How each promise ended, in the order they did. */
function outcomes() {
  const seen: string[] = [];
  const watch = (name: string, sent: Promise<void>) =>
    void sent.then(
      () => seen.push(`${name}: applied`),
      (err: { reason: string }) => seen.push(`${name}: ${err.reason}`),
    );
  return { seen, watch };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function connected(options: RoomClientOptions<{ n: number }> = {}) {
  const room = new RoomClient<{ n: number }, Move>("wss://tickflare.test/rooms/r", options);
  latest().welcome();
  return room;
}
/** The connection drops, and the next attempt gets through to the room. */
async function reconnect(): Promise<FakeSocket> {
  const before = FakeSocket.all.length;
  latest().drop();
  await vi.advanceTimersByTimeAsync(250);
  expect(FakeSocket.all).toHaveLength(before + 1);
  return latest();
}

describe("RoomClient, when the connection drops with commands on their way", () => {
  it("names itself the same way on every connection", async () => {
    connected();
    const socket = await reconnect();
    const names = FakeSocket.all.map((each) => new URL(each.url).searchParams.get("client"));
    expect(names[0]).toMatch(/^[a-z0-9]{12}$/);
    expect(names[1]).toBe(names[0]);
    expect(new URL(socket.url).searchParams.get("v")).toBe("5");
  });

  it("settles those the room handled once the state shows them, and sends the others again in order", async () => {
    const { seen, watch } = outcomes();
    const room = connected();
    const states: string[] = [];
    room.on("state", (state) => states.push(`${state.n} with ${room.unconfirmed.map((sent) => sent.id).join(",") || "none"} unconfirmed`));
    for (const n of [1, 2, 3, 4]) watch(`${n}`, room.send({ add: n }));
    expect(latest().ids).toEqual([1, 2, 3, 4]);

    const socket = await reconnect();
    await vi.advanceTimersByTimeAsync(0);
    // Nothing is settled, and nothing is off the list, while the room has not said.
    expect(seen).toEqual([]);
    expect(room.unconfirmed.map((sent) => sent.id)).toEqual([1, 2, 3, 4]);

    socket.welcome({ c: 2, refused: [[1, "no"]], seq: 7, state: { n: 2 } });
    expect(socket.ids).toEqual([3, 4]);
    expect(JSON.parse(socket.sent[0]!)).toEqual({ t: "cmd", id: 3, data: { add: 3 } });
    // The state in the welcome shows 2, so it left the list as that state arrived.
    expect(states.at(-1)).toBe("2 with 3,4 unconfirmed");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["1: no", "2: applied"]);

    socket.receive({ t: "state", seq: 8, c: 4, state: { n: 9 } });
    socket.receive({ t: "ack", id: 3, seq: 8 });
    socket.receive({ t: "ack", id: 4, seq: 8 });
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["1: no", "2: applied", "3: applied", "4: applied"]);
    expect(room.unconfirmed).toEqual([]);
    room.close();
  });

  it("sends them before anything a listener sends on hearing that the room is back", async () => {
    const room = connected();
    // A game that sends something every time it connects.
    room.on("status", (status) => {
      if (status === "open") void room.send({ add: 100 }).catch(() => {});
    });
    void room.send({ add: 1 }).catch(() => {});
    latest().drop();
    void room.send({ add: 2 }).catch(() => {});
    await vi.advanceTimersByTimeAsync(250);
    latest().welcome({ c: 0 });
    // The room takes a number lower than the last it handled for a command it has seen: had the
    // listener's gone first, the two before it would never have been applied.
    expect(latest().ids).toEqual([1, 2, 3]);
    room.close();
  });

  it("gives up what was sent when the room knows nothing of it, and still sends what was waiting", async () => {
    const { seen, watch } = outcomes();
    const room = connected();
    watch("sent", room.send({ add: 1 }));
    latest().drop();
    watch("waiting", room.send({ add: 2 }));
    await vi.advanceTimersByTimeAsync(250);
    // No `c`: the seat was given up while the client was away, and this is a new one.
    latest().welcome();
    expect(latest().ids).toEqual([2]);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["sent: disconnected"]);
    expect(room.unconfirmed.map((sent) => sent.id)).toEqual([2]);
    room.close();
  });

  it("gives up at once what was sent to a room older than version 5, which cannot say what became of it", async () => {
    const { seen, watch } = outcomes();
    const room = new RoomClient<{ n: number }, Move>("wss://tickflare.test/rooms/r");
    latest().welcome({ v: 4 });
    watch("sent", room.send({ add: 1 }));
    latest().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["sent: disconnected"]);
    // What is sent now waits all the same: that needs nothing of the room.
    watch("waiting", room.send({ add: 2 }));
    await vi.advanceTimersByTimeAsync(250);
    latest().welcome({ v: 4 });
    expect(latest().ids).toEqual([2]);
    room.close();
  });

  it("gives up what it sent when the room welcomes it again on the connection it has", async () => {
    const { seen, watch } = outcomes();
    const room = connected();
    watch("sent", room.send({ add: 1 }));
    // The room came back from its last save, and says nothing of this client's commands.
    latest().welcome();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["sent: disconnected"]);
    expect(latest().ids).toEqual([1]);
    expect(room.unconfirmed).toEqual([]);
    expect(FakeSocket.all).toHaveLength(1);
    room.close();
  });

  it("gives a command up when it has waited as long as it may, counted from when it began to wait", async () => {
    const { seen, watch } = outcomes();
    const room = connected({ keepCommandsMs: 1000 });
    watch("sent", room.send({ add: 1 }));
    latest().drop();
    await vi.advanceTimersByTimeAsync(600);
    watch("waiting", room.send({ add: 2 }));
    // Attempts that fail in the meantime do not give it more time.
    latest().drop();
    await vi.advanceTimersByTimeAsync(399);
    expect(seen).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(seen).toEqual(["sent: disconnected"]);
    expect(room.unconfirmed.map((sent) => sent.id)).toEqual([2]);
    await vi.advanceTimersByTimeAsync(600);
    expect(seen).toEqual(["sent: disconnected", "waiting: not_connected"]);
    expect(room.unconfirmed).toEqual([]);

    // Neither is sent when the room is back, whatever the room says it has.
    latest().drop();
    await vi.advanceTimersByTimeAsync(5000);
    latest().welcome({ c: 0 });
    expect(latest().ids).toEqual([]);
    void room.send({ add: 3 }).catch(() => {});
    expect(latest().ids).toEqual([3]);
    room.close();
  });

  it("gives everything up when the room hands the player to another room", async () => {
    const { seen, watch } = outcomes();
    const room = connected();
    watch("sent", room.send({ add: 1 }));
    latest().drop();
    watch("waiting", room.send({ add: 2 }));
    await vi.advanceTimersByTimeAsync(250);
    // The room it was reconnecting to has passed the player on.
    latest().drop(CloseCode.Moved, "elsewhere");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["sent: disconnected", "waiting: not_connected"]);
    // What is sent from here on is for the new room.
    watch("new", room.send({ add: 3 }));
    expect(latest().url).toContain("/rooms/elsewhere");
    latest().welcome();
    expect(latest().ids).toEqual([3]);
    room.close();
  });

  it("gives everything up when the connection closes for good", async () => {
    const { seen, watch } = outcomes();
    const room = connected();
    watch("sent", room.send({ add: 1 }));
    latest().drop();
    watch("waiting", room.send({ add: 2 }));
    await vi.advanceTimersByTimeAsync(250);
    latest().drop(CloseCode.RoomFull, "room_full");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["sent: disconnected", "waiting: not_connected"]);
    expect(room.status).toBe("closed");
    expect(room.unconfirmed).toEqual([]);
    watch("after", room.send({ add: 3 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toBe("after: not_connected");

    // And when the game closes it between two attempts.
    const other = connected();
    watch("other", other.send({ add: 1 }));
    latest().drop();
    other.close();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)).toBe("other: disconnected");
  });

  it("holds what is sent before the first welcome, also for a client that does not reconnect", async () => {
    const { seen, watch } = outcomes();
    const room = new RoomClient<{ n: number }, Move>("wss://tickflare.test/rooms/r", { reconnect: false });
    watch("early", room.send({ add: 1 }));
    watch("leave", room.leave());
    expect(latest().ids).toEqual([]);
    latest().welcome();
    expect(latest().sent.map((frame) => (JSON.parse(frame) as { t: string }).t)).toEqual(["cmd", "leave"]);
    watch("sent", room.send({ add: 2 }));
    latest().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual(["early: disconnected", "leave: disconnected", "sent: disconnected"]);
    expect(room.status).toBe("closed");
  });
});

describe("Predictor, when the connection drops", () => {
  it("does not learn how far ahead to run from a command that waited for the connection", async () => {
    const room = new RoomClient<{ n: number }, Move>("wss://tickflare.test/rooms/r");
    latest().welcome({ tickRate: 10 });
    const predicted = new Predictor(room, { apply: (state, command) => void (state.n += command.add), tick: () => {} });
    const frame = (tick: number, more: Record<string, unknown> = {}) => latest().receive({ t: "patch", seq: tick, tick, p: {}, ...more });

    // Three ticks from sending to showing, every time.
    for (let n = 0; n < 3; n++) {
      void predicted.send({ add: 1 });
      const sentAt = room.tick;
      frame(sentAt + 3, { c: n + 1 });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(predicted.lead).toBe(3);

    // These were on their way, or sent, while the connection was away: twenty ticks went by.
    void predicted.send({ add: 1 });
    latest().drop();
    void predicted.send({ add: 1 });
    void predicted.send({ add: 1 });
    void predicted.send({ add: 1 });
    await vi.advanceTimersByTimeAsync(250);
    latest().welcome({ tickRate: 10, tick: 29, c: 3, state: { n: 3 } });
    expect(latest().ids).toEqual([4, 5, 6, 7]);
    frame(30, { c: 7 });
    await vi.advanceTimersByTimeAsync(0);
    expect(room.unconfirmed).toEqual([]);
    expect(predicted.lead).toBe(3);
    room.close();
  });
});
