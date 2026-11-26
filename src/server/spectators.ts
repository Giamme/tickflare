import { applyPatch, type Patch } from "../patch.js";
import type { Player } from "../protocol.js";
import { DeltaSender } from "./delta.js";

/** Marks the socket of a spectator. With no tag that is a player's id, the room takes it for nobody's. */
export const SPECTATOR_TAG = "\u0001spectator";
/** Starts the tag that says who a spectator is. */
export const SPECTATOR_ID_TAG = "\u0001s=";

/** A view the spectators have been sent, and what it is of. */
export interface Shown {
  seq: number;
  tick: number;
  /** A copy nothing else changes. */
  view: unknown;
}

/** A frame on its way to the spectators. */
interface Queued {
  /** When it is let out, in epoch milliseconds. */
  at: number;
  frame: string;
  /** It brings a view, whole or as a patch: what the spectators hold changes with it. */
  view?: true;
  /** For a frame that says who is here: who that is. */
  players?: Player[];
}

/**
 * How long the line goes on with nobody watching. A spectator whose
 * connection dropped and who is back within this finds the line where it
 * was, and misses only what was let out while they were away.
 */
export const LINGER_MS = 20_000;

/**
 * The most that may be waiting to be let out, in characters of frames. A
 * line that holds more than this has a delay too long for how fast its room
 * changes: it starts over, so that the room does not run out of memory.
 */
const MAX_QUEUED_CHARS = 16_000_000;

/**
 * What a room's spectators are sent, and when: everything, the same for all
 * of them, and `delayMs` after the players were sent it.
 *
 * Each time the room sends its players something, the line takes the
 * spectators' view of that moment, works out the patch from the view it took
 * before, and queues the frame. A timer lets the frames out in order when
 * their time has come, to every spectator connected then. Who is here and
 * what the room broadcasts go through the same queue, so that nothing
 * reaches a spectator sooner than the view it belongs with.
 *
 * Since all spectators are sent the same frames, the line also knows what
 * every one of them holds: the latest view it let out, which is what one who
 * connects is welcomed with. When the line starts there is no such view yet.
 * Its first frame is a whole view, and a spectator welcomed before that has
 * come due is told to wait for it.
 *
 * What waits is kept as the text that will be sent, and nothing else: with a
 * long delay there is a lot of it. The view the spectators hold is worked
 * out from the frames as they are let out.
 *
 * The line runs while someone watches and for `LINGER_MS` after. All of it
 * is in memory: a room that restarts starts the line again, with a whole
 * view for whoever is still connected.
 */
export class SpectatorLine {
  readonly #watching: () => WebSocket[];
  #sender = new DeltaSender();
  /** What `#sender` last sent. It sends to `#tape`, which keeps the frame instead. */
  #caught: string | undefined;
  readonly #tape = {
    send: (frame: string) => {
      this.#caught = frame;
    },
  } as unknown as WebSocket;
  #queue: Queued[] = [];
  #queuedChars = 0;
  #shown: Shown | undefined;
  #players: Player[] | undefined;
  #running = false;
  #idleSince: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  /** @param watching the open sockets of the spectators, asked for whenever something is let out */
  constructor(watching: () => WebSocket[]) {
    this.#watching = watching;
  }

  /** Whether views are being taken. */
  get running(): boolean {
    return this.#running;
  }

  /** The latest view let out, which is what every spectator holds. Undefined until the first has been. */
  get shown(): Shown | undefined {
    return this.#shown;
  }

  /** Who the spectators have been told is here. Undefined until they have been. */
  get players(): Player[] | undefined {
    return this.#players;
  }

  /**
   * Whether the line goes on, now that someone is watching or nobody is: it
   * stops once nobody has for `LINGER_MS`.
   */
  keep(watched: boolean, now = Date.now()): boolean {
    if (watched) {
      this.#idleSince = undefined;
      return true;
    }
    this.#idleSince ??= now;
    if (now - this.#idleSince < LINGER_MS) return true;
    this.stop();
    return false;
  }

  /**
   * Takes the spectators' view as it is now, to be let out in `delayMs`.
   * The first one taken starts the line and goes out whole, the others as
   * what changed. `view` may be the room's own objects: what is kept is a
   * copy.
   */
  take(view: unknown, seq: number, tick: number, delayMs: number, now = Date.now()): void {
    this.#running = true;
    this.#caught = undefined;
    this.#sender.send([{ ws: this.#tape, id: "spectators", arrays: true }], seq, tick, undefined, () => view);
    const frame = this.#caught as string | undefined;
    this.#caught = undefined;
    // Nothing a spectator sees has changed.
    if (frame === undefined) return;
    this.#push({ at: now + delayMs, frame, view: true }, now);
  }

  /** Queues who is here, as the whole list. */
  tell(players: Player[], delayMs: number, now = Date.now()): void {
    this.#push({ at: now + delayMs, frame: JSON.stringify({ t: "presence", players }), players }, now);
  }

  /** Queues a frame as it is: a message the room broadcast. */
  say(frame: string, delayMs: number, now = Date.now()): void {
    this.#push({ at: now + delayMs, frame }, now);
  }

  /** Forgets everything. The next view taken starts a new line. */
  stop(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#queue = [];
    this.#queuedChars = 0;
    this.#shown = undefined;
    this.#players = undefined;
    this.#running = false;
    this.#idleSince = undefined;
    this.#sender.reset();
  }

  #push(entry: Queued, now: number): void {
    const last = this.#queue[this.#queue.length - 1];
    // In the order they were queued in, whatever the delay has been changed to since.
    if (last && entry.at < last.at) entry.at = last.at;
    this.#queue.push(entry);
    this.#queuedChars += entry.frame.length;
    if (this.#queuedChars > MAX_QUEUED_CHARS) {
      console.error(
        `[tickflare] more than ${MAX_QUEUED_CHARS} characters are waiting to be sent to spectators; their view starts over. The delay is too long for how fast this room's state changes.`,
      );
      this.stop();
      return;
    }
    this.release(now);
  }

  /** A frame that brings a view is let out: the spectators hold what it leaves them with. */
  #hold(frame: string): void {
    const sent = JSON.parse(frame) as
      | { t: "state"; seq: number; tick: number; state: unknown }
      | { t: "patch"; seq: number; tick: number; p: Patch };
    if (sent.t === "state") {
      this.#shown = { seq: sent.seq, tick: sent.tick, view: sent.state };
    } else if (this.#shown) {
      this.#shown = { seq: sent.seq, tick: sent.tick, view: applyPatch(this.#shown.view, sent.p) };
    }
  }

  /** Lets out what has come due by `now`, and sets the timer for what has not. */
  release(now = Date.now()): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    let sockets: WebSocket[] | undefined;
    while (this.#queue.length > 0 && this.#queue[0]!.at <= now) {
      const entry = this.#queue.shift()!;
      this.#queuedChars -= entry.frame.length;
      if (entry.view) this.#hold(entry.frame);
      if (entry.players) this.#players = entry.players;
      for (const ws of (sockets ??= this.#watching())) {
        try {
          ws.send(entry.frame);
        } catch {
          // Socket is closing.
        }
      }
    }
    const next = this.#queue[0];
    if (!next) return;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        try {
          this.release();
        } catch (err) {
          console.error("[tickflare] could not send to the spectators:", err);
        }
      },
      Math.max(0, next.at - Date.now()),
    );
  }
}
