import { differences, type CatchUp, type Desync, type DesyncDifference, type LockstepView, type Replay, type Snapshot, type TurnEntry, type TurnsMessage } from "../lockstep.js";
import type { Player } from "../protocol.js";
import { Room, patchEachTick, reject } from "./room.js";
import { pieces } from "./storage.js";

/** What a lockstep room keeps: what clients see, and the inputs waiting for the next turn. */
export interface LockstepState<Input> extends LockstepView<Input> {
  /** Inputs and events waiting for the next turn. Not sent to clients. */
  pending: TurnEntry<Input>[];
}

/**
 * What a `LockstepClient` sends: an input (`i`), its simulation's hash after
 * turn `n` (`h`), or, to a room whose `turnClock` is `"players"`, a request
 * to close the turns that are due (`t`).
 */
export type LockstepCommand<Input> =
  | {
      /** A request to close the turns that are due. */
      k: "t";
    }
  | {
      /** An input. */
      k: "i";
      /** The input, before `parseInput`. */
      d: Input;
    }
  | {
      /** A hash of the client's simulation. */
      k: "h";
      /** The turn the simulation was at. */
      n: number;
      /** The hash. */
      h: string;
    };

/** How many turns' worth of reported hashes are kept for comparison. */
const HASHES_KEPT = 128;

/** How many snapshot turns' hashes are kept, for a snapshot that takes a while to arrive. */
const SNAPSHOT_TURNS_KEPT = 4;

/**
 * With players asking for the turns: the most one request may close. If
 * nobody asked for longer than this many turns, the game stood still for the
 * rest of that time.
 */
const MOST_TURNS_AT_ONCE = 30;

/**
 * A lockstep room. It never runs the game: it validates inputs, orders them
 * into turns at `tickRate` turns a second, records every turn in which
 * something happened, and sends all players the same stream. Players coming
 * and going are part of that stream, so every simulation sees them at the
 * same turn.
 *
 * The recording is served at `{prefix}/{roomId}/replay`. Clients read it when
 * they (re)connect, to catch up, and it doubles as the match replay.
 *
 * By default the room closes the turns itself, on a timer, and so is awake
 * and billed for as long as the match lasts. Set `turnClock = "players"` and
 * it sleeps between turns instead: see `turnClock`.
 *
 * If you override `onJoin`, `onDisconnect` or `onReconnect`, call `super` so
 * the event still reaches the turn stream. A seat that is given up, whether
 * the player left, timed out or was removed with `removePlayer`, is
 * announced to the stream for you.
 */
export abstract class LockstepRoom<Input, Env = Cloudflare.Env> extends Room<
  LockstepState<Input>,
  LockstepCommand<Input>,
  Env
> {
  /** Turns per second. */
  protected override tickRate = 10;

  /** Inputs one player may send within a single turn. More are refused. */
  protected maxInputsPerTurn = 32;

  /**
   * Off in a lockstep room. A turn is recorded as it closes and the room is
   * saved less often, so after a restart the recording holds inputs that the
   * room's own save knows nothing of: one that was sent again would be
   * recorded twice. An input that was in flight when the connection dropped
   * is answered with `disconnected`, as it always was.
   */
  protected override rememberCommands = false;

  /**
   * Who keeps time.
   *
   * `"room"`: the room closes a turn every `1 / tickRate` seconds on a timer
   * of its own. It is awake for the whole match.
   *
   * `"players"`: the room has no timer. `LockstepClient` asks it for each
   * turn as it falls due, one player's client at a time, and the room closes
   * as many turns as its own clock says have passed, never more: a player
   * can neither speed the game up nor hold it back while anyone else is
   * connected. Between requests the room is asleep, which is most of the
   * time. Orders take effect as soon as they do with `"room"`. Two things
   * differ: the game stands still while nobody is connected to ask, and after
   * a restart it skips ahead by up to `saveIntervalMs` of empty turns instead
   * of going back by as much.
   */
  protected turnClock: "room" | "players" = "room";

  /**
   * How often the room takes a snapshot of the simulation from its players,
   * so that someone who joins, reloads or reconnects late starts from it and
   * not from turn 1. 0 keeps none.
   *
   * The room has no simulation of its own. A snapshot is what one player's
   * client saved, with `save`, at a turn every client agrees on, and it is
   * kept once the hash it came with is the one another connected player
   * reported for that turn; a player who is alone is taken at their word.
   * The client that loads it hashes the result again before trusting it.
   * Clients whose simulation has no `save`, `load` and `hash` send none and
   * load none, and catch up from the recording as before.
   *
   * Only the latest is kept. The recording is not shortened: it is still the
   * whole match.
   */
  protected snapshotIntervalMs = 60_000;

  /** The longest snapshot the room keeps, in characters of JSON. A longer one is refused. */
  protected maxSnapshotLength = 8_000_000;

  #resumed = false;
  // With players asking for the turns, none of this is in `state`: a change to the state is a
  // row written and a frame to everyone, and here turns change ten times a second.
  /** The latest turn. `state.turn` is a checkpoint of it, written every `saveIntervalMs`. */
  #turn = 0;
  /** What happened in the latest turn. */
  #entries: TurnEntry<Input>[] = [];
  /** Inputs and events waiting for the next turn. */
  #waiting: TurnEntry<Input>[] = [];
  /** A moment and the turn that was current then: what "due" is counted from. */
  #since: { at: number; turn: number } | undefined;
  /** Turns to pass over at the next close, so that no number a player may have seen is used again. */
  #skip = 0;
  /** The first hash reported for each recent turn, and who reported it. */
  #hashes = new Map<number, { hash: string; by: string }>();
  /** For the latest turns a snapshot could be of: the first hash reported, and everyone who reported that one. */
  #vouched = new Map<number, { hash: string; by: Set<string> }>();
  /** What the players of a desync have sent of their simulations at that turn, as JSON text, until both have. */
  #explanations = new Map<string, string>();
  /** A snapshot that has arrived and waits for the other players to report its hash, and who sent it. */
  #candidate: (Snapshot & { by: string }) | undefined;
  /** Names this run of the room: see `CatchUp.epoch`. */
  #epoch: string | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The view is one turn: when the room catches up on several, each still needs a frame of its own.
    patchEachTick(this);
  }

  /**
   * Turn an untrusted client payload into an input. Every client will feed
   * what this returns to its simulation, so reject anything malformed here.
   */
  protected abstract parseInput(raw: unknown): Input;

  /**
   * Two players reported different hashes for `turn`: their simulations have
   * diverged. `players` are the two. Where they differ is not known yet: see
   * `onDesyncExplained`.
   */
  protected onDesync(_turn: number, _players: [string, string]): void {}

  /**
   * Both players of a desync have sent what their simulations had saved at
   * that turn, and the room has compared the two: `desync.differs` says
   * where they differed. It is in the view too, so every client is told.
   * The place to log it. Not called when a client had nothing to send: a
   * simulation without `save`, or a player who was gone by then.
   */
  protected onDesyncExplained(_desync: Desync & { players: [string, string]; differs: DesyncDifference[] }): void {}

  protected initialState(): LockstepState<Input> {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    return { seed, turn: 0, entries: [], pending: [], desync: null };
  }

  protected parseCommand(raw: unknown): LockstepCommand<Input> {
    const frame = raw as { k?: unknown; d?: unknown; n?: unknown; h?: unknown } | null;
    if (frame?.k === "t") return { k: "t" };
    if (frame?.k === "i") return { k: "i", d: this.parseInput(frame.d) };
    if (
      frame?.k === "h" &&
      Number.isSafeInteger(frame.n) &&
      typeof frame.h === "string" &&
      frame.h.length <= 64
    ) {
      return { k: "h", n: frame.n as number, h: frame.h };
    }
    return reject("invalid_command");
  }

  /**
   * Squares the saved state with the recording, once, before this instance
   * adds anything to `pending`.
   *
   * A turn is written to the recording as it closes; the room itself is
   * saved less often. So after a restart the recording can be ahead of the
   * saved state. Whatever was waiting when that state was saved went into
   * the first turn that closed after it: if the recording has a later turn,
   * those entries are in it already, and are dropped here instead of being
   * recorded twice.
   */
  #resume(): void {
    if (this.#resumed) return;
    this.#resumed = true;
    const last = this.#recorded()
      ? this.ctx.storage.sql
          .exec<{ n: number; entries: string }>("SELECT n, entries FROM tickflare_turns ORDER BY n DESC LIMIT 1")
          .toArray()[0]
      : undefined;
    if (last && last.n > this.state.turn) {
      this.state.turn = last.n; // Never reuse a number.
      this.state.entries = JSON.parse(last.entries) as TurnEntry<Input>[];
      this.state.pending = [];
    }
    // A snapshot is of a turn that has happened. If the saved counter is behind it, every turn in
    // between was empty, or the recording would have it: carry on from the snapshot's.
    const kept = this.#kept();
    if (kept && kept.turn > this.state.turn) {
      this.state.turn = kept.turn;
      this.state.entries = [];
    }
    if (this.turnClock === "players") {
      this.#turn = this.state.turn;
      this.#entries = last?.n === this.#turn ? (JSON.parse(last.entries) as TurnEntry<Input>[]) : [];
      this.state.entries = [];
      // Turns closed since the checkpoint were only in memory, and players still connected have
      // seen them. There were fewer than a checkpoint's worth: pass over that many.
      if (this.#turn > 0) this.#skip = this.#checkpointEvery();
    }
  }

  /** With players asking for the turns: how many turns go by between checkpoints of the counter. */
  #checkpointEvery(): number {
    return Math.max(1, Math.round((this.saveIntervalMs * this.tickRate) / 1000));
  }

  /** Queues an input or an event for the next turn. */
  #add(entry: TurnEntry<Input>): void {
    this.#resume();
    if (this.turnClock === "players") this.#waiting.push(entry);
    else this.state.pending.push(entry);
  }

  /**
   * With players asking for the turns: closes the turns that are due by this
   * room's clock, and puts what was waiting into the last of them. `now`
   * closes one even if none is due, for something that must not wait in
   * memory: a player coming or going is recorded in the same breath as the
   * change of seats.
   */
  #close(now: boolean, by?: string): void {
    this.#resume();
    const time = Date.now();
    const turnMs = 1000 / this.tickRate;
    // The first request after a (re)start finds one turn due.
    this.#since ??= { at: time - turnMs, turn: this.#turn };
    // Half a turn early is on time: requests arrive a little before and a little after the beat.
    let count = Math.floor(this.#since.turn + (time - this.#since.at) / turnMs - this.#turn + 0.5);
    const stoodStill = count > MOST_TURNS_AT_ONCE;
    if (stoodStill) count = MOST_TURNS_AT_ONCE;
    if (count < 1) {
      if (!now) return;
      count = 1;
    }
    // Turns passed over after a restart are not turns the clock is owed back.
    count += this.#skip;
    this.#since.turn += this.#skip;
    this.#skip = 0;

    const first = this.#turn + 1;
    const last = this.#turn + count;
    const entries = this.#waiting;
    if (entries.length > 0) {
      this.#turns().exec("INSERT OR REPLACE INTO tickflare_turns (n, entries) VALUES (?, ?)", last, JSON.stringify(entries));
    }
    this.#waiting = [];
    this.#entries = entries;
    this.#turn = last;
    if (stoodStill) this.#since = { at: time, turn: last };
    if (last - this.state.turn >= this.#checkpointEvery()) this.state.turn = last;
    this.broadcast({ tickflare: "turns", n: first, c: count, e: entries, ...(by === undefined ? {} : { b: by }) } satisfies TurnsMessage<Input>);
  }

  /** The room keeps time only when it is asked to: with players asking, it has no simulation to wake for. */
  protected override shouldTick(): boolean {
    return this.turnClock === "room";
  }

  protected onCommand(player: Player, command: LockstepCommand<Input>): void {
    this.#resume();
    const clocked = this.turnClock === "players";
    if (command.k === "t") {
      // A room that keeps its own time has nothing to be asked for.
      if (clocked) this.#close(false, player.id);
      return;
    }
    if (command.k === "i") {
      const queue = clocked ? this.#waiting : this.state.pending;
      const waiting = queue.filter((entry) => entry.player === player.id && entry.input !== undefined);
      if (waiting.length >= this.maxInputsPerTurn) reject("too_many_inputs");
      this.#add({ player: player.id, input: command.d });
      return;
    }

    // Only turns that have happened, and recently enough to still be compared.
    const turn = clocked ? this.#turn : this.state.turn;
    if (command.n > turn) return;
    this.#vouch(player.id, command.n, command.h, turn);
    if (command.n <= turn - HASHES_KEPT) return;
    const first = this.#hashes.get(command.n);
    if (first === undefined) {
      this.#hashes.set(command.n, { hash: command.h, by: player.id });
      if (this.#hashes.size > HASHES_KEPT) {
        for (const n of this.#hashes.keys()) {
          if (n <= turn - HASHES_KEPT) this.#hashes.delete(n);
        }
      }
    } else if (first.by !== player.id && first.hash !== command.h && !this.state.desync) {
      // It takes two players to disagree: one changing their mind proves nothing.
      this.state.desync = { turn: command.n, players: [first.by, player.id] };
      this.#candidate = undefined; // Nobody can say which simulation a snapshot should be of.
      this.onDesync(command.n, [first.by, player.id]);
    }
  }

  /** Turns between snapshots, or 0 when the room keeps none. */
  #snapshotEvery(): number {
    const turns = (this.snapshotIntervalMs * this.tickRate) / 1000;
    return turns > 0 && Number.isFinite(turns) ? Math.max(1, Math.round(turns)) : 0;
  }

  /**
   * Notes that `playerId` reported `hash` for `turn`, if a snapshot could be
   * of that turn, and keeps the snapshot that was waiting for it.
   */
  #vouch(playerId: string, turn: number, hash: string, latest: number): void {
    const every = this.#snapshotEvery();
    if (every === 0 || turn <= 0 || turn % every !== 0 || turn <= latest - every * SNAPSHOT_TURNS_KEPT) return;
    let seen = this.#vouched.get(turn);
    if (seen === undefined) {
      seen = { hash, by: new Set() };
      this.#vouched.set(turn, seen);
      for (const n of this.#vouched.keys()) {
        if (n <= latest - every * SNAPSHOT_TURNS_KEPT) this.#vouched.delete(n);
      }
    }
    if (seen.hash === hash) seen.by.add(playerId);
    const candidate = this.#candidate;
    if (candidate?.turn === turn && this.#agreed(candidate, candidate.by)) {
      this.#candidate = undefined;
      this.#keep(candidate);
    }
  }

  /**
   * Whether a snapshot sent by `by` is one to keep: every other player who
   * is connected has reported the hash it came with. A player with the room
   * to themselves has nobody to be wrong about it.
   */
  #agreed(snapshot: Snapshot, by: string): boolean {
    const seen = this.#vouched.get(snapshot.turn);
    if (seen === undefined || seen.hash !== snapshot.hash) return false;
    const others = this.players.filter((player) => player.id !== by);
    if (others.length === 0) return true;
    const connected = others.filter((player) => player.connected);
    return connected.length > 0 && connected.every((player) => seen.by.has(player.id));
  }

  /** Stores a snapshot in place of the one before it. One row, or several for a long one. */
  #keep(snapshot: Snapshot): void {
    this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      sql.exec(
        "CREATE TABLE IF NOT EXISTS tickflare_snapshot (part INTEGER PRIMARY KEY, turn INTEGER NOT NULL, hash TEXT NOT NULL, data TEXT NOT NULL)",
      );
      const parts = pieces(snapshot.data);
      parts.forEach((piece, part) => {
        sql.exec(
          "INSERT OR REPLACE INTO tickflare_snapshot (part, turn, hash, data) VALUES (?, ?, ?, ?)",
          part,
          snapshot.turn,
          snapshot.hash,
          piece,
        );
      });
      sql.exec("DELETE FROM tickflare_snapshot WHERE part >= ?", parts.length);
    });
  }

  /** The turn and hash of the snapshot the room has, if it has one. */
  #kept(): { turn: number; hash: string } | undefined {
    const sql = this.ctx.storage.sql;
    if (sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tickflare_snapshot'").toArray().length === 0) {
      return undefined;
    }
    return sql.exec<{ turn: number; hash: string }>("SELECT turn, hash FROM tickflare_snapshot WHERE part = 0").toArray()[0];
  }

  /**
   * A player's client sends the simulation it saved at `turn`. Kept at once
   * if the other players have reported the same hash already, and held until
   * they do otherwise.
   */
  async #offered(request: Request, params: URLSearchParams, player: Player): Promise<Response> {
    const every = this.#snapshotEvery();
    if (every === 0) return new Response("Not found", { status: 404 });
    if (!this.players.some((seated) => seated.id === player.id && seated.connected)) {
      return new Response("Only a connected player can send a snapshot", { status: 403 });
    }
    const turn = Number(params.get("turn"));
    const hash = params.get("hash") ?? "";
    if (!Number.isSafeInteger(turn) || turn <= 0 || turn % every !== 0 || hash === "" || hash.length > 64) {
      return new Response("Not a snapshot turn, or no hash", { status: 400 });
    }
    // Checked before the body is read, so that one of no use costs nothing, and again after:
    // the room moves on while it waits.
    const useless = (): boolean => {
      const latest = Math.max(this.state.turn, this.#turn);
      const seen = this.#vouched.get(turn);
      return (
        !this.#resumed || // This run of the room has closed no turn yet: it cannot tell what has happened.
        this.state.desync !== null ||
        turn > latest ||
        turn <= latest - every * SNAPSHOT_TURNS_KEPT ||
        turn <= (this.#kept()?.turn ?? 0) ||
        (this.#candidate !== undefined && turn <= this.#candidate.turn) ||
        (seen !== undefined && seen.hash !== hash)
      );
    };
    if (useless()) return new Response("Not a snapshot this room can use", { status: 409 });
    // A character of JSON is at most three bytes on the wire.
    const data = await textUpTo(request, this.maxSnapshotLength * 3);
    if (data === undefined || data.length > this.maxSnapshotLength) return new Response("Snapshot too long", { status: 413 });
    if (data.length === 0) return new Response("Empty snapshot", { status: 400 });
    if (useless()) return new Response("Not a snapshot this room can use", { status: 409 });
    const latest = Math.max(this.state.turn, this.#turn);
    this.#candidate = { turn, hash, data, by: player.id };
    this.#vouch(player.id, turn, hash, latest);
    return this.#candidate === undefined
      ? new Response("Kept", { status: 201 })
      : new Response("Held until the other players report the same hash", { status: 202 });
  }

  /**
   * What a client that is catching up is sent. One that says which turn its
   * simulation is at, and got there in this run of the room, is sent the
   * turns after it; one that has fallen a snapshot or more behind, or has no
   * simulation, is sent the snapshot and the turns after that.
   */
  #catchUp(params: URLSearchParams): Replay<Input> | CatchUp<Input> {
    if (!params.has("since")) return this.replay();
    const epoch = (this.#epoch ??= crypto.randomUUID().slice(0, 8));
    const since = Number(params.get("since"));
    const latest = Math.max(this.state.turn, this.#turn);
    let from = params.get("epoch") === epoch && Number.isSafeInteger(since) && since > 0 && since <= latest ? since : 0;

    // `snapshot=N`: the client can load one, and has no use for any of turn N or before.
    const newerThan = params.has("snapshot") ? Number(params.get("snapshot")) : Number.POSITIVE_INFINITY;
    const kept = this.#kept();
    let snapshot: Snapshot | undefined;
    if (kept && kept.turn > newerThan && (from === 0 || kept.turn - from > this.#snapshotEvery())) {
      const data = this.ctx.storage.sql
        .exec<{ data: string }>("SELECT data FROM tickflare_snapshot ORDER BY part")
        .toArray()
        .map((row) => row.data)
        .join("");
      snapshot = { ...kept, data };
      from = kept.turn;
    }
    const recording = this.#recording(from);
    return {
      ...recording,
      // Before this run of the room has closed a turn, a snapshot can be ahead of the saved counter.
      turn: Math.max(recording.turn, from, kept?.turn ?? 0),
      epoch,
      ...(from > 0 ? { from } : {}),
      ...(snapshot ? { snapshot } : {}),
    };
  }

  protected override onJoin(player: Player): void {
    this.#event({ player: player.id, event: "join" });
  }

  /** A player came or went. With players asking for the turns, it is in a turn before this hook returns. */
  #event(entry: TurnEntry<Input>): void {
    this.#add(entry);
    if (this.turnClock === "players") this.#close(true);
  }

  /** Every way of losing a seat ends here, so every simulation hears about it. */
  protected override removePlayer(playerId: string, reason?: string): void {
    if (this.players.some((player) => player.id === playerId)) {
      this.#event({ player: playerId, event: "leave" });
    }
    super.removePlayer(playerId, reason);
  }

  protected override onDisconnect(player: Player): void {
    this.#event({ player: player.id, event: "disconnect" });
  }

  protected override onReconnect(player: Player): void {
    this.#event({ player: player.id, event: "reconnect" });
  }

  /**
   * One of the two players of a desync sends what their simulation had saved
   * at that turn. When both have, the room says where the two differ.
   */
  async #explain(request: Request, params: URLSearchParams, player: Player): Promise<Response> {
    const waiting = (): Desync | undefined => {
      const desync = this.state.desync;
      return desync?.players?.includes(player.id) && desync.differs === undefined && Number(params.get("turn")) === desync.turn
        ? desync
        : undefined;
    };
    // Checked before the body is read, and again after: the other player's may have settled it.
    if (!waiting()) return new Response("Nothing this room is waiting for", { status: 409 });
    const data = await textUpTo(request, this.maxSnapshotLength * 3);
    if (data === undefined || data.length > this.maxSnapshotLength) return new Response("Too long", { status: 413 });
    try {
      JSON.parse(data);
    } catch {
      return new Response("Not JSON", { status: 400 });
    }
    const desync = waiting();
    if (!desync) return new Response("Nothing this room is waiting for", { status: 409 });
    this.#explanations.set(player.id, data);
    const [one, other] = desync.players!.map((id) => this.#explanations.get(id));
    if (one === undefined || other === undefined) return new Response("Held until the other player's arrives", { status: 202 });
    this.#explanations.clear();
    const differs = differences(JSON.parse(one), JSON.parse(other));
    await this.act(() => {
      const explained = { ...desync, players: desync.players!, differs };
      this.state.desync = explained;
      this.onDesyncExplained(explained);
    });
    return new Response("Compared", { status: 201 });
  }

  /**
   * Closes the turn: whatever arrived since the last one becomes this turn's
   * entries. A turn with something in it is one row in the recording, written
   * before any player is sent it; `#resume` is what lets the room itself be
   * saved on its usual schedule instead of with every turn.
   */
  protected override onTick(): void {
    if (this.turnClock === "players") return; // Only if a subclass turned the timer back on.
    this.#resume();
    const state = this.state;
    state.turn += 1;
    state.entries = state.pending;
    state.pending = [];
    if (state.entries.length > 0) {
      this.#turns().exec(
        "INSERT OR REPLACE INTO tickflare_turns (n, entries) VALUES (?, ?)",
        state.turn,
        JSON.stringify(state.entries),
      );
    }
  }

  protected override view(): LockstepView<Input> {
    const { seed, turn, entries, desync } = this.state;
    const every = this.#snapshotEvery();
    const snapshots = every > 0 ? { snapshotEvery: every } : {};
    if (this.turnClock !== "players") return { seed, turn, entries, desync, ...snapshots };
    // Before anything has woken this instance up, the checkpoint is all it knows.
    const latest = Math.max(turn, this.#turn);
    return {
      seed,
      turn: latest,
      entries: latest === this.#turn ? this.#entries : [],
      desync,
      clock: "players",
      ...snapshots,
    };
  }

  /**
   * `GET …/replay` is the recording, or the end of it for a client that is
   * catching up. `POST …/snapshot` is a player's client sending a snapshot,
   * and `POST …/desync` one sending what it had saved at a turn two players
   * disagreed on.
   * If you override this, pass on what is not yours with `super.onHttp`.
   */
  protected override onHttp(request: Request, player: Player): Response | Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/replay")) {
      return Response.json(this.#catchUp(url.searchParams));
    }
    if (request.method === "POST" && url.pathname.endsWith("/snapshot")) {
      return this.#offered(request, url.searchParams, player);
    }
    if (request.method === "POST" && url.pathname.endsWith("/desync")) {
      return this.#explain(request, url.searchParams, player);
    }
    return new Response("Not found", { status: 404 });
  }

  /** Announces the end of the match and, if `matchBucket` is set, stores the recording as its replay. */
  protected override finishMatch(result: Record<string, unknown> = {}): void {
    super.finishMatch(result, this.replay());
  }

  /** The recording so far. */
  protected replay(): Replay<Input> {
    return this.#recording(0);
  }

  /** The recording so far, without the turns up to `after`. */
  #recording(after: number): Replay<Input> {
    const rows = this.#recorded()
      ? this.ctx.storage.sql
          .exec<{ n: number; entries: string }>("SELECT n, entries FROM tickflare_turns WHERE n > ? ORDER BY n", after)
          .toArray()
      : [];
    const turns = rows.map((row): [number, TurnEntry<Input>[]] => [row.n, JSON.parse(row.entries) as TurnEntry<Input>[]]);
    const last = turns[turns.length - 1]?.[0] ?? 0;
    return {
      v: 2,
      seed: this.state.seed,
      turnRate: this.tickRate,
      turn: Math.max(this.state.turn, this.#turn, last),
      turns,
    };
  }

  /**
   * The recording, to write to. The table is made with the first turn that
   * has something in it, not before: a room that has recorded nothing stores
   * nothing. Asked for each time, because a hook that fails takes back
   * everything it wrote, a new table included.
   */
  #turns(): SqlStorage {
    const sql = this.ctx.storage.sql;
    sql.exec("CREATE TABLE IF NOT EXISTS tickflare_turns (n INTEGER PRIMARY KEY, entries TEXT NOT NULL)");
    return sql;
  }

  /** Whether there is a recording to read. */
  #recorded(): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tickflare_turns'").toArray().length > 0;
  }
}

/** The request's body as text, or undefined if it is longer than `bytes`: no more than that is read. */
async function textUpTo(request: Request, bytes: number): Promise<string | undefined> {
  if (Number(request.headers.get("Content-Length") ?? 0) > bytes) return undefined;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > bytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
