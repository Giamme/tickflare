/**
 * Lockstep: the room does not simulate. It puts everyone's inputs in order,
 * cuts them into numbered turns and sends every player the same turns. Each
 * client runs the same deterministic simulation over them.
 */

/** One thing that happened in a turn: a player's input, or a player coming or going. */
export interface TurnEntry<Input = unknown> {
  /** Who it was. */
  player: string;
  /** Their input, as the room's `parseInput` returned it. */
  input?: Input;
  /** Set instead of `input` when the player joined, left, dropped or came back. */
  event?: "join" | "leave" | "disconnect" | "reconnect";
}

/** What clients see of a lockstep room. */
export interface LockstepView<Input = unknown> {
  /** Seed for the simulation's random numbers. The same for every player and every replay. */
  seed: number;
  /** The latest turn. */
  turn: number;
  /** What happened in the latest turn, in the order every client must apply it. */
  entries: TurnEntry<Input>[];
  /** Set once two players reported different hashes for the same turn. */
  desync: {
    /** The first turn two players' hashes differed on. */
    turn: number;
  } | null;
  /**
   * Set to `"players"` by a room whose `turnClock` is `"players"`: the room
   * sleeps between turns, and closes them when a player's client asks.
   */
  clock?: "players";
}

/**
 * What a room with `turnClock = "players"` sends when it closes turns: turns
 * `n` to `n + c - 1`, all empty but the last, which has `e`.
 */
export interface TurnsMessage<Input = unknown> {
  /** Marks the message as this one, among any the game sends itself. */
  tickflare: "turns";
  /** The first turn closed. */
  n: number;
  /** How many were closed. */
  c: number;
  /** What happened in the last of them. */
  e: TurnEntry<Input>[];
  /** The player whose request closed them, when it was a request. */
  b?: string;
}

/** Everything needed to run a match again: the seed and every turn in which something happened. */
export interface Replay<Input = unknown> {
  /** Format version. Recordings made before 0.1 are version 1; `runReplay` reads both. */
  v: 2;
  /** The simulation's seed. */
  seed: number;
  /** Turns per second. */
  turnRate: number;
  /** The last turn of the recording. Turns missing from `turns` were empty. */
  turn: number;
  /** Every turn in which something happened, in order, with what happened in it. */
  turns: [turn: number, entries: TurnEntry<Input>[]][];
}

/**
 * A deterministic game: how to start it from a seed and how to advance it by
 * one turn. Clients run it live with `LockstepClient`; `runReplay` runs it
 * over a recording.
 */
export interface Simulation<Input, Sim> {
  /** Build the simulation at turn 0. Everything random must come from `seed`. */
  create(seed: number): Sim;
  /** Advance by one turn. Must be deterministic: same simulation and entries in, same simulation out. */
  step(sim: Sim, entries: TurnEntry<Input>[], turn: number): void;
}

/** Runs a recording from the start and returns the simulation as it stands after turn `upTo`. */
export function runReplay<Input, Sim>(
  replay: Replay<Input>,
  simulation: Simulation<Input, Sim>,
  upTo = replay.turn,
): Sim {
  const sim = simulation.create(replay.seed);
  const legacy = (replay as { v: number }).v === 1;
  let next = 0;
  for (let turn = 1; turn <= upTo; turn++) {
    const recorded = replay.turns[next];
    if (recorded && recorded[0] === turn) {
      simulation.step(sim, legacy ? recorded[1].map(fromVersion1<Input>) : recorded[1], turn);
      next += 1;
    } else {
      simulation.step(sim, [], turn);
    }
  }
  return sim;
}

/** Version 1 recordings spelled entries `{ p, i, e }`. */
function fromVersion1<Input>(entry: unknown): TurnEntry<Input> {
  const { p, i, e } = entry as { p: string; i?: Input; e?: TurnEntry["event"] };
  return e === undefined ? { player: p, input: i } : { player: p, event: e };
}

/**
 * A small deterministic random number generator (mulberry32). `Math.random`
 * differs on every machine; this gives every client the same sequence for the
 * same seed. Returns numbers in [0, 1).
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
