import type { LockstepView, Replay, TurnEntry, TurnsMessage } from "../lockstep.js";
import type { Player } from "../protocol.js";
import { Room, reject } from "./room.js";

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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Here, not in a hook: a hook that fails takes back everything it wrote, tables included.
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS tickflare_turns (n INTEGER PRIMARY KEY, entries TEXT NOT NULL)");
  }

  /**
   * Turn an untrusted client payload into an input. Every client will feed
   * what this returns to its simulation, so reject anything malformed here.
   */
  protected abstract parseInput(raw: unknown): Input;

  /** Two players reported different hashes for `turn`: their simulations have diverged. */
  protected onDesync(_turn: number): void {}

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
    const last = this.#turns()
      .exec<{ n: number; entries: string }>("SELECT n, entries FROM tickflare_turns ORDER BY n DESC LIMIT 1")
      .toArray()[0];
    if (last && last.n > this.state.turn) {
      this.state.turn = last.n; // Never reuse a number.
      this.state.entries = JSON.parse(last.entries) as TurnEntry<Input>[];
      this.state.pending = [];
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
    if (command.n > turn || command.n <= turn - HASHES_KEPT) return;
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
      this.state.desync = { turn: command.n };
      this.onDesync(command.n);
    }
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
    if (this.turnClock !== "players") return { seed, turn, entries, desync };
    // Before anything has woken this instance up, the checkpoint is all it knows.
    const latest = Math.max(turn, this.#turn);
    return { seed, turn: latest, entries: latest === this.#turn ? this.#entries : [], desync, clock: "players" };
  }

  protected override onHttp(request: Request): Response {
    if (request.method !== "GET" || !new URL(request.url).pathname.endsWith("/replay")) {
      return new Response("Not found", { status: 404 });
    }
    return Response.json(this.replay());
  }

  /** Announces the end of the match and, if `matchBucket` is set, stores the recording as its replay. */
  protected override finishMatch(result: Record<string, unknown> = {}): void {
    super.finishMatch(result, this.replay());
  }

  /** The recording so far. */
  protected replay(): Replay<Input> {
    const turns = this.#turns()
      .exec<{ n: number; entries: string }>("SELECT n, entries FROM tickflare_turns ORDER BY n")
      .toArray()
      .map((row): [number, TurnEntry<Input>[]] => [row.n, JSON.parse(row.entries) as TurnEntry<Input>[]]);
    const last = turns[turns.length - 1]?.[0] ?? 0;
    return {
      v: 2,
      seed: this.state.seed,
      turnRate: this.tickRate,
      turn: Math.max(this.state.turn, this.#turn, last),
      turns,
    };
  }

  #turns(): SqlStorage {
    return this.ctx.storage.sql;
  }
}
