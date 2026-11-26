import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRejected, Predictor, RoomClient } from "../src/client/index.js";

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
  drop(code: number): void {
    this.readyState = 3;
    for (const listener of this.#listeners.get("close") ?? []) listener({ code, reason: "" });
  }
  /** The ids of the commands sent, in order. */
  get ids(): number[] {
    return this.sent.filter((frame) => frame.startsWith("{")).map((frame) => (JSON.parse(frame) as { id: number }).id);
  }
}

interface Board {
  count: number;
  marks: Record<string, { n: number }>;
  other: { untouched: boolean };
}
type Move = { add: number } | { mark: string } | { fail: true };

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** A client that has been welcomed to a room, and the socket it is on. */
async function welcomed<View>(state: View, tickRate = 0) {
  const room = new RoomClient<View, Move>("wss://tickflare.test/rooms/r");
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeSocket.all.at(-1)!;
  socket.readyState = 1;
  socket.receive({ t: "welcome", v: 1, you: "p1", seq: 0, tick: 0, tickRate, state, players: [{ id: "p1", connected: true }] });
  return { room, socket };
}
const board = (): Board => ({ count: 0, marks: {}, other: { untouched: true } });

describe("RoomClient.unconfirmed", () => {
  it("lists the commands the state does not show yet, and drops each as the state comes to show it", async () => {
    const { room, socket } = await welcomed(board());
    expect(room.unconfirmed).toEqual([]);
    const first = room.send({ add: 1 });
    const second = room.send({ add: 2 });
    const before = room.unconfirmed;
    expect(before).toEqual([{ id: 1, command: { add: 1 } }, { id: 2, command: { add: 2 } }]);

    // The frame that shows the first command says so. At the moment the state changes, the
    // command is off the list: never both, never neither.
    const seen: string[] = [];
    room.on("state", (state) => seen.push(`${state.count} with ${room.unconfirmed.map((sent) => sent.id).join("+")} to come`));
    socket.receive({ t: "patch", seq: 1, tick: 0, from: 0, c: 1, p: { count: [1] } });
    expect(seen).toEqual(["1 with 2 to come"]);
    expect(room.unconfirmed).not.toBe(before); // a new array, so a change is plain to see
    await expect(first).resolves.toBeUndefined();

    // An ack alone: the command changed nothing this player sees.
    socket.receive({ t: "ack", id: 2, seq: 1 });
    expect(room.unconfirmed).toEqual([]);
    await expect(second).resolves.toBeUndefined();
    // The ack that follows a frame which already said it changes nothing.
    socket.receive({ t: "ack", id: 1, seq: 1 });
    expect(seen).toHaveLength(1);
  });

  it("resolves every command up to the one a frame shows, and waits with the rest", async () => {
    const { room, socket } = await welcomed(board(), 10);
    const settled: string[] = [];
    for (const n of [1, 2, 3]) {
      room.send({ add: n }).then(
        () => settled.push(`${n} when the count is ${room.state!.count}`),
        () => settled.push(`${n} refused`),
      );
    }
    socket.receive({ t: "patch", seq: 1, tick: 1, c: 2, p: { count: [3] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual(["1 when the count is 3", "2 when the count is 3"]);
    expect(room.unconfirmed.map((sent) => sent.id)).toEqual([3]);

    socket.receive({ t: "state", seq: 2, tick: 2, c: 3, state: { ...board(), count: 6 } });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toEqual(["1 when the count is 3", "2 when the count is 3", "3 when the count is 6"]);
  });

  it("drops a command the room refuses, or that was in flight when the connection was lost", async () => {
    const { room, socket } = await welcomed(board());
    const refused = room.send({ add: 1 });
    const lost = room.send({ add: 2 });
    socket.receive({ t: "reject", id: 1, reason: "no" });
    expect(room.unconfirmed.map((sent) => sent.id)).toEqual([2]);
    await expect(refused).rejects.toMatchObject({ reason: "no" });

    // This room is older than version 5: it cannot say what became of the command.
    socket.drop(1006);
    expect(room.unconfirmed).toEqual([]);
    await expect(lost).rejects.toMatchObject({ reason: "disconnected" });
    // A command sent now waits for the connection, and is on the list while it does.
    const waiting = room.send({ add: 3 });
    expect(room.unconfirmed.map((sent) => sent.id)).toEqual([3]);
    room.close();
    await expect(waiting).rejects.toMatchObject({ reason: "not_connected" });
    expect(room.unconfirmed).toEqual([]);
    // Closed for good: nothing waits any more.
    await expect(room.send({ add: 4 })).rejects.toBeInstanceOf(CommandRejected);
    expect(room.unconfirmed).toEqual([]);
  });

  it("lists nothing that was not sent when it may keep no commands", async () => {
    const room = new RoomClient<Board, Move>("wss://tickflare.test/rooms/r", { keepCommandsMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect(new URL(FakeSocket.all[0]!.url).searchParams.has("client")).toBe(false);
    await expect(room.send({ add: 1 })).rejects.toMatchObject({ reason: "not_connected" });
    expect(room.unconfirmed).toEqual([]);
    room.close();
  });

  it("gives up what was in flight when the room welcomes it again on the same connection", async () => {
    const { room, socket } = await welcomed(board(), 10);
    const lost = room.send({ add: 1 });
    // The room came back from its last save: it no longer knows of the command.
    socket.receive({ t: "welcome", v: 1, you: "p1", seq: 0, tick: 0, tickRate: 10, state: board(), players: [] });
    expect(room.unconfirmed).toEqual([]);
    await expect(lost).rejects.toMatchObject({ reason: "disconnected" });
    expect(room.status).toBe("open");
    expect(FakeSocket.all).toHaveLength(1);
  });

  it("takes its tick from an ack that says which tick the view is of", async () => {
    const { room, socket } = await welcomed(board(), 10);
    void room.send({ add: 0 });
    socket.receive({ t: "ack", id: 1, seq: 0, tick: 7 });
    expect(room.tick).toBe(7);
    // Never backwards.
    socket.receive({ t: "ack", id: 2, seq: 0, tick: 3 });
    expect(room.tick).toBe(7);
  });
});

describe("Predictor", () => {
  const apply = (state: Board, move: Move, you: string) => {
    if ("add" in move) state.count += move.add;
    else if ("mark" in move) state.marks[move.mark] = { n: (state.marks[move.mark]?.n ?? 0) + 1 };
    else throw new Error(`${you} cannot do that`);
  };

  it("shows a command's effect at once, and leaves the room's state alone", async () => {
    const { room } = await welcomed(board());
    const told: number[] = [];
    const predicted = new Predictor(room, { apply, onState: (state) => told.push(state.count) });
    // With nothing on its way, the prediction is the room's state, the very object.
    expect(predicted.state).toBe(room.state);

    void predicted.send({ add: 5 });
    expect(predicted.state!.count).toBe(5);
    expect(room.state!.count).toBe(0);
    expect(told).toEqual([5]);
    // What the command did not touch is still the room's own object.
    expect(predicted.state!.other).toBe(room.state!.other);
    expect(predicted.state!.marks).toBe(room.state!.marks);
    // And asking again without anything having changed gives the same object.
    expect(predicted.state).toBe(predicted.state);
  });

  it("is the room's state again once the room shows the command, with no moment in between", async () => {
    const { room, socket } = await welcomed(board());
    const told: number[] = [];
    const predicted = new Predictor(room, { apply, onState: (state) => told.push(state.count) });
    void predicted.send({ add: 5 });
    socket.receive({ t: "patch", seq: 1, tick: 0, from: 0, c: 1, p: { count: [5] } });
    socket.receive({ t: "ack", id: 1, seq: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(predicted.state).toBe(room.state);
    // 5 as a guess, then 5 as the truth: never 10, the command counted twice.
    expect(told).toEqual([5, 5]);
  });

  it("applies what is still on its way over whatever the room sends meanwhile", async () => {
    const { room, socket } = await welcomed(board());
    const predicted = new Predictor(room, { apply });
    void predicted.send({ add: 1 });
    void predicted.send({ mark: "a" });
    // Someone else's change arrives first.
    socket.receive({ t: "patch", seq: 1, tick: 0, from: 0, p: { count: [10] } });
    expect(predicted.state).toMatchObject({ count: 11, marks: { a: { n: 1 } } });

    // The room applied the first, to a count that had moved on again.
    socket.receive({ t: "patch", seq: 2, tick: 0, from: 1, c: 1, p: { count: [21] } });
    expect(predicted.state).toMatchObject({ count: 21, marks: { a: { n: 1 } } });
    socket.receive({ t: "patch", seq: 3, tick: 0, from: 2, c: 2, p: { marks: { a: [{ n: 1 }] } } });
    expect(predicted.state).toBe(room.state);
  });

  it("takes back the effect of a command the room refuses", async () => {
    const { room, socket } = await welcomed(board());
    const told: number[] = [];
    const predicted = new Predictor(room, { apply, onState: (state) => told.push(state.count) });
    const sent = predicted.send({ add: 5 });
    void predicted.send({ add: 1 });
    expect(predicted.state!.count).toBe(6);

    socket.receive({ t: "reject", id: 1, reason: "not_your_turn" });
    await expect(sent).rejects.toMatchObject({ reason: "not_your_turn" });
    expect(predicted.state!.count).toBe(1);
    expect(told).toEqual([5, 6, 1]);
  });

  it("leaves out a prediction that throws, and goes on predicting while the connection is away", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { room, socket } = await welcomed(board());
    const predicted = new Predictor(room, { apply });
    void predicted.send({ fail: true });
    void predicted.send({ add: 2 });
    expect(predicted.state!.count).toBe(2);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();

    socket.drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(predicted.state).toBe(room.state);
    // A command sent now waits for the connection, and shows in the meantime.
    const waiting = predicted.send({ add: 9 });
    expect(predicted.state!.count).toBe(9);
    // Until the client gives it up.
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(waiting).rejects.toMatchObject({ reason: "not_connected" });
    expect(predicted.state).toBe(room.state);
    room.close();
  });

  it("stops following the room when it is closed", async () => {
    const { room, socket } = await welcomed(board());
    const told: number[] = [];
    const predicted = new Predictor(room, { apply, onState: (state) => told.push(state.count) });
    predicted.close();
    socket.receive({ t: "patch", seq: 1, tick: 0, from: 0, p: { count: [3] } });
    expect(told).toEqual([]);
  });
});

describe("Predictor with a tick", () => {
  /** One unit that walks ten a tick towards where it was sent, as the room simulates it. */
  interface World {
    units: Record<string, { x: number; to: number }>;
  }
  type Order = { to: number };
  const step = (unit: { x: number; to: number }) => {
    unit.x += Math.sign(unit.to - unit.x) * Math.min(10, Math.abs(unit.to - unit.x));
  };
  const options = {
    apply: (state: World, order: Order, you: string) => {
      state.units[you]!.to = order.to;
    },
    tick: (state: World, you: string) => step(state.units[you]!),
  };
  const world = (): World => ({ units: { p1: { x: 0, to: 0 }, p2: { x: 500, to: 0 } } });

  /**
   * A room at ten ticks a second, a client whose frames take `down` ms to
   * arrive and whose commands take `up` ms to reach the room, and a
   * predictor on that client. `run(ms)` lets time pass.
   */
  async function playing(down: number, up: number, others: "moving" | "still" = "moving") {
    // The room's tick 0 is at time 0, and its welcome takes as long to arrive as any frame.
    await vi.advanceTimersByTimeAsync(down);
    const { room, socket } = await welcomed<World>(world(), 10);
    let ticks = 0;
    const predicted = new Predictor<World, Order>(room as unknown as RoomClient<World, Order>, {
      ...options,
      tick(state, you) {
        ticks += 1;
        options.tick(state, you);
      },
    });
    const server = { state: world(), tick: 0, seq: 0, owed: [] as number[] };
    // With the others still, nothing in p1's view changes unless p1's own unit moves.
    if (others === "still") server.state.units.p2!.to = 500;
    const arriving: { at: number; frame: unknown }[] = [];
    const commands: { at: number; id: number; order: Order }[] = [];
    let handled = 0;
    let time = down;
    const run = async (ms: number) => {
      // In steps of ten: everything here happens on a multiple of ten milliseconds.
      for (const end = time + ms; time < end; ) {
        time += 10;
        await vi.advanceTimersByTimeAsync(10);
        // Commands the client has sent since, on their way to the room.
        const sent = socket.sent.filter((frame) => frame.startsWith("{")).map((frame) => JSON.parse(frame) as { id: number; data: Order });
        for (; handled < sent.length; handled++) commands.push({ at: time + up, id: sent[handled]!.id, order: sent[handled]!.data });
        // The room: commands as they arrive, a tick every 100 ms, a frame only if p1's view changed.
        for (const command of commands.splice(0)) {
          if (command.at > time) {
            commands.push(command);
          } else {
            server.state.units.p1!.to = command.order.to;
            server.owed.push(command.id);
          }
        }
        if (time % 100 === 0) {
          server.tick += 1;
          const before = JSON.stringify(server.state.units.p1);
          step(server.state.units.p1!);
          step(server.state.units.p2!);
          const p1 = server.state.units.p1!;
          const p2 = server.state.units.p2!;
          const c = server.owed.at(-1);
          const moved = JSON.stringify(p1) !== before;
          // As the room does: a frame only for a tick that changed what the player sees.
          if (moved || others === "moving") {
            server.seq += 1;
            arriving.push({ at: time + down, frame: { t: "patch", seq: server.seq, tick: server.tick, ...(c === undefined ? {} : { c }), p: { units: { ...(moved ? { p1: [{ ...p1 }] } : {}), p2: [{ ...p2 }] } } } });
          }
          for (const id of server.owed.splice(0)) arriving.push({ at: time + down, frame: { t: "ack", id, seq: server.seq, tick: server.tick } });
        }
        for (const due of arriving.splice(0)) {
          if (due.at <= time) socket.receive(due.frame);
          else arriving.push(due);
        }
      }
    };
    return { room, predicted, server, run, now: () => time, ticksRun: () => ticks };
  }

  it("moves the player's own unit the moment they act, a tick's worth, and the others not at all", async () => {
    const { room, predicted, run } = await playing(30, 30);
    await run(220);
    expect(predicted.state!.units.p1!.x).toBe(0);
    void predicted.send({ to: 100 });
    // At once: the order, and the first tick of the walk.
    expect(predicted.state!.units.p1).toEqual({ x: 10, to: 100 });
    expect(room.state!.units.p1).toEqual({ x: 0, to: 0 });
    // Another player's unit is where the room last said it was.
    expect(predicted.state!.units.p2).toBe(room.state!.units.p2);
  });

  it("stays ahead of the room by as long as a command takes to show, and agrees with it when it does", async () => {
    const { room, predicted, server, run } = await playing(30, 30);
    await run(220);
    void predicted.send({ to: 300 });
    // From here on: what is drawn only ever moves forward, a tick's worth at a time, and when the
    // room's state arrives it never pulls the unit back.
    let last = predicted.state!.units.p1!.x;
    const jumps: number[] = [];
    for (let ms = 0; ms < 1500; ms += 10) {
      await run(10);
      const x = predicted.state!.units.p1!.x;
      jumps.push(x - last);
      last = x;
    }
    expect(Math.min(...jumps)).toBe(0);
    expect(Math.max(...jumps)).toBe(10);
    expect(predicted.lead).toBe(1);

    // The room got the order 30 ms after it was sent and ran it from its third tick on.
    // The prediction is one tick ahead of what the room has sent.
    expect(server.state.units.p1!.x).toBe(Math.min(300, (server.tick - 2) * 10));
    const ahead = predicted.state!.units.p1!.x - room.state!.units.p1!.x;
    expect(ahead).toBeGreaterThanOrEqual(10);
    expect(ahead).toBeLessThanOrEqual(20);

    // Once the unit has arrived, both agree, and the prediction is the room's state itself.
    await run(2500);
    expect(room.state!.units.p1).toEqual({ x: 300, to: 300 });
    expect(predicted.state).toBe(room.state);
  });

  it("runs further ahead on a slower connection, by what it has measured", async () => {
    const { predicted, room, run } = await playing(120, 130);
    await run(250);
    for (let n = 1; n <= 5; n++) {
      void predicted.send({ to: 100 * n });
      await run(400);
    }
    // A quarter of a second there and back is three ticks at ten a second.
    expect(predicted.lead).toBe(3);
    void predicted.send({ to: 1000 });
    await run(600);
    const ahead = predicted.state!.units.p1!.x - room.state!.units.p1!.x;
    expect(ahead).toBeGreaterThanOrEqual(30);
    expect(ahead).toBeLessThanOrEqual(40);
  });

  it("knows what tick it is when the room has been sending nothing, and does not run the quiet ticks again and again", async () => {
    // Nothing moves, so the room sends no frames: the last one the player has is the welcome.
    const { room, predicted, server, run, ticksRun } = await playing(30, 30, "still");
    await run(5_000);
    expect(room.tick).toBe(0);
    expect(server.tick).toBe(50);
    const before = ticksRun();
    expect(predicted.state!.units.p1!.x).toBe(0);
    // Fifty ticks went by. They changed nothing, and are not all run to find that out.
    expect(ticksRun() - before).toBeLessThanOrEqual(5);

    // An order now is run from the tick the room will run it in: one tick's walk at once, not fifty.
    await run(20);
    void predicted.send({ to: 200 });
    expect(predicted.state!.units.p1!.x).toBe(10);
    let last = 10;
    const jumps: number[] = [];
    for (let ms = 0; ms < 1000; ms += 10) {
      await run(10);
      const x = predicted.state!.units.p1!.x;
      jumps.push(x - last);
      last = x;
    }
    expect(Math.min(...jumps)).toBe(0);
    expect(Math.max(...jumps)).toBe(10);
    await run(2500);
    expect(room.state!.units.p1).toEqual({ x: 200, to: 200 });
    expect(predicted.state).toBe(room.state);
  });

  it("takes a unit that was sent somewhere it may not go back to where the room has it", async () => {
    const { room, socket } = await welcomed<World>(world(), 10);
    const predicted = new Predictor<World, Order>(room as unknown as RoomClient<World, Order>, options);
    const sent = predicted.send({ to: 100 });
    expect(predicted.state!.units.p1!.x).toBe(10);
    socket.receive({ t: "reject", id: 1, reason: "blocked" });
    await expect(sent).rejects.toMatchObject({ reason: "blocked" });
    expect(predicted.state!.units.p1).toEqual({ x: 0, to: 0 });
  });
});
