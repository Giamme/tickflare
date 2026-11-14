/**
 * Wire protocol shared by the room kernel and the client.
 *
 * Every frame is a JSON text frame, except the keepalive: the client sends the
 * literal string "ping" and the runtime answers "pong" without waking the room.
 */

import type { Patch } from "./patch.js";

/** The protocol version a room announces in its `welcome` frame. */
export const PROTOCOL_VERSION = 1;

/** The keepalive a client sends, as a plain text frame. @internal */
export const PING = "ping";
/** The runtime's answer to `PING`, sent without waking the room. @internal */
export const PONG = "pong";

/** A seat in a room. A player keeps their seat while disconnected. */
export interface Player {
  /** The id the gateway's `authenticate` gave this player. */
  id: string;
  /** Whether the player has a connection open right now. */
  connected: boolean;
  /**
   * The player's name, when the gateway's `authenticate` gave one (signed-in
   * players with `Accounts` have one). Only set in the hooks that run for a
   * connecting request: `onJoin`, `onReconnect`, `onArrive` and `onHttp`.
   * Keep it in your state if you need it later.
   */
  name?: string;
}

/** A command for the room. Answered with `ack` or `reject` carrying the same `id`. */
export interface CommandFrame<Command = unknown> {
  /** Frame type. */
  t: "cmd";
  /** Chosen by the client, unique per connection, echoed in the answer. */
  id: number;
  /** The command, as the room's `parseCommand` will receive it. */
  data: Command;
}

/** Give up the seat. On `ack` the room closes the connection with `CloseCode.Removed`. */
export interface LeaveFrame {
  /** Frame type. */
  t: "leave";
  /** Chosen by the client, echoed in the answer. */
  id: number;
}

/** Every frame a client sends, apart from the `ping` keepalive. */
export type ClientMessage<Command = unknown> = CommandFrame<Command> | LeaveFrame;

/** First frame on every connection, reconnects included. */
export interface WelcomeFrame<View = unknown> {
  /** Frame type. */
  t: "welcome";
  /** `PROTOCOL_VERSION`. */
  v: number;
  /** This player's id. */
  you: string;
  /** The room's change counter. Every later `state` or `patch` carries the next one. */
  seq: number;
  /** Ticks run so far; 0 in event mode. */
  tick: number;
  /** Ticks a second; 0 in event mode. */
  tickRate: number;
  /** This player's whole view. */
  state: View;
  /** Everyone with a seat, in join order. */
  players: Player[];
}

/**
 * The state changed, and this is the player's whole view: sent when the room
 * does not know what the player holds, or when the view is not an object and
 * so cannot be patched.
 */
export interface StateFrame<View = unknown> {
  /** Frame type. */
  t: "state";
  /** The room's change counter after this change. */
  seq: number;
  /** Ticks run so far. */
  tick?: number;
  /** As in `PatchFrame`. */
  c?: number;
  /** This player's whole view. */
  state: View;
}

/** The state changed: only what differs from what this player last received. */
export interface PatchFrame {
  /** Frame type. */
  t: "patch";
  /** The room's change counter after this change. */
  seq: number;
  /** Ticks run so far. While the room is ticking, the tick that made the change. */
  tick: number;
  /**
   * Outside the simulation, the `seq` of the view this is a patch of. A client
   * that holds any other has missed something: it must not apply the patch,
   * and reconnects to be sent its whole view.
   */
  from?: number;
  /**
   * The `id` of the latest command of this player's that the view now
   * reflects: that one and every earlier one have been applied, and their
   * `ack` frames follow. Present when the frame is the first to show a
   * command of theirs.
   */
  c?: number;
  /** Apply it with `applyPatch` to the view you have. */
  p: Patch;
}

/** Someone joined, dropped or came back. */
export interface PresenceFrame {
  /** Frame type. */
  t: "presence";
  /** Everyone with a seat, in join order. */
  players: Player[];
}

/**
 * The command or leave with this `id` was applied, and the view this player
 * holds reflects it. It follows the `state` or `patch` frame that shows the
 * command's effect: at once in event mode, and after the next tick in a room
 * that is ticking, since that is when the effect is sent. A leave is always
 * answered at once.
 */
export interface AckFrame {
  /** Frame type. */
  t: "ack";
  /** The `id` of the command or leave. */
  id: number;
  /** The change it made, or the current one if it changed nothing. */
  seq: number;
  /** In a room that is ticking: the tick the view is now of, whether or not a frame was sent for it. */
  tick?: number;
}

/** The command or leave with this `id` was refused, and nothing changed. */
export interface RejectFrame {
  /** Frame type. */
  t: "reject";
  /** The `id` of the command or leave. */
  id: number;
  /**
   * What the room passed to `reject()`; else `invalid_command` if
   * `parseCommand` threw, `internal_error` if a hook threw, or `rate_limited`.
   */
  reason: string;
}

/** A frame the room could not read at all. */
export interface ErrorFrame {
  /** Frame type. */
  t: "error";
  /** `invalid_json`, `invalid_message`, `message_too_large`, `binary_not_supported` or `rate_limited`. */
  reason: string;
}

/** A message the room sent this player with `send` or `broadcast`. */
export interface MessageFrame {
  /** Frame type. */
  t: "msg";
  /** The message, as the room passed it. */
  d: unknown;
}

/** Every frame a room sends, apart from the `pong` keepalive. */
export type ServerMessage<View = unknown> =
  | WelcomeFrame<View>
  | StateFrame<View>
  | PatchFrame
  | PresenceFrame
  | AckFrame
  | RejectFrame
  | ErrorFrame
  | MessageFrame;

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
  /** Frame type. */
  t: "match";
  /** The room to connect to. Only these players can take a seat in it. */
  room: string;
  /** The players of the match, this one included. */
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

/** Whether a client should stop reconnecting after this close code. @internal */
export function isFatalCloseCode(code: number): boolean {
  return code >= 4000 && code < 4100;
}
