import { produce } from "./draft.js";
import type { RoomClient } from "./index.js";

/** How a `Predictor` works out what the room will do with this player's commands. */
export interface PredictorOptions<View, Command> {
  /**
   * What one of this player's commands does to the state, written the way
   * the room's `onCommand` is: change `state` in place. It is given a draft
   * of the room's state, so the room's state itself is never touched, and
   * `you` is this player's id. If the room would refuse the command, change
   * nothing.
   */
  apply(state: View, command: Command, you: string): void;
  /**
   * What one tick does to what this player controls, written the way the
   * room's `onTick` is. Give it for a game in which a command sets something
   * in motion that the simulation then carries on with, such as a unit that
   * walks to where it was sent: the prediction then runs as far ahead of the
   * room's state as a command takes to come back, and the player's own unit
   * moves the moment they act. Leave the other players' units alone: where
   * they will be is not this player's to know.
   */
  tick?(state: View, you: string): void;
  /**
   * The room's state changed, or a command was sent, applied or refused.
   * With `tick` the prediction also moves on with time: read `state` when
   * you draw, rather than wait for this.
   */
  onState?(state: View): void;
  /** The clock, in milliseconds. Defaults to `Date.now`. */
  now?(): number;
}

/** How many of the latest frames' arrival times the room's clock is read from. */
const FRAMES_KEPT = 20;
/** A frame this much later than the earliest is taken for a room that started ticking again, not for a slow network. */
const RESTART_MS = 1000;
/** How many of the latest commands the lead is worked out from. */
const LEADS_KEPT = 7;

/**
 * Shows a player the effect of their own commands at once, instead of when
 * the room's answer arrives.
 *
 * `state` is the room's state with this player's unconfirmed commands
 * applied on top, by the `apply` you give. When the room's state arrives it
 * replaces the guess: commands the room has applied are part of it, commands
 * it refused are dropped, and those still on their way are applied again. So
 * a wrong guess lasts until the room's answer, and never longer.
 *
 *     const predicted = new Predictor(room, {
 *       apply(state, command, you) {
 *         if (command.type === "move") state.units[you].target = command.to;
 *       },
 *     });
 *     button.onclick = () => predicted.send({ type: "move", to });
 *     draw(predicted.state);
 *
 * Send through `predicted.send`, and draw from `predicted.state` where you
 * drew from `room.state`. Parts of the state the prediction did not change
 * are the same objects as in `room.state`.
 */
export class Predictor<View = unknown, Command = unknown> {
  readonly #room: RoomClient<View, Command>;
  readonly #options: PredictorOptions<View, Command>;
  readonly #stop: () => void;
  /** The tick each command of this predictor's was sent at, by the room's reckoning, by command id. */
  #sentAt = new Map<number, number>();
  /** For the latest frames: when each arrived, less the time its tick stands for. The least is the room's clock. */
  #arrivals: number[] = [];
  #lastTick = -1;
  /** How many ticks went by before each of the latest commands showed in the room's state. */
  #leads: number[] = [];
  #lead = 1;
  /** The state `onState` was last called with. */
  #told: View | undefined;
  /** The last prediction, and what it was made from. */
  #made: { base: View | undefined; pending: unknown; from: number; to: number; lead: number; state: View | undefined } | undefined;

  constructor(room: RoomClient<View, Command>, options: PredictorOptions<View, Command>) {
    this.#room = room;
    this.#options = options;
    this.#stop = room.on("state", () => {
      this.#hear();
      this.#changed();
    });
    if (room.state !== undefined) this.#hear();
  }

  /**
   * The room's state as it will be once the room has applied this player's
   * unconfirmed commands. Undefined until the room's first state arrives.
   */
  get state(): View | undefined {
    const room = this.#room;
    const base = room.state;
    const pending = room.unconfirmed;
    const { apply, tick } = this.#options;
    const you = room.you ?? "";
    const ticking = tick !== undefined && room.tickRate > 0 && base !== undefined;

    // With `tick`: the prediction is of the tick at which a command sent now would first show.
    let from = 0;
    let to = 0;
    if (ticking) {
      const now = this.#roomTick();
      // If frames have stopped coming, the state is taken to be a few ticks old at most: nothing
      // in this player's view changed in the ticks without a frame.
      from = Math.max(room.tick, now - this.#mostBehind());
      to = now + this.#lead;
    }

    const made = this.#made;
    if (made && made.base === base && made.pending === pending && made.from === from && made.to === to && made.lead === this.#lead) {
      return made.state;
    }
    let state = base;
    if (base !== undefined && (pending.length > 0 || to > from)) {
      state = produce(base, (draft) => {
        let next = 0;
        const applyDue = (before: number) => {
          while (next < pending.length && (this.#sentAt.get(pending[next]!.id) ?? 0) + this.#lead <= before) {
            this.#try(() => apply(draft, pending[next]!.command, you));
            next += 1;
          }
        };
        for (let at = from + 1; at <= to; at++) {
          applyDue(at);
          this.#try(() => tick!(draft, you));
        }
        applyDue(Number.POSITIVE_INFINITY);
      });
    }
    this.#made = { base, pending, from, to, lead: this.#lead, state };
    return state;
  }

  /**
   * With `tick`: how many ticks ahead of the room's state the prediction
   * runs, which is how long a command takes to show there. Measured from the
   * commands sent so far; 1 before the first has come back.
   */
  get lead(): number {
    return this.#lead;
  }

  /**
   * Send a command, and show its effect at once. Resolves and rejects as
   * `RoomClient.send` does. If the room refuses the command, its effect is
   * taken back.
   */
  send(command: Command): Promise<void> {
    const room = this.#room;
    const before = room.unconfirmed;
    const sent = room.send(command);
    // Not sent at all when there is no connection: then there is nothing to predict.
    const id = room.unconfirmed === before ? undefined : room.unconfirmed[room.unconfirmed.length - 1]!.id;
    const at = Math.max(room.tick, this.#roomTick());
    if (id !== undefined) this.#sentAt.set(id, at);
    const settle = (applied: boolean) => {
      if (id === undefined) return;
      this.#sentAt.delete(id);
      // The room's tick is now the one that first showed the command.
      if (applied && this.#options.tick && room.tickRate > 0) this.#learn(room.tick - at);
      this.#changed();
    };
    sent.then(
      () => settle(true),
      () => settle(false),
    );
    this.#changed();
    return sent;
  }

  /** Stop following the room. The room itself stays connected. */
  close(): void {
    this.#stop();
  }

  #changed(): void {
    const { onState } = this.#options;
    if (!onState) return;
    const state = this.state;
    if (state === undefined || state === this.#told) return;
    this.#told = state;
    onState(state);
  }

  #try(change: () => void): void {
    try {
      change();
    } catch (err) {
      // A prediction that fails is a prediction not made: the room's answer will show what happened.
      console.warn("[tickflare] a prediction threw, and was left out:", err);
    }
  }

  /** A frame arrived: note when, to tell what tick the room is at between frames. */
  #hear(): void {
    const room = this.#room;
    if (!this.#options.tick || room.tickRate <= 0 || room.tick === this.#lastTick) return;
    this.#lastTick = room.tick;
    const arrival = this.#now() - (room.tick * 1000) / room.tickRate;
    if (this.#arrivals.length > 0 && arrival - Math.min(...this.#arrivals) > RESTART_MS) this.#arrivals = [];
    this.#arrivals.push(arrival);
    if (this.#arrivals.length > FRAMES_KEPT) this.#arrivals.shift();
  }

  /**
   * The tick the room's latest frame would be of, were one to arrive now.
   * Frames are late by as much as the network holds them up, so the one that
   * was held up least says when ticks happen.
   */
  #roomTick(): number {
    const room = this.#room;
    if (this.#arrivals.length === 0 || room.tickRate <= 0) return room.tick;
    // A hair is added so that the frame the clock was read from is not put a tick early by rounding.
    const ticks = Math.floor(((this.#now() - Math.min(...this.#arrivals)) * room.tickRate) / 1000 + 1e-6);
    return Math.max(room.tick, ticks);
  }

  /** How many ticks without a frame are taken for a frame that is late, rather than for nothing having changed. */
  #mostBehind(): number {
    return Math.max(2, Math.ceil(this.#room.tickRate / 4));
  }

  /** A command took `ticks` ticks to show in the room's state. The lead is the middle of the latest few. */
  #learn(ticks: number): void {
    if (!Number.isFinite(ticks)) return;
    this.#leads.push(Math.max(1, Math.min(ticks, 2 * this.#room.tickRate)));
    if (this.#leads.length > LEADS_KEPT) this.#leads.shift();
    const sorted = [...this.#leads].sort((a, b) => a - b);
    this.#lead = sorted[Math.floor(sorted.length / 2)]!;
  }

  #now(): number {
    return this.#options.now ? this.#options.now() : Date.now();
  }
}
