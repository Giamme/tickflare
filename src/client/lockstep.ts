import {
  runReplay,
  type LockstepView,
  type Replay,
  type Simulation,
  type TurnEntry,
} from "../lockstep.js";
import { RoomClient, type CloseDetail, type ConnectionStatus } from "./index.js";
import { TurnPacer } from "./pacer.js";
import { roomIn, withFreshToken, type TokenSource } from "./token.js";

/** The simulation to run, what to report and how to connect. `create` and `step` are required. */
export interface LockstepClientOptions<Input, Sim> extends Simulation<Input, Sim> {
  /**
   * A fingerprint of the simulation. When given, it is sent to the room every
   * `hashEvery` turns, and the room flags the match if two players disagree.
   */
  hash?(sim: Sim): string | number;
  /** How often to report the hash, in turns. Defaults to 20. */
  hashEvery?: number;
  /**
   * How many turns to hold back so that the simulation advances at an even
   * pace when the network delivers turns unevenly. Defaults to 1, which adds
   * one turn of delay and absorbs up to one turn of jitter. 0 applies every
   * turn the moment it arrives.
   */
  bufferTurns?: number;
  /** The simulation advanced to `turn`. Not called while catching up after (re)connecting. */
  onTurn?(sim: Sim, turn: number): void;
  /** The simulation has caught up with the room and is live. */
  onReady?(sim: Sim, turn: number): void;
  /** Two players' simulations differed at `turn`. */
  onDesync?(turn: number): void;
  /** The connection's status changed: see `RoomClientOptions.onStatus`. */
  onStatus?(status: ConnectionStatus, detail?: CloseDetail): void;
  /**
   * Supplies the join token, instead of putting one in the URL: see
   * `RoomClientOptions.token`. Also asked before the recording is loaded.
   */
  token?: TokenSource;
  /** How to load the recording when (re)connecting. Defaults to `fetch` on the room's `/replay` URL. */
  loadReplay?(url: string): Promise<Replay<Input>>;
}

/**
 * Plays in a lockstep room: sends this player's inputs, and runs the
 * simulation over the turns the room sends back.
 *
 * On every (re)connect the simulation is rebuilt from the room's recording
 * and then follows the live turns, so a reload or a dropped connection ends
 * up in exactly the same state as everyone else.
 */
export class LockstepClient<Input = unknown, Sim = unknown> {
  #sim: Sim | undefined;
  #turn = 0;
  #ready = false;

  readonly #room: RoomClient<LockstepView<Input>, unknown>;
  readonly #options: LockstepClientOptions<Input, Sim>;
  readonly #replayUrl: string;
  /** The room's id, which is what a token is asked for. */
  readonly #roomId: string;
  /** Live turns that arrived while the recording was loading. */
  #buffer = new Map<number, TurnEntry<Input>[]>();
  /** Plays live turns out evenly. Created once the turn rate is known. */
  #pacer: TurnPacer<{ turn: number; entries: TurnEntry<Input>[] }> | undefined;
  /** The latest turn received, which can be ahead of the one the simulation is at. */
  #received = 0;
  #needsSync = true;
  /** Guards against an older catch-up finishing after a newer one started. */
  #syncId = 0;
  #desyncReported = false;

  constructor(url: string | URL, options: LockstepClientOptions<Input, Sim>) {
    this.#options = options;
    const replay = new URL(String(url));
    replay.protocol = replay.protocol === "wss:" ? "https:" : "http:";
    replay.pathname = `${replay.pathname.replace(/\/+$/, "")}/replay`;
    this.#replayUrl = replay.toString();
    this.#roomId = roomIn(String(url));

    this.#room = new RoomClient<LockstepView<Input>, unknown>(url, {
      onStatus: (status, detail) => {
        if (status !== "open") {
          this.#ready = false;
          this.#pacer?.clear();
        }
        if (status === "open") this.#needsSync = true;
        options.onStatus?.(status, detail);
      },
      token: options.token,
      onState: (view) => this.#receive(view),
    });
  }

  /** The simulation. Undefined until the first catch-up finishes. */
  get sim(): Sim | undefined {
    return this.#sim;
  }

  /** The turn the simulation is at. */
  get turn(): number {
    return this.#turn;
  }

  /** True once the simulation has caught up with the room. */
  get ready(): boolean {
    return this.#ready;
  }

  /** Where the connection stands. */
  get status(): ConnectionStatus {
    return this.#room.status;
  }

  /** This player's id, as the server knows it. Set once connected. */
  get you(): string | undefined {
    return this.#room.you;
  }

  /** Send an input. It takes effect in the turn the room puts it in, for everyone at once. */
  input(input: Input): Promise<void> {
    return this.#room.send({ k: "i", d: input });
  }

  /** Give up the seat. Every simulation sees the player leave in the same turn. See `RoomClient.leave`. */
  leave(): Promise<void> {
    return this.#room.leave();
  }

  /** Close the connection for good, keeping the seat. No reconnect follows. */
  close(): void {
    this.#pacer?.clear();
    this.#room.close();
  }

  #receive(view: LockstepView<Input>): void {
    if (view.desync && !this.#desyncReported) {
      this.#desyncReported = true;
      this.#options.onDesync?.(view.desync.turn);
    }
    if (this.#needsSync) {
      this.#needsSync = false;
      this.#buffer.clear();
      void this.#catchUp();
    }
    if (!this.#ready) {
      this.#buffer.set(view.turn, view.entries);
    } else if (view.turn === this.#received + 1) {
      this.#received = view.turn;
      this.#pacer?.push({ turn: view.turn, entries: view.entries });
    } else if (view.turn > this.#received + 1) {
      // A turn went missing. Start over from the recording.
      this.#ready = false;
      this.#pacer?.clear();
      this.#buffer.clear();
      void this.#catchUp();
    }
  }

  async #catchUp(): Promise<void> {
    const id = ++this.#syncId;
    let replay: Replay<Input>;
    try {
      const { token } = this.#options;
      const url = token ? await withFreshToken(this.#replayUrl, this.#roomId, token) : this.#replayUrl;
      replay = await (this.#options.loadReplay ?? loadReplay)(url);
    } catch (err) {
      console.warn("[tickflare] could not load the recording; retrying on the next turn", err);
      if (id === this.#syncId) this.#needsSync = true;
      return;
    }
    if (id !== this.#syncId) return;

    this.#sim = runReplay(replay, this.#options);
    this.#turn = replay.turn;
    // Turns that arrived while the recording was loading continue where it ends.
    for (let turn = this.#turn + 1; this.#buffer.has(turn); turn++) {
      this.#advance(this.#buffer.get(turn)!, turn, false);
    }
    this.#buffer.clear();
    this.#received = this.#turn;
    this.#pacer?.clear();
    this.#pacer = new TurnPacer(
      1000 / (this.#room.tickRate || 10),
      this.#options.bufferTurns ?? 1,
      ({ turn, entries }) => this.#advance(entries, turn, true),
    );
    this.#ready = true;
    this.#options.onReady?.(this.#sim, this.#turn);
  }

  #advance(entries: TurnEntry<Input>[], turn: number, live: boolean): void {
    const sim = this.#sim as Sim;
    this.#options.step(sim, entries, turn);
    this.#turn = turn;
    const { hash, hashEvery = 20 } = this.#options;
    // Only live turns are reported: hashes of old turns have nobody left to be compared with.
    if (live && hash && turn % hashEvery === 0) {
      this.#room.send({ k: "h", n: turn, h: String(hash(sim)) }).catch(() => {});
    }
    if (live) this.#options.onTurn?.(sim, turn);
  }
}

async function loadReplay<Input>(url: string): Promise<Replay<Input>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Replay request failed with ${response.status}`);
  return (await response.json()) as Replay<Input>;
}
