/**
 * Wire protocol shared by the room kernel and the client.
 *
 * Every frame is a JSON text frame, except the keepalive: the client sends the
 * literal string "ping" and the runtime answers "pong" without waking the room.
 */

export const PROTOCOL_VERSION = 1;

export const PING = "ping";
export const PONG = "pong";

/** A seat in a room. A player keeps their seat while disconnected. */
export interface Player {
  id: string;
  connected: boolean;
}

/** `id` is chosen by the client and echoed back in the matching `ack` or `reject`. */
export type ClientMessage<Command = unknown> =
  | { t: "cmd"; id: number; data: Command }
  /** Give up the seat. On `ack` the room closes the connection with `CloseCode.Removed`. */
  | { t: "leave"; id: number };

export type ServerMessage<View = unknown> =
  /** First frame on every connection, including reconnects. */
  | { t: "welcome"; v: number; you: string; seq: number; state: View; players: Player[] }
  /** The state changed. `seq` increases by one per change. */
  | { t: "state"; seq: number; state: View }
  /** Someone joined, dropped or came back. */
  | { t: "presence"; players: Player[] }
  /** The command or leave was applied. Sent after the `state` frame it caused. */
  | { t: "ack"; id: number; seq: number }
  /** The command or leave was refused and the state is unchanged. */
  | { t: "reject"; id: number; reason: string }
  /** The frame could not be understood at all. */
  | { t: "error"; reason: string };

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
} as const;

export function isFatalCloseCode(code: number): boolean {
  return code >= 4000 && code < 4100;
}
