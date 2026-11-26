/**
 * Test cases for prediction and interpolation in clients other than the
 * TypeScript one: the Godot and Unity clients replay these and must come to
 * the same states. `test/prediction-vectors.test.ts` checks that the file
 * written from here is what the TypeScript client does today.
 *
 * Every case uses the same small game, which each client's tests write out
 * again in their own language:
 *
 *   state    { "units": { "<player>": { "x": number, "target": number } } }
 *   apply    a command { "type": "move", "to": n } sets the player's unit's target to n
 *   tick     the player's unit steps one towards its target
 */
import { Interpolator } from "../../src/client/interpolate.js";
import { Predictor } from "../../src/client/predict.js";
import type { RoomClient, SentCommand } from "../../src/client/index.js";

interface Unit {
  x: number;
  target: number;
}
interface State {
  units: Record<string, Unit>;
}
interface Command {
  type: "move";
  to: number;
}

/** What happens to the client, in order, each at a time in milliseconds. */
export type PredictionEvent =
  | { at: number; frame: { tick: number; state: State; c?: number } }
  | { at: number; send: Command }
  | { at: number; ack: number; tick?: number }
  | { at: number; reject: number }
  | { at: number; read: { state: State | null; lead: number } };

export interface PredictionCase {
  name: string;
  about: string;
  tickRate: number;
  you: string;
  /** Whether the game's tick is given to the predictor. */
  ticks: boolean;
  events: PredictionEvent[];
}

export interface InterpolationCase {
  name: string;
  about: string;
  durationMs: number;
  fields: string[];
  events: (
    | { at: number; update: Record<string, Record<string, number>> }
    | { at: number; read: string; values: Record<string, number> | null }
    | { at: number; clear: true }
  )[];
}

const apply = (state: State, command: Command, you: string) => {
  const unit = state.units[you];
  if (command.type === "move" && unit) unit.target = command.to;
};
const tick = (state: State, you: string) => {
  const unit = state.units[you];
  if (!unit) return;
  if (unit.x < unit.target) unit.x = Math.min(unit.target, unit.x + 1);
  else if (unit.x > unit.target) unit.x = Math.max(unit.target, unit.x - 1);
};

/** A client as far as a predictor can tell: state, ticks, commands not yet shown, and the answers to them. */
class FakeRoom {
  state: State | undefined;
  tick = 0;
  unconfirmed: SentCommand<Command>[] = [];
  readonly status = "open";
  readonly you: string;
  readonly tickRate: number;
  #next = 1;
  #listeners = new Set<() => void>();
  #pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();

  constructor(you: string, tickRate: number) {
    this.you = you;
    this.tickRate = tickRate;
  }

  on(event: "state" | "status", listener: () => void): () => void {
    // The connection never changes here.
    if (event !== "state") return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  send(command: Command): Promise<void> {
    const id = this.#next++;
    this.unconfirmed = [...this.unconfirmed, { id, command }];
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  /** As RoomClient takes a frame: commands it shows leave `unconfirmed` as the state changes, then are answered. */
  frame(frame: { tick: number; state: State; c?: number }): void {
    this.tick = frame.tick;
    if (frame.c !== undefined) this.#shown(frame.c);
    this.state = structuredClone(frame.state);
    for (const listener of this.#listeners) listener();
    if (frame.c !== undefined) for (const id of [...this.#pending.keys()]) if (id <= frame.c) this.#settle(id, true);
  }

  ack(id: number, tick?: number): void {
    if (tick !== undefined && tick > this.tick) this.tick = tick;
    this.#shown(id);
    this.#settle(id, true);
  }

  reject(id: number): void {
    this.unconfirmed = this.unconfirmed.filter((sent) => sent.id !== id);
    this.#settle(id, false);
  }

  #shown(id: number): void {
    if (this.unconfirmed.some((sent) => sent.id <= id)) this.unconfirmed = this.unconfirmed.filter((sent) => sent.id > id);
  }

  #settle(id: number, ok: boolean): void {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    if (ok) pending?.resolve();
    else pending?.reject(new Error("refused"));
  }
}

/** Plays a case's events through the TypeScript predictor, and fills in what each read sees. */
async function play(base: Omit<PredictionCase, "events"> & { events: PredictionEvent[] }): Promise<PredictionCase> {
  for (let n = 1; n < base.events.length; n++) {
    if (base.events[n]!.at < base.events[n - 1]!.at) throw new Error(`${base.name}: event ${n} goes back in time`);
  }
  const room = new FakeRoom(base.you, base.tickRate);
  let clock = 0;
  const predictor = new Predictor<State, Command>(room as unknown as RoomClient<State, Command>, {
    apply,
    ...(base.ticks ? { tick } : {}),
    now: () => clock,
  });
  const events: PredictionEvent[] = [];
  for (const event of base.events) {
    clock = event.at;
    if ("frame" in event) room.frame(event.frame);
    else if ("send" in event) predictor.send(event.send).catch(() => {});
    else if ("ack" in event) room.ack(event.ack, event.tick);
    else if ("reject" in event) room.reject(event.reject);
    // Answers settle a moment later, as they do in a client: let them before the next event.
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    if ("read" in event) {
      const state = predictor.state;
      events.push({ at: event.at, read: { state: state === undefined ? null : structuredClone(state), lead: predictor.lead } });
    } else {
      events.push(event);
    }
  }
  return { ...base, events };
}

const read = (at: number): PredictionEvent => ({ at, read: { state: null, lead: 0 } });
const units = (x: number, target: number, other?: Unit): State => ({ units: { p1: { x, target }, ...(other ? { p2: other } : {}) } });

export async function predictionCases(): Promise<PredictionCase[]> {
  const cases: PredictionCase[] = [];

  cases.push(
    await play({
      name: "event mode",
      about: "No ticks: each command shows at once, and leaves when the room's state shows it or the room refuses it.",
      tickRate: 0,
      you: "p1",
      ticks: false,
      events: [
        read(0),
        { at: 0, frame: { tick: 0, state: units(0, 0, { x: 3, target: 3 }) } },
        read(1),
        { at: 10, send: { type: "move", to: 5 } },
        read(11),
        { at: 40, frame: { tick: 0, state: units(0, 5, { x: 3, target: 3 }), c: 1 } },
        read(41),
        { at: 50, send: { type: "move", to: 7 } },
        { at: 51, send: { type: "move", to: 9 } },
        read(52),
        { at: 60, reject: 2 },
        read(61),
        { at: 70, frame: { tick: 0, state: units(0, 4, { x: 1, target: 1 }) } },
        read(71),
        { at: 80, ack: 3 },
        read(81),
      ],
    }),
  );

  // Ten ticks a second, a frame for every tick, arriving 30 ms after its tick.
  const walk: PredictionEvent[] = [];
  let x = 0;
  let target = 0;
  const frameAt = (n: number, c?: number) => ({ at: n * 100 + 30, frame: { tick: n, state: units(x, target), ...(c === undefined ? {} : { c }) } });
  for (let n = 0; n <= 3; n++) walk.push(frameAt(n));
  walk.push(read(345));
  walk.push({ at: 350, send: { type: "move", to: 6 } });
  walk.push(read(351), read(399));
  // The room applies it in the tick after it arrives: tick 5 shows it, and the unit starts walking.
  walk.push(frameAt(4));
  target = 6;
  for (let n = 5; n <= 9; n++) {
    if (n > 5) x = Math.min(target, x + 1);
    walk.push(frameAt(n, n === 5 ? 1 : undefined), read(n * 100 + 31), read(n * 100 + 80));
  }
  walk.push({ at: 985, send: { type: "move", to: 2 } }, read(986), read(1025));
  for (let n = 10; n <= 13; n++) {
    if (n === 11) target = 2;
    else x = x < target ? x + 1 : x > target ? x - 1 : x;
    walk.push(frameAt(n, n === 11 ? 2 : undefined), read(n * 100 + 31));
  }
  // Frames stop for a while: the prediction does not run more than a few ticks past the last one.
  walk.push(read(1700), read(2400));
  cases.push(
    await play({
      name: "ticking",
      about:
        "Ten ticks a second. The prediction runs as far ahead of the room's state as a command takes to show, measured from the commands so far, and walks the player's own unit with the game's tick.",
      tickRate: 10,
      you: "p1",
      ticks: true,
      events: walk,
    }),
  );

  cases.push(
    await play({
      name: "ticking, refused",
      about: "A command the room refuses is taken back the moment it says so, in a ticking room too.",
      tickRate: 20,
      you: "p1",
      ticks: true,
      events: [
        { at: 25, frame: { tick: 0, state: units(4, 4) } },
        { at: 75, frame: { tick: 1, state: units(4, 4) } },
        { at: 80, send: { type: "move", to: 0 } },
        read(81),
        read(120),
        { at: 125, frame: { tick: 2, state: units(4, 4) } },
        read(126),
        { at: 130, reject: 1 },
        read(131),
      ],
    }),
  );

  cases.push(
    await play({
      name: "ticking, without the game's tick",
      about: "Without a tick to run, a ticking room's commands are predicted as in event mode: applied once, on the room's latest state.",
      tickRate: 10,
      you: "p1",
      ticks: false,
      events: [
        { at: 30, frame: { tick: 0, state: units(0, 0) } },
        { at: 40, send: { type: "move", to: 3 } },
        read(41),
        read(120),
        { at: 130, frame: { tick: 1, state: units(0, 3), c: 1 } },
        read(131),
      ],
    }),
  );
  return cases;
}

export function interpolationCases(): InterpolationCase[] {
  const cases: InterpolationCase[] = [];
  const glide = new Interpolator(100, ["x", "y"]);
  const events: InterpolationCase["events"] = [];
  const at = (now: number, id: string) => events.push({ at: now, read: id, values: glide.at(id, now) ?? null });
  const update = (now: number, targets: Record<string, Record<string, number>>) => {
    glide.update(targets as Record<string, Record<"x" | "y", number>>, now);
    events.push({ at: now, update: targets });
  };
  at(0, "a");
  update(0, { a: { x: 0, y: 0, hp: 9 } });
  at(0, "a");
  at(50, "a");
  update(100, { a: { x: 10, y: -4, hp: 8 }, b: { x: 5, y: 5, hp: 1 } });
  at(100, "a");
  at(125, "a");
  at(150, "a");
  at(150, "b");
  // A new value before the glide is over starts from where it was being drawn.
  update(160, { a: { x: 20, y: 0, hp: 8 }, b: { x: 6, y: 5, hp: 1 } });
  at(160, "a");
  at(210, "a");
  at(260, "a");
  at(400, "a");
  // An id that is gone is forgotten.
  update(400, { b: { x: 7, y: 5, hp: 1 } });
  at(400, "a");
  at(450, "b");
  glide.clear();
  events.push({ at: 460, clear: true });
  at(460, "b");
  cases.push({
    name: "glide",
    about: "Two fields smoothed over 100 ms; a field that is not named is left alone.",
    durationMs: 100,
    fields: ["x", "y"],
    events,
  });
  return cases;
}
