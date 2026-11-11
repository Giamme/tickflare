import {
  runReplay,
  type LockstepView,
  type Replay,
  type Simulation,
  type TurnEntry,
} from "../lockstep.js";
import { RoomClient, type ConnectionStatus } from "./index.js";

export interface LockstepClientOptions<Input, Sim> extends Simulation<Input, Sim> {
  /**
   * A fingerprint of the simulation. When given, it is sent to the room every
   * `hashEvery` turns, and the room flags the match if two players disagree.
   */
  hash?(sim: Sim): string | number;
  /** How often to report the hash, in turns. Defaults to 20. */
  hashEvery?: number;
  /** The simulation advanced to `turn`. Not called while catching up after (re)connecting. */
  onTurn?(sim: Sim, turn: number): void;
  /** The simulation has caught up with the room and is live. */
  onReady?(sim: Sim, turn: number): void;
  /** Two players' simulations differed at `turn`. */
  onDesync?(turn: number): void;
  onStatus?(status: ConnectionStatus, detail?: { code: number; reason: string }): void;
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
  /** The simulation. Undefined until the first catch-up finishes. */
  sim: Sim | undefined;
  /** The turn the simulation is at. */
  turn = 0;
  /** True once the simulation has caught up with the room. */
  ready = false;

  readonly #room: RoomClient<LockstepView<Input>, unknown>;
  readonly #options: LockstepClientOptions<Input, Sim>;
  readonly #replayUrl: string;
  /** Live turns that arrived while the recording was loading. */
  #buffer = new Map<number, TurnEntry<Input>[]>();
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

    this.#room = new RoomClient<LockstepView<Input>, unknown>(url, {
      onStatus: (status, detail) => {
        if (status !== "open") this.ready = false;
        if (status === "open") this.#needsSync = true;
        options.onStatus?.(status, detail);
      },
      onState: (view) => this.#receive(view),
    });
  }

  get status(): ConnectionStatus {
    return this.#room.status;
  }

  get you(): string | undefined {
    return this.#room.you;
  }

  /** Send an input. It takes effect in the turn the room puts it in, for everyone at once. */
  input(input: Input): Promise<void> {
    return this.#room.send({ k: "i", d: input });
  }

  leave(): Promise<void> {
    return this.#room.leave();
  }

  close(): void {
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
    if (!this.ready) {
      this.#buffer.set(view.turn, view.entries);
    } else if (view.turn === this.turn + 1) {
      this.#advance(view.entries, view.turn, true);
    } else if (view.turn > this.turn + 1) {
      // A turn went missing. Start over from the recording.
      this.ready = false;
      this.#buffer.clear();
      void this.#catchUp();
    }
  }

  async #catchUp(): Promise<void> {
    const id = ++this.#syncId;
    let replay: Replay<Input>;
    try {
      replay = await (this.#options.loadReplay ?? loadReplay)(this.#replayUrl);
    } catch (err) {
      console.warn("[tickflare] could not load the recording; retrying on the next turn", err);
      if (id === this.#syncId) this.#needsSync = true;
      return;
    }
    if (id !== this.#syncId) return;

    this.sim = runReplay(replay, this.#options);
    this.turn = replay.turn;
    // Turns that arrived while the recording was loading continue where it ends.
    for (let turn = this.turn + 1; this.#buffer.has(turn); turn++) {
      this.#advance(this.#buffer.get(turn)!, turn, false);
    }
    this.#buffer.clear();
    this.ready = true;
    this.#options.onReady?.(this.sim, this.turn);
  }

  #advance(entries: TurnEntry<Input>[], turn: number, live: boolean): void {
    const sim = this.sim as Sim;
    this.#options.step(sim, entries, turn);
    this.turn = turn;
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
