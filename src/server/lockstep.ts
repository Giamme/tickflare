import type { LockstepView, Replay, TurnEntry } from "../lockstep.js";
import type { Player } from "../protocol.js";
import { Room, reject } from "./room.js";

/** What a lockstep room keeps: what clients see, and the inputs waiting for the next turn. */
export interface LockstepState<Input> extends LockstepView<Input> {
  /** Inputs and events waiting for the next turn. Not sent to clients. */
  pending: TurnEntry<Input>[];
}

/** What a `LockstepClient` sends: an input (`i`), or its simulation's hash after turn `n` (`h`). */
export type LockstepCommand<Input> =
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
 * A lockstep room. It never runs the game: it validates inputs, orders them
 * into turns at `tickRate` turns a second, records every turn in which
 * something happened, and sends all players the same stream. Players coming
 * and going are part of that stream, so every simulation sees them at the
 * same turn.
 *
 * The recording is served at `{prefix}/{roomId}/replay`. Clients read it when
 * they (re)connect, to catch up, and it doubles as the match replay.
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

  #resumed = false;
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
  }

  protected onCommand(player: Player, command: LockstepCommand<Input>): void {
    this.#resume();
    if (command.k === "i") {
      const waiting = this.state.pending.filter((entry) => entry.player === player.id && entry.input !== undefined);
      if (waiting.length >= this.maxInputsPerTurn) reject("too_many_inputs");
      this.state.pending.push({ player: player.id, input: command.d });
      return;
    }

    // Only turns that have happened, and recently enough to still be compared.
    const turn = this.state.turn;
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
    this.#resume();
    this.state.pending.push({ player: player.id, event: "join" });
  }

  /** Every way of losing a seat ends here, so every simulation hears about it. */
  protected override removePlayer(playerId: string, reason?: string): void {
    if (this.players.some((player) => player.id === playerId)) {
      this.#resume();
      this.state.pending.push({ player: playerId, event: "leave" });
    }
    super.removePlayer(playerId, reason);
  }

  protected override onDisconnect(player: Player): void {
    this.#resume();
    this.state.pending.push({ player: player.id, event: "disconnect" });
  }

  protected override onReconnect(player: Player): void {
    this.#resume();
    this.state.pending.push({ player: player.id, event: "reconnect" });
  }

  /**
   * Closes the turn: whatever arrived since the last one becomes this turn's
   * entries. A turn with something in it is one row in the recording, written
   * before any player is sent it; `#resume` is what lets the room itself be
   * saved on its usual schedule instead of with every turn.
   */
  protected override onTick(): void {
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
    return { seed, turn, entries, desync };
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
      turn: Math.max(this.state.turn, last),
      turns,
    };
  }

  #turns(): SqlStorage {
    return this.ctx.storage.sql;
  }
}
