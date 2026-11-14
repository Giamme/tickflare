import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findMatch, fingerprint, LockstepClient, RoomClient, runReplay, type CatchUp, type Replay } from "../src/client/index.js";
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

  it("tells listeners added with on() what it tells the options, until they stop listening", () => {
    const fromOption: string[] = [];
    const fromListener: string[] = [];
    const client = new RoomClient<{ n: number }>("wss://tickflare.test/rooms/r", {
      onState: (state) => fromOption.push(`state:${state.n}`),
    });
    const stop = client.on("state", (state, seq) => fromListener.push(`state:${state.n}@${seq}`));
    client.on("message", (message) => fromListener.push(`message:${String(message)}`));
    client.on("presence", (players) => fromListener.push(`presence:${players.length}`));
    FakeSocket.all[0]!.welcome();
    FakeSocket.all[0]!.receive({ t: "state", seq: 1, state: { n: 1 } });
    FakeSocket.all[0]!.receive({ t: "msg", d: "hi" });
    stop();
    FakeSocket.all[0]!.receive({ t: "state", seq: 2, state: { n: 2 } });

    expect(fromOption).toEqual(["state:undefined", "state:1", "state:2"]);
    expect(fromListener).toEqual(["presence:0", "state:undefined@0", "state:1@1", "message:hi"]);
    expect(client.state).toEqual({ n: 2 });
    expect(client.seq).toBe(2);
    client.close();
  });

  it("applies a patch of the view it holds, and starts over from one of a view it does not", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { seen, onStatus } = statuses();
    const states: unknown[] = [];
    const room = new RoomClient<{ n?: number; m?: number }>("wss://example.test/rooms/r", { onStatus });
    room.on("state", (state) => states.push(state));
    const first = FakeSocket.all[0]!;
    first.welcome();

    first.receive({ t: "patch", seq: 1, tick: 0, from: 0, p: { n: [1] } });
    expect(room.state).toEqual({ n: 1 });
    expect(room.seq).toBe(1);
    // While the room simulates, a patch does not say what it is a patch of: the room keeps
    // count of what each connection was sent.
    first.receive({ t: "patch", seq: 4, tick: 9, p: { n: [4] } });
    expect(room.state).toEqual({ n: 4 });

    // A patch of the view at 6, to a client whose view is of 4: a change went missing.
    first.receive({ t: "patch", seq: 7, tick: 9, from: 6, p: { m: [7] } });
    expect(room.state).toEqual({ n: 4 });
    expect(seen.at(-1)).toBe("connecting:1006:resync");
    expect(first.readyState).toBe(2);
    // Nothing more is taken from the connection it gave up on.
    first.receive({ t: "patch", seq: 8, tick: 9, from: 7, p: { m: [8] } });
    expect(room.state).toEqual({ n: 4 });

    vi.advanceTimersByTime(1000);
    const second = FakeSocket.all[1]!;
    second.readyState = 1;
    second.receive({ t: "welcome", v: 1, you: "p1", seq: 8, tick: 9, tickRate: 0, state: { n: 4, m: 8 }, players: [] });
    expect(room.state).toEqual({ n: 4, m: 8 });
    expect(room.status).toBe("open");
    expect(states.at(-1)).toEqual({ n: 4, m: 8 });
    room.close();
    warn.mockRestore();
  });

  it("follows a handover it is told about before it was ever welcomed", () => {
    const moved: string[] = [];
    const client = new RoomClient("wss://tickflare.test/rooms/old?token=t", { onMoved: (room) => moved.push(room) });
    FakeSocket.all[0]!.drop(4004, "new");

    expect(moved).toEqual(["new"]);
    expect(FakeSocket.all[1]!.url).toBe("wss://tickflare.test/rooms/new?token=t&v=2");
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
        "wss://tickflare.test/rooms/r?token=t1&v=2",
        "wss://tickflare.test/rooms/r?token=t2&v=2",
        "wss://tickflare.test/rooms/r?token=t3&v=2",
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
        "wss://tickflare.test/rooms/old?token=t1&lang=it&v=2",
        "wss://tickflare.test/rooms/new?token=t2&lang=it&v=2",
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
      expect(urls()).toEqual(["wss://tickflare.test/rooms/r?token=t2&v=2"]);
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
          return Promise.resolve({ v: 2, seed: 1, turnRate: 10, turn: 0, turns: [] });
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

      expect(loaded).toEqual(["https://tickflare.test/rooms/r/replay?since=0&token=t2"]);
      expect(askedFor).toEqual(["r", "r"]);
      client.close();
    });
  });
});

describe("LockstepClient and snapshots", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  type Sum = { total: number };
  const entry = (n: number) => [{ player: "p1", input: { n } }];
  /** The recording of a match in which 1 was added in turn 2, 10 in turn 12 and 100 in turn 22. */
  const whole: Replay<{ n: number }> = { v: 2, seed: 1, turnRate: 10, turn: 25, turns: [[2, entry(1)], [12, entry(10)], [22, entry(100)]] };
  /** Its end, from a snapshot of turn 20. */
  const fromTwenty = (data: string): CatchUp<{ n: number }> => ({
    ...whole,
    turns: [[22, entry(100)]],
    from: 20,
    epoch: "e1",
    snapshot: { turn: 20, hash: "11", data },
  });

  /** A client connected as `you`, whose catch-up requests `answer` answers. Snapshots are due every ten turns. */
  async function connected(
    you: string,
    answer: (url: URL) => CatchUp<{ n: number }>,
    simulation: "saves" | "saves, with no hash of its own" | "plain" = "saves",
  ) {
    const steps: number[] = [];
    const asked: URL[] = [];
    const sent: { url: URL; data: string }[] = [];
    const client = new LockstepClient<{ n: number }, Sum>("wss://tickflare.test/rooms/r", {
      create: () => ({ total: 0 }),
      step(sim, entries, turn) {
        steps.push(turn);
        for (const each of entries) sim.total += each.input?.n ?? 0;
      },
      ...(simulation === "plain"
        ? {}
        : { save: (sim: Sum) => ({ t: sim.total }), load: (saved: unknown) => ({ total: (saved as { t: number }).t }) }),
      ...(simulation === "saves" ? { hash: (sim: Sum) => sim.total } : {}),
      bufferTurns: 0,
      hashEvery: 1000,
      loadReplay(url) {
        asked.push(new URL(url));
        return Promise.resolve(answer(new URL(url)));
      },
      sendSnapshot(url, data) {
        sent.push({ url: new URL(url), data });
        return Promise.resolve();
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.all.at(-1)!;
    const welcome = (to: FakeSocket) => {
      to.readyState = 1;
      to.receive({
        t: "welcome", v: 1, you, seq: 0, tick: 0, tickRate: 10,
        players: [{ id: "p1", connected: true }, { id: "p2", connected: true }],
        state: { seed: 1, turn: 25, entries: [], desync: null, clock: "players", snapshotEvery: 10 },
      });
    };
    welcome(socket);
    await vi.advanceTimersByTimeAsync(0);
    const turns = (to: FakeSocket, n: number, c: number) => to.receive({ t: "msg", d: { tickflare: "turns", n, c, e: [] } });
    const hashes = (of: FakeSocket) =>
      of.sent.flatMap((frame) => {
        const data = frame.startsWith("{") ? (JSON.parse(frame) as { data?: { k?: string; n?: number; h?: string } }).data : undefined;
        return data?.k === "h" ? [`${data.n}:${data.h}`] : [];
      });
    return { client, socket, steps, asked, sent, welcome, turns, hashes };
  }

  it("starts from the room's snapshot, and runs only the turns after it", async () => {
    const { client, steps, asked } = await connected("p1", () => fromTwenty('{"t":11}'));
    expect(asked.map((url) => url.search)).toEqual(["?since=0&snapshot=0"]);
    expect(steps).toEqual([21, 22, 23, 24, 25]);
    expect(client.sim).toEqual({ total: 111 });
    expect(client.turn).toBe(25);
    expect(client.ready).toBe(true);
    client.close();
  });

  it("does not ask for a snapshot when the simulation cannot load one", async () => {
    const { client, steps, asked } = await connected("p1", () => ({ ...whole, epoch: "e1" }), "plain");
    expect(asked.map((url) => url.search)).toEqual(["?since=0"]);
    expect(steps).toHaveLength(25);
    expect(client.sim).toEqual({ total: 111 });
    client.close();
  });

  it.each([
    ["does not hash to what the players agreed on", '{"t":999}'],
    ["cannot be read", "not json"],
  ])("sets aside a snapshot that %s, and catches up from the recording", async (_what, data) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, steps, asked } = await connected("p1", (url) =>
      url.searchParams.get("snapshot") === "0" ? fromTwenty(data) : { ...whole, epoch: "e1" },
    );
    // Asked again, saying which snapshot is of no use.
    expect(asked.map((url) => url.search)).toEqual(["?since=0&snapshot=0", "?since=0&snapshot=20"]);
    expect(steps).toHaveLength(25);
    expect(client.sim).toEqual({ total: 111 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    client.close();
  });

  it("does not ask over and over when the answer is never one it can use", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, asked } = await connected("p1", () => fromTwenty('{"t":999}'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(asked).toHaveLength(2);
    expect(client.ready).toBe(false);
    warn.mockRestore();
    client.close();
  });

  it("says which turn it is at when it reconnects, and carries on from its own simulation", async () => {
    let answers = 0;
    const { client, socket, steps, asked, welcome, turns } = await connected("p1", (url) => {
      answers += 1;
      if (answers === 1) return fromTwenty('{"t":11}');
      // The room has not restarted: it sends what happened since.
      expect(url.search).toBe("?since=27&epoch=e1&snapshot=0");
      return { ...whole, turn: 30, turns: [[29, entry(1000)]], from: 27, epoch: "e1" };
    });
    turns(socket, 26, 2);
    expect(client.turn).toBe(27);

    socket.drop(1006);
    await vi.advanceTimersByTimeAsync(300);
    welcome(FakeSocket.all.at(-1)!);
    await vi.advanceTimersByTimeAsync(0);
    expect(asked).toHaveLength(2);
    expect(steps).toEqual([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
    expect(client.sim).toEqual({ total: 1111 });
    client.close();
  });

  it("asks for the whole recording when it is sent an end that does not follow from what it has", async () => {
    let answers = 0;
    const { client, socket, steps, asked, welcome } = await connected("p1", () => {
      answers += 1;
      if (answers === 2) return { ...whole, turn: 30, turns: [], from: 26, epoch: "e1" };
      return { ...whole, epoch: "e1" };
    }, "plain");
    socket.drop(1006);
    await vi.advanceTimersByTimeAsync(300);
    welcome(FakeSocket.all.at(-1)!);
    await vi.advanceTimersByTimeAsync(0);

    expect(asked.map((url) => url.search)).toEqual(["?since=0", "?since=25&epoch=e1", "?since=0"]);
    expect(steps).toHaveLength(50);
    expect(client.sim).toEqual({ total: 111 });
    client.close();
  });

  it("sends a snapshot at each snapshot turn if its player's id sorts first, and its hash either way", async () => {
    const first = await connected("p1", () => fromTwenty('{"t":11}'));
    first.turns(first.socket, 26, 5);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.hashes(first.socket)).toEqual(["30:111"]);
    expect(first.sent.map(({ url, data }) => `${url.pathname}${url.search} ${data}`)).toEqual([
      '/rooms/r/snapshot?turn=30&hash=111 {"t":111}',
    ]);
    first.client.close();

    const second = await connected("p2", () => fromTwenty('{"t":11}'));
    second.turns(second.socket, 26, 5);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.hashes(second.socket)).toEqual(["30:111"]);
    expect(second.sent).toEqual([]);
    second.client.close();
  });

  it("hashes what `save` returns when the simulation has no hash of its own", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const saved = '{"t":11}';
    const good = { ...fromTwenty(saved), snapshot: { turn: 20, hash: fingerprint({ t: 11 }), data: saved } };
    const { client, steps, asked, socket, turns, hashes, sent } = await connected("p1", () => good, "saves, with no hash of its own");
    expect(asked.map((url) => url.search)).toEqual(["?since=0&snapshot=0"]);
    expect(steps).toEqual([21, 22, 23, 24, 25]);
    expect(client.sim).toEqual({ total: 111 });

    // What it reports and what it sends are the same text's fingerprint and the text.
    turns(socket, 26, 5);
    await vi.advanceTimersByTimeAsync(0);
    expect(hashes(socket)).toEqual([`30:${fingerprint({ t: 111 })}`]);
    expect(sent.map(({ url, data }) => `${url.search} ${data}`)).toEqual([`?turn=30&hash=${fingerprint({ t: 111 })} {"t":111}`]);
    client.close();

    // And a snapshot that is not what its fingerprint says is set aside.
    const bad = await connected("p1", (url) => (url.searchParams.get("snapshot") === "0" ? { ...good, snapshot: { ...good.snapshot, data: '{"t":12}' } } : { ...whole, epoch: "e1" }), "saves, with no hash of its own");
    expect(bad.asked).toHaveLength(2);
    expect(bad.client.sim).toEqual({ total: 111 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    bad.client.close();
  });

  it("sends none for the turns it runs while catching up, or without a way to save", async () => {
    const caughtUp = await connected("p1", () => ({ ...whole, epoch: "e1" }));
    expect(caughtUp.steps).toHaveLength(25);
    expect(caughtUp.sent).toEqual([]);
    expect(caughtUp.hashes(caughtUp.socket)).toEqual([]);
    caughtUp.client.close();

    const plain = await connected("p1", () => ({ ...whole, epoch: "e1" }), "plain");
    plain.turns(plain.socket, 26, 5);
    await vi.advanceTimersByTimeAsync(0);
    expect(plain.sent).toEqual([]);
    plain.client.close();
  });
});

describe("LockstepClient in a room whose players ask for the turns", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  /** A client that has connected as `you` to a room at ten turns a second, with p1 and p2 in it. */
  async function connected(you: string) {
    const steps: string[] = [];
    let loads = 0;
    const client = new LockstepClient<{ n: number }, object>("wss://tickflare.test/rooms/r", {
      create: () => ({}),
      step: (_sim, entries, turn) => steps.push(`${turn}:${entries.map((entry) => entry.player).join("+")}`),
      bufferTurns: 0,
      loadReplay: () => {
        loads += 1;
        return Promise.resolve({ v: 2, seed: 1, turnRate: 10, turn: 0, turns: [] });
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeSocket.all[0]!;
    socket.readyState = 1;
    socket.receive({
      t: "welcome", v: 1, you, seq: 0, tick: 0, tickRate: 10,
      players: [{ id: "p1", connected: true }, { id: "p2", connected: true }],
      state: { seed: 1, turn: 0, entries: [], desync: null, clock: "players" },
    });
    await vi.advanceTimersByTimeAsync(0);
    const asks = () =>
      socket.sent.filter((frame) => frame.startsWith("{") && (JSON.parse(frame) as { data?: { k?: string } }).data?.k === "t").length;
    const turns = (n: number, c: number, by?: string, e: unknown[] = []) =>
      socket.receive({ t: "msg", d: { tickflare: "turns", n, c, e, ...(by ? { b: by } : {}) } });
    return { client, socket, steps, asks, turns, loads: () => loads };
  }

  it("asks when no turns arrive, and then once a turn for as long as its requests are the ones answered", async () => {
    const { client, asks, turns } = await connected("p1");
    await vi.advanceTimersByTimeAsync(149);
    expect(asks()).toBe(0);
    await vi.advanceTimersByTimeAsync(2); // a turn and a half of silence
    expect(asks()).toBe(1);

    turns(1, 1, "p1");
    await vi.advanceTimersByTimeAsync(500);
    expect(asks()).toBe(6); // one every 100 ms, counted from the first

    // Someone else's request closed the latest turn: they are keeping time now.
    turns(2, 1, "p2");
    for (let n = 3; n < 13; n++) {
      await vi.advanceTimersByTimeAsync(100);
      turns(n, 1, "p2");
    }
    expect(asks()).toBe(6);
    client.close();
  });

  it("waits a little longer than the player before it, so that only one takes over", async () => {
    const { client, asks } = await connected("p2");
    await vi.advanceTimersByTimeAsync(189);
    expect(asks()).toBe(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(asks()).toBe(1);
    client.close();
  });

  it("is not made the one asking by turns closed for a player coming or going", async () => {
    const { client, asks, turns } = await connected("p1");
    await vi.advanceTimersByTimeAsync(151);
    turns(1, 1, "p1");
    turns(2, 1); // someone arrived: no request behind it
    await vi.advanceTimersByTimeAsync(300);
    expect(asks()).toBe(4);
    client.close();
  });

  it("steps through every turn a message closes, and takes nothing from state frames", async () => {
    const { client, socket, steps, turns, loads } = await connected("p1");
    turns(1, 3, "p2", [{ player: "p2", input: { n: 1 } }]);
    expect(steps).toEqual(["1:", "2:", "3:p2"]);

    // A checkpoint of the counter: the turns it mentions have come, or are coming, as messages.
    socket.receive({ t: "state", seq: 1, state: { seed: 1, turn: 3, entries: [{ player: "p2", input: { n: 1 } }], desync: null, clock: "players" } });
    turns(2, 3, "p2", [{ player: "p1", input: { n: 2 } }]); // overlaps what it has: only turn 4 is new
    expect(steps).toEqual(["1:", "2:", "3:p2", "4:p1"]);
    expect(client.turn).toBe(4);

    // A gap: start over from the recording.
    expect(loads()).toBe(1);
    turns(9, 1, "p2");
    await vi.advanceTimersByTimeAsync(0);
    expect(loads()).toBe(2);
    client.close();
  });

  it("stops asking when the connection drops", async () => {
    const { client, socket, asks, turns } = await connected("p1");
    await vi.advanceTimersByTimeAsync(151);
    turns(1, 1, "p1");
    await vi.advanceTimersByTimeAsync(200);
    const before = asks();
    socket.drop(1006);
    await vi.advanceTimersByTimeAsync(120);
    expect(asks()).toBe(before);
    client.close();
  });
});

describe("findMatch", () => {
  beforeEach(() => {
    FakeSocket.all = [];
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("asks the token source for a token for the queue it joins", async () => {
    const askedFor: string[] = [];
    const found = findMatch("wss://tickflare.test/matchmaking/ranked", {
      token: (queue) => {
        askedFor.push(queue);
        return "t1";
      },
    });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    const socket = FakeSocket.all[0]!;
    expect(socket.url).toBe("wss://tickflare.test/matchmaking/ranked?token=t1");
    socket.receive({ t: "match", room: "m-1", players: ["p1", "p2"] });
    socket.drop(1000, "matched");

    await expect(found).resolves.toEqual({ t: "match", room: "m-1", players: ["p1", "p2"] });
    expect(askedFor).toEqual(["ranked"]);
  });

  it("gives up on a queue that turns it away before it opens", async () => {
    const found = findMatch("wss://tickflare.test/matchmaking/ranked");
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
    FakeSocket.all[0]!.refuse();
    await expect(found).rejects.toThrow("Matchmaking ended without a match");
  });
});

describe("runReplay", () => {
  type Sim = { log: string[] };
  const simulation = {
    create: (): Sim => ({ log: [] }),
    step: (sim: Sim, entries: { player: string; input?: number; event?: string }[], turn: number) => {
      for (const entry of entries) sim.log.push(`${turn}:${entry.player}:${entry.event ?? entry.input}`);
    },
  };

  it("reads recordings made before 0.1, whose entries were spelled { p, i, e }", () => {
    const old = { v: 1, seed: 1, turnRate: 10, turn: 3, turns: [[1, [{ p: "a", e: "join" }]], [3, [{ p: "a", i: 7 }]]] };
    expect(runReplay(old as unknown as Replay<number>, simulation).log).toEqual(["1:a:join", "3:a:7"]);
  });
});
