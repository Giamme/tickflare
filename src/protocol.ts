/**
 * Wire protocol shared by the room kernel and the client.
 *
 * Every frame is a JSON text frame, except the keepalive: the client sends the
 * literal string "ping" and the runtime answers "pong" without waking the room.
 */

import type { Patch } from "./patch.js";

export const PROTOCOL_VERSION = 1;

export const PING = "ping";
export const PONG = "pong";

/** A seat in a room. A player keeps their seat while disconnected. */
export interface Player {
  id: string;
  connected: boolean;
  /**
   * The player's name, when the gateway's `authenticate` gave one (signed-in
   * players with `Accounts` have one). Only set in the hooks that run for a
   * connecting request: `onJoin`, `onReconnect`, `onArrive` and `onHttp`.
   * Keep it in your state if you need it later.
   */
  name?: string;
}

/** `id` is chosen by the client and echoed back in the matching `ack` or `reject`. */
export type ClientMessage<Command = unknown> =
  | { t: "cmd"; id: number; data: Command }
  /** Give up the seat. On `ack` the room closes the connection with `CloseCode.Removed`. */
  | { t: "leave"; id: number };

export type ServerMessage<View = unknown> =
  /**
   * First frame on every connection, including reconnects. `tickRate` is 0 in
   * event mode, otherwise the simulation rate in ticks per second.
   */
  | {
      t: "welcome";
      v: number;
      you: string;
      seq: number;
      tick: number;
      tickRate: number;
      state: View;
      players: Player[];
    }
  /** The state changed. `seq` increases by one per change. `tick` is set while the room is ticking. */
  | { t: "state"; seq: number; tick?: number; state: View }
  /** The state changed while the room is ticking: only the difference from what this player last received. */
  | { t: "patch"; seq: number; tick: number; p: Patch }
  /** Someone joined, dropped or came back. */
  | { t: "presence"; players: Player[] }
  /** The command or leave was applied. Sent after the `state` frame it caused. */
  | { t: "ack"; id: number; seq: number }
  /** The command or leave was refused and the state is unchanged. */
  | { t: "reject"; id: number; reason: string }
  /** The frame could not be understood at all. */
  | { t: "error"; reason: string }
  /** A message the room sent this player with `send` or `broadcast`. */
  | { t: "msg"; d: unknown };

/** WebSocket close codes the room uses. The client does not reconnect after these. */
export const CloseCode = {
  /** The same player opened a newer connection. */
  Replaced: 4000,
  /** Every seat is taken. */
  RoomFull: 4001,
  /** `onJoin` refused the player; the close reason carries why. */
  JoinRejected: 4002,
  /** The player no longer has a seat: they left, or the room removed them. The close reason says which. */
  Removed: 4003,
  /**
   * The room handed the player over to another room; the close reason is that
   * room's id. The client reconnects there by itself.
   */
  Moved: 4004,
} as const;

/** Sent by a matchmaker to every player of a match it has just put together. */
export interface MatchFound {
  t: "match";
  /** The room to connect to. Only these players can take a seat in it. */
  room: string;
  players: string[];
}

/** What a room puts on its queue when it calls `finishMatch`. */
export interface MatchResult {
  /** Unique per finished match. Safe to use as a primary key: redeliveries carry the same id. */
  id: string;
  /** The room id, if the room knows it (it does when players came through the gateway). */
  room: string | null;
  /** Epoch milliseconds. */
  endedAt: number;
  /** Everyone who held a seat when the match ended. */
  players: string[];
  /** Whatever the room passed to `finishMatch`. */
  result: Record<string, unknown>;
  /** Where the replay was stored in the room's R2 bucket, if it stored one. */
  replayKey?: string;
}

export function isFatalCloseCode(code: number): boolean {
  return code >= 4000 && code < 4100;
}
