import {
  fingerprint,
  fingerprintOfText,
  stepThrough,
  type CatchUp,
  type Desync,
  type LockstepView,
  type Replay,
  type Simulation,
  type TurnEntry,
  type TurnsMessage,
} from "../lockstep.js";
import { RoomClient, type CloseDetail, type ConnectionStatus } from "./index.js";
import { TurnPacer } from "./pacer.js";
import { roomIn, withFreshToken, type TokenSource } from "./token.js";

/** For how many of the latest hashed turns the saved simulation is kept: see `LockstepClientOptions.explainDesyncs`. */
const SAVES_KEPT = 2;

/**
 * The simulation to run, what to report and how to connect. `create` and
 * `step` are required. With `save` and `load` as well, the client sends the
 * room snapshots and starts from one when it joins late.
 */
export interface LockstepClientOptions<Input, Sim> extends Simulation<Input, Sim> {
  /**
   * A fingerprint of the simulation, at most 64 characters long. It is sent
   * to the room every `hashEvery` turns, and the room flags the match if two
   * players disagree. A simulation with `save` needs none: its hash is then
   * `fingerprint` of what `save` returns, which covers everything saved.
   * Give your own to hash less than that, for speed; a snapshot is then
   * checked only as far as your hash goes.
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
  /** Two players' simulations differed at `turn`. `desync.players` says whose. */
  onDesync?(turn: number, desync: Desync): void;
  /**
   * The room has compared what the two players' simulations had saved at
   * that turn: `desync.differs` says where they differed, as paths into what
   * `save` returns with the two values. Called for every player, a while
   * after `onDesync`, and not at all when a client had nothing to send.
   */
  onDesyncExplained?(desync: Desync): void;
  /**
   * With a `hash` of your own: also keep what `save` returns at each turn
   * a hash is reported, so that the room can be told where two simulations
   * differ. It costs a `save` every `hashEvery` turns, which a hash of your
   * own is there to avoid, so it is off unless asked for. A simulation with
   * `save` and no `hash` keeps it anyway: it is what it fingerprints.
   */
  explainDesyncs?: boolean;
  /** The connection's status changed: see `RoomClientOptions.onStatus`. */
  onStatus?(status: ConnectionStatus, detail?: CloseDetail): void;
  /**
   * Supplies the join token, instead of putting one in the URL: see
   * `RoomClientOptions.token`. Also asked before the recording is loaded.
   */
  token?: TokenSource;
  /** Ask the room for its patches in binary: see `RoomClientOptions.binary`. */
  binary?: boolean;
  /**
   * How to load the recording when (re)connecting. Defaults to `fetch` on
   * the room's `/replay` URL. The URL says what the client has already, and
   * the room may answer with only the rest: see `CatchUp`.
   */
  loadReplay?(url: string): Promise<Replay<Input> | CatchUp<Input>>;
  /**
   * How to send the room a snapshot, or what the simulation had saved at a
   * turn it differed from another's. Defaults to a `POST` of `data` to `url`
   * with `fetch`.
   */
  sendSnapshot?(url: string, data: string): Promise<unknown>;
}

/**
 * Plays in a lockstep room: sends this player's inputs, and runs the
 * simulation over the turns the room sends back.
 *
 * On every (re)connect the simulation catches up with the room and then
 * follows the live turns, so a reload or a dropped connection ends up in
 * exactly the same state as everyone else. A client that still has its
 * simulation is sent the turns it missed. One that has none starts from the
 * room's latest snapshot if the simulation has `save`, `load` and `hash`,
 * and from turn 1 of the recording otherwise.
 *
 * In a room whose `turnClock` is `"players"` the client also keeps time for
 * it: one player's client at a time asks the room for each turn as it falls
 * due, and the others stand by to take over. There is nothing to set up.
 */
export class LockstepClient<Input = unknown, Sim = unknown> {
  #sim: Sim | undefined;
  #turn = 0;
  #ready = false;

  readonly #room: RoomClient<LockstepView<Input>, unknown>;
  readonly #options: LockstepClientOptions<Input, Sim>;
  /** The hash to report: the game's own, or a fingerprint of what `save` returns. */
  readonly #hash: ((sim: Sim) => string) | undefined;
  readonly #replayUrl: string;
  readonly #snapshotUrl: string;
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
  #desyncExplained = false;
  /** What `save` returned at the latest turns a hash was reported for, as JSON text: see `#explain`. */
  #saved = new Map<number, string>();
  /** The run of the room the simulation was built in: see `CatchUp.epoch`. */
  #epoch: string | undefined;
  /** Turns between snapshots, as the room says. 0 when it keeps none. */
  #snapshotEvery = 0;
  /** The turn of a snapshot that did not load into what its hash promised. None that old is asked for again. */
  #distrusted = 0;
  /** The room sleeps between turns and closes them when a player asks. */
  #clocked = false;
  /** This client is the one asking, because the latest turns were closed at its request. */
  #asking = false;
  #askTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the pending request is due, when the last one was due, and when turns last arrived. */
  #askAt = 0;
  #askedAt = 0;
  #turnsAt = 0;

  constructor(url: string | URL, options: LockstepClientOptions<Input, Sim>) {
    this.#options = options;
    const { hash, save } = options;
    this.#hash = hash ? (sim) => String(hash(sim)) : save ? (sim) => fingerprint(save(sim)) : undefined;
    const replay = new URL(String(url));
    replay.protocol = replay.protocol === "wss:" ? "https:" : "http:";
    replay.pathname = `${replay.pathname.replace(/\/+$/, "")}/replay`;
    this.#replayUrl = replay.toString();
    const snapshot = new URL(replay);
    snapshot.pathname = snapshot.pathname.replace(/replay$/, "snapshot");
    this.#snapshotUrl = snapshot.toString();
    this.#roomId = roomIn(String(url));

    this.#room = new RoomClient<LockstepView<Input>, unknown>(url, {
      onStatus: (status, detail) => {
        if (status !== "open") {
          this.#ready = false;
          this.#pacer?.clear();
          this.#asking = false;
          this.#scheduleAsk();
        }
        if (status === "open") this.#needsSync = true;
        options.onStatus?.(status, detail);
      },
      token: options.token,
      ...(options.binary ? { binary: true } : {}),
      onState: (view) => this.#receive(view),
      onMessage: (message) => this.#turns(message),
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
    this.#scheduleAsk();
  }

  #receive(view: LockstepView<Input>): void {
    if (view.desync && !this.#desyncReported) {
      this.#desyncReported = true;
      this.#options.onDesync?.(view.desync.turn, view.desync);
      void this.#explain(view.desync);
    }
    if (view.desync?.differs && !this.#desyncExplained) {
      this.#desyncExplained = true;
      this.#saved.clear();
      this.#options.onDesyncExplained?.(view.desync);
    }
    this.#snapshotEvery = view.snapshotEvery ?? 0;
    if (this.#needsSync) {
      this.#needsSync = false;
      this.#buffer.clear();
      void this.#catchUp();
    }
    if (view.clock === "players") {
      // This room's turns arrive as messages, when someone has asked for them: see `#turns`.
      if (!this.#clocked) {
        this.#clocked = true;
        this.#turnsAt = Date.now();
      }
      this.#scheduleAsk();
      return;
    }
    this.#take(view.turn, 1, view.entries);
  }

  /** Turns `first` to `first + count - 1` have arrived. All are empty but the last, which has `entries`. */
  #take(first: number, count: number, entries: TurnEntry<Input>[]): void {
    const last = first + count - 1;
    const of = (turn: number) => (turn === last ? entries : []);
    if (!this.#ready) {
      for (let turn = first; turn <= last; turn++) this.#buffer.set(turn, of(turn));
    } else if (first > this.#received + 1) {
      // A turn went missing. Start over from the recording.
      this.#ready = false;
      this.#pacer?.clear();
      this.#buffer.clear();
      void this.#catchUp();
    } else {
      for (let turn = this.#received + 1; turn <= last; turn++) {
        this.#received = turn;
        this.#pacer?.push({ turn, entries: of(turn) });
      }
    }
  }

  /** A room that sleeps between turns has closed some. */
  #turns(message: unknown): void {
    const turns = message as Partial<TurnsMessage<Input>> | null;
    if (turns?.tickflare !== "turns" || !Number.isSafeInteger(turns.n) || !Number.isSafeInteger(turns.c)) return;
    this.#turnsAt = Date.now();
    // Whoever's request closed them keeps asking. Turns closed for another reason change nothing.
    if (turns.b !== undefined) this.#asking = turns.b === this.#room.you;
    this.#scheduleAsk();
    this.#take(turns.n!, turns.c!, turns.e ?? []);
  }

  /**
   * Arms the next request for turns. The client that is asking does so once
   * a turn, on its own clock. The others wait for turns to stop arriving,
   * each a little longer than the one before it, so that one takes over.
   */
  #scheduleAsk(): void {
    if (this.#askTimer !== undefined) clearTimeout(this.#askTimer);
    this.#askTimer = undefined;
    if (!this.#clocked || this.#room.status !== "open") return;
    const turnMs = 1000 / (this.#room.tickRate || 10);
    if (this.#asking) {
      this.#askAt = this.#askedAt + turnMs;
    } else {
      const connected = this.#room.players.filter((player) => player.connected).map((player) => player.id).sort();
      const place = Math.max(0, connected.indexOf(this.#room.you ?? ""));
      this.#askAt = Math.max(this.#turnsAt, this.#askedAt) + turnMs * (1.5 + 0.4 * place);
    }
    this.#askTimer = setTimeout(() => {
      // From when it was due, not from when the timer got round to it: lateness must not add up.
      this.#askedAt = Math.max(this.#askAt, Date.now() - turnMs);
      this.#room.send({ k: "t" }).catch(() => {});
      this.#scheduleAsk();
    }, Math.max(0, this.#askAt - Date.now()));
  }

  async #catchUp(): Promise<void> {
    const id = ++this.#syncId;
    const { token, load } = this.#options;
    const hash = this.#hash;
    // What the room is told: the turn this simulation is at and the run of the room it got there
    // in, and whether a snapshot would be of use.
    const mine = this.#sim !== undefined && this.#epoch !== undefined ? this.#turn : 0;
    const asked = new URL(this.#replayUrl);
    asked.searchParams.set("since", String(mine));
    if (mine > 0) asked.searchParams.set("epoch", this.#epoch!);
    if (load && hash) asked.searchParams.set("snapshot", String(this.#distrusted));
    let answer: CatchUp<Input>;
    try {
      const url = token ? await withFreshToken(asked.toString(), this.#roomId, token) : asked.toString();
      answer = await (this.#options.loadReplay ?? loadReplay)(url);
    } catch (err) {
      console.warn("[tickflare] could not load the recording; retrying on the next turn", err);
      if (id === this.#syncId) this.#needsSync = true;
      return;
    }
    if (id !== this.#syncId) return;

    let sim: Sim;
    let from = 0;
    if (answer.snapshot && load && hash) {
      // Somebody else's simulation. It is taken only if it hashes to what the players agreed on.
      let loaded: Sim | undefined;
      try {
        const candidate = load(JSON.parse(answer.snapshot.data));
        if (hash(candidate) === answer.snapshot.hash) loaded = candidate;
      } catch {
        // Not something `load` can read: the same as a wrong hash.
      }
      if (loaded === undefined) {
        console.warn(`[tickflare] the snapshot of turn ${answer.snapshot.turn} did not load into what its hash says; catching up without it`);
        const again = answer.snapshot.turn <= this.#distrusted;
        this.#distrusted = Math.max(this.#distrusted, answer.snapshot.turn);
        // Sent the one it said it had no use for: asking again at once would only repeat that.
        if (again) this.#needsSync = true;
        else await this.#catchUp();
        return;
      }
      sim = loaded;
      from = answer.snapshot.turn;
    } else if (answer.from !== undefined && answer.from > 0) {
      if (answer.from !== mine) {
        // The end of a recording, and nothing it continues from. Ask for all of it.
        this.#epoch = undefined;
        if (mine === 0) this.#needsSync = true;
        else await this.#catchUp();
        return;
      }
      sim = this.#sim as Sim;
      from = mine;
    } else {
      sim = this.#options.create(answer.seed);
    }
    stepThrough(sim, answer, this.#options, from);
    this.#sim = sim;
    this.#epoch = answer.epoch;
    this.#turn = Math.max(answer.turn, from);
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
    const { hashEvery = 20, save, load } = this.#options;
    const hash = this.#hash;
    // A turn a snapshot can be of is one every client reports, so that the room can tell whether
    // the players agree on what the snapshot holds.
    const snapshot = this.#snapshotEvery > 0 && turn % this.#snapshotEvery === 0;
    // Only live turns are reported: hashes of old turns have nobody left to be compared with.
    if (live && hash && (snapshot || turn % hashEvery === 0)) {
      const sends = snapshot && save !== undefined && load !== undefined && this.#sendsSnapshots();
      // Saved for a snapshot, to be fingerprinted, or to say later where it differed from another's.
      const keeps = save !== undefined && !this.#desyncReported && (!this.#options.hash || this.#options.explainDesyncs === true);
      const data = save !== undefined && (sends || keeps) ? JSON.stringify(save(sim)) : undefined;
      // With no hash of the game's own, the text at hand is the text to fingerprint.
      const reported = data !== undefined && !this.#options.hash ? fingerprintOfText(data) : hash(sim);
      if (data !== undefined && keeps) {
        this.#saved.set(turn, data);
        // The room finds two hashes differ within a round trip of the second: the last two turns cover it.
        for (const old of this.#saved.keys()) if (this.#saved.size > SAVES_KEPT) this.#saved.delete(old);
      }
      this.#room.send({ k: "h", n: turn, h: reported }).catch(() => {});
      if (data !== undefined && sends) void this.#sendSnapshot(data, turn, reported);
    }
    if (live) this.#options.onTurn?.(sim, turn);
  }

  /**
   * Two simulations differed, and this is one of them: sends the room what
   * this one had saved at that turn, if it still has it, so that the room
   * can say where the two differ.
   */
  async #explain(desync: Desync): Promise<void> {
    const data = this.#saved.get(desync.turn);
    this.#saved.clear();
    if (data === undefined || desync.differs !== undefined || !desync.players?.includes(this.#room.you ?? "")) return;
    try {
      const to = new URL(this.#snapshotUrl);
      to.pathname = to.pathname.replace(/snapshot$/, "desync");
      to.searchParams.set("turn", String(desync.turn));
      const { token } = this.#options;
      const url = token ? await withFreshToken(to.toString(), this.#roomId, token) : to.toString();
      await (this.#options.sendSnapshot ?? sendSnapshot)(url, data);
    } catch (err) {
      console.warn("[tickflare] could not send the room what this simulation had when it differed from another", err);
    }
  }

  /** One client sends the snapshots: that of the connected player whose id sorts first. */
  #sendsSnapshots(): boolean {
    const connected = this.#room.players.filter((player) => player.connected).map((player) => player.id).sort();
    return connected[0] === this.#room.you;
  }

  /** Sends the room this simulation as it stood after `turn`. The room may have no use for it: that is not an error. */
  async #sendSnapshot(data: string, turn: number, hash: string): Promise<void> {
    try {
      const to = new URL(this.#snapshotUrl);
      to.searchParams.set("turn", String(turn));
      to.searchParams.set("hash", hash);
      const { token } = this.#options;
      const url = token ? await withFreshToken(to.toString(), this.#roomId, token) : to.toString();
      await (this.#options.sendSnapshot ?? sendSnapshot)(url, data);
    } catch (err) {
      console.warn("[tickflare] could not send a snapshot; the next one is tried as usual", err);
    }
  }
}

async function loadReplay<Input>(url: string): Promise<CatchUp<Input>> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Replay request failed with ${response.status}`);
  return (await response.json()) as CatchUp<Input>;
}

async function sendSnapshot(url: string, data: string): Promise<void> {
  // Sent as plain text, so that a page on another origin needs no preflight for it.
  await fetch(url, { method: "POST", body: data });
}
