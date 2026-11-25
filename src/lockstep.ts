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
  desync: Desync | null;
  /**
   * Set to `"players"` by a room whose `turnClock` is `"players"`: the room
   * sleeps between turns, and closes them when a player's client asks.
   */
  clock?: "players";
  /**
   * How many turns go by between snapshots, when the room keeps them: a
   * client whose simulation has `save` and `load` sends one each time the
   * turn is a multiple of this.
   */
  snapshotEvery?: number;
}

/** Two players' simulations were found to differ: when, whose, and, once the room knows, where. */
export interface Desync {
  /** The first turn two players' hashes differed on. */
  turn: number;
  /**
   * The two players whose hashes differed. With more players in the room,
   * the others agree with one of them or have not reported that turn.
   * Absent in a room saved before this was noted.
   */
  players?: [string, string];
  /**
   * Where the two simulations differed at that turn: see `differences`.
   * Set once both players' clients have sent the room what they saved then,
   * which they do by themselves when the simulation has `save`. Empty when
   * what they saved is the same, and the difference is in something `save`
   * leaves out. Absent until then, and for good when a client had nothing
   * to send.
   */
  differs?: DesyncDifference[];
}

/** One place where two simulations differed. */
export interface DesyncDifference {
  /** Where, as a path into what `save` returned: `units.12.x`. Empty when the two differ as a whole. */
  path: string;
  /**
   * What each of the two had there, as JSON text, in the order of
   * `Desync.players`. `undefined` where one had nothing, and cut to a
   * hundred characters where it is long.
   */
  values: [string, string];
}

/**
 * Where two values that JSON can hold differ: the first `limit` places, 8
 * unless said otherwise, in the order of the first one's keys. It goes down
 * to what cannot be taken apart further, so two units that differ in one
 * coordinate are one difference, at `units.12.x`, and not two whole units.
 *
 * It is what a lockstep room uses to say where two players' simulations
 * differed. Use it yourself to compare two saved simulations, in a test
 * that runs the same recording twice for instance.
 */
export function differences(a: unknown, b: unknown, limit = 8): DesyncDifference[] {
  const found: DesyncDifference[] = [];
  const show = (value: unknown): string => {
    const text = value === undefined ? "undefined" : (JSON.stringify(value) ?? "undefined");
    return text.length > 100 ? `${text.slice(0, 99)}…` : text;
  };
  const walk = (x: unknown, y: unknown, path: string): void => {
    if (found.length >= limit || x === y) return;
    if (typeof x === "object" && x !== null && typeof y === "object" && y !== null && Array.isArray(x) === Array.isArray(y)) {
      const keys = Array.isArray(x)
        ? Array.from({ length: Math.max(x.length, (y as unknown[]).length) }, (_, index) => String(index))
        : [...new Set([...Object.keys(x), ...Object.keys(y)])];
      for (const key of keys) {
        walk((x as Record<string, unknown>)[key], (y as Record<string, unknown>)[key], path === "" ? key : `${path}.${key}`);
      }
      return;
    }
    found.push({ path, values: [show(x), show(y)] });
  };
  walk(a, b, "");
  return found;
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
 * A simulation as it stood after one turn, saved by a player's client and
 * kept by the room, so that someone joining late starts from it instead of
 * from turn 1.
 */
export interface Snapshot {
  /** The turn the simulation was at. */
  turn: number;
  /** The simulation's hash at that turn, as the players connected then reported it. */
  hash: string;
  /** What the simulation's `save` returned, as JSON text. */
  data: string;
}

/**
 * What a room answers a client that is catching up: the recording, or only
 * the end of it. With `from` set, `turns` has the turns after `from` and
 * nothing earlier: the client continues from the simulation it has, or from
 * `snapshot` when there is one.
 */
export interface CatchUp<Input = unknown> extends Replay<Input> {
  /** The turn `turns` continues from. Absent when it is the whole recording. */
  from?: number;
  /** A simulation saved at turn `from`, to start from. */
  snapshot?: Snapshot;
  /**
   * Names the run of the room that answered. A client sends it back with
   * the turn its simulation is at, and is given only the turns after that
   * if the room has not restarted since.
   */
  epoch?: string;
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
  /**
   * The simulation as JSON: everything `step` reads, the random generator's
   * `state` included. With `load`, it lets a player who joins or reloads
   * late start from a recent snapshot instead of from turn 1.
   */
  save?(sim: Sim): unknown;
  /** The simulation `save` was given, rebuilt from what it returned. */
  load?(saved: unknown): Sim;
}

/** Runs a recording from the start and returns the simulation as it stands after turn `upTo`. */
export function runReplay<Input, Sim>(
  replay: Replay<Input>,
  simulation: Simulation<Input, Sim>,
  upTo = replay.turn,
): Sim {
  const sim = simulation.create(replay.seed);
  stepThrough(sim, replay, simulation, 0, upTo);
  return sim;
}

/**
 * Advances `sim`, which is at turn `from`, to turn `upTo` over a recording.
 * The recording may start anywhere at or before `from`.
 */
export function stepThrough<Input, Sim>(
  sim: Sim,
  replay: Replay<Input>,
  simulation: Simulation<Input, Sim>,
  from: number,
  upTo = replay.turn,
): void {
  const legacy = (replay as { v: number }).v === 1;
  let next = 0;
  while (next < replay.turns.length && replay.turns[next]![0] <= from) next += 1;
  for (let turn = from + 1; turn <= upTo; turn++) {
    const recorded = replay.turns[next];
    if (recorded && recorded[0] === turn) {
      simulation.step(sim, legacy ? recorded[1].map(fromVersion1<Input>) : recorded[1], turn);
      next += 1;
    } else {
      simulation.step(sim, [], turn);
    }
  }
}

/** Version 1 recordings spelled entries `{ p, i, e }`. */
function fromVersion1<Input>(entry: unknown): TurnEntry<Input> {
  const { p, i, e } = entry as { p: string; i?: Input; e?: TurnEntry["event"] };
  return e === undefined ? { player: p, input: i } : { player: p, event: e };
}

/** A generator made by `seededRandom`: call it for the next number in [0, 1). */
export interface SeededRandom {
  (): number;
  /**
   * Where the generator stands: one whole number. `seededRandom(state)`
   * makes a generator that carries on from here, which is how a simulation's
   * `save` and `load` keep its randomness.
   */
  readonly state: number;
}

/**
 * A small deterministic random number generator (mulberry32). `Math.random`
 * differs on every machine; this gives every client the same sequence for the
 * same seed. Returns numbers in [0, 1).
 */
export function seededRandom(seed: number): SeededRandom {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.defineProperty(next, "state", { get: () => a, enumerable: true }) as SeededRandom;
}

/**
 * A fingerprint of anything JSON can hold: the first 32 hex digits of the
 * SHA-256 of its JSON text. Two simulations that save to the same JSON have
 * the same one, and nobody can make a different simulation that has it too,
 * which is what makes it the right `hash` for snapshots. It is what
 * `LockstepClient` uses when a simulation has `save` and no `hash`.
 *
 * It reads the whole value each time: about a millisecond for 100 KB of
 * JSON. For a very large simulation, report it less often (`hashEvery`).
 */
export function fingerprint(value: unknown): string {
  return fingerprintOfText(JSON.stringify(value) ?? "");
}

/** `fingerprint` of a value whose JSON text is at hand already. */
export function fingerprintOfText(text: string): string {
  return sha256(new TextEncoder().encode(text)).slice(0, 32);
}

const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be,
  0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa,
  0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85,
  0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
  0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * SHA-256, as hex. Written out because a simulation is hashed in the middle
 * of a turn, and the one browsers offer, `crypto.subtle.digest`, answers
 * later.
 */
function sha256(bytes: Uint8Array): string {
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000));
  view.setUint32(padded.length - 4, (length << 3) >>> 0);
  const w = new Int32Array(64);
  const rotate = (n: number, by: number) => (n >>> by) | (n << (32 - by));
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85 | 0;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a | 0;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c | 0;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getInt32(at + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]!;
      const y = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + w[i - 7]! + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) | 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) | 0;
      const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7].map((n) => (n >>> 0).toString(16).padStart(8, "0")).join("");
}
