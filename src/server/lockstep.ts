import type { LockstepView, Replay, TurnEntry } from "../lockstep.js";
import type { Player } from "../protocol.js";
import { Room, reject } from "./room.js";

interface LockstepState<Input> extends LockstepView<Input> {
  /** Inputs and events waiting for the next turn. Not sent to clients. */
  pending: TurnEntry<Input>[];
}

type LockstepCommand<Input> =
  | { k: "i"; d: Input }
  /** A client's hash of its simulation after turn `n`. */
  | { k: "h"; n: number; h: string };

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
 * If you override `onJoin`, `onLeave`, `onDisconnect` or `onReconnect`, call
 * `super` so the event still reaches the turn stream.
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

  #tableReady = false;
  #caughtUp = false;
  /** First hash reported for each recent turn. */
  #hashes = new Map<number, string>();

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

  protected onCommand(player: Player, command: LockstepCommand<Input>): void {
    if (command.k === "i") {
      const waiting = this.state.pending.filter((entry) => entry.p === player.id && entry.i !== undefined);
      if (waiting.length >= this.maxInputsPerTurn) reject("too_many_inputs");
      this.state.pending.push({ p: player.id, i: command.d });
      return;
    }

    const first = this.#hashes.get(command.n);
    if (first === undefined) {
      this.#hashes.set(command.n, command.h);
      if (this.#hashes.size > HASHES_KEPT) {
        this.#hashes.delete(this.#hashes.keys().next().value!);
      }
    } else if (first !== command.h && !this.state.desync) {
      this.state.desync = { turn: command.n };
      this.onDesync(command.n);
    }
  }

  protected override onJoin(player: Player): void {
    this.state.pending.push({ p: player.id, e: "join" });
  }

  protected override onLeave(player: Player): void {
    this.state.pending.push({ p: player.id, e: "leave" });
  }

  protected override onDisconnect(player: Player): void {
    this.state.pending.push({ p: player.id, e: "disconnect" });
  }

  protected override onReconnect(player: Player): void {
    this.state.pending.push({ p: player.id, e: "reconnect" });
  }

  /** Closes the turn: whatever arrived since the last one becomes this turn's entries. */
  protected override onTick(): void {
    const state = this.state;
    if (!this.#caughtUp) {
      // After a crash the saved turn counter can be behind the recording. Never reuse a number.
      const last = this.#turns().exec<{ n: number | null }>("SELECT MAX(n) AS n FROM tickflare_turns").one().n;
      if (last !== null && last > state.turn) state.turn = last;
      this.#caughtUp = true;
    }
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
      v: 1,
      seed: this.state.seed,
      turnRate: this.tickRate,
      turn: Math.max(this.state.turn, last),
      turns,
    };
  }

  #turns(): SqlStorage {
    const sql = this.ctx.storage.sql;
    if (!this.#tableReady) {
      sql.exec("CREATE TABLE IF NOT EXISTS tickflare_turns (n INTEGER PRIMARY KEY, entries TEXT NOT NULL)");
      this.#tableReady = true;
    }
    return sql;
  }
}
