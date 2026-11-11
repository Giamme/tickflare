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

export type ClientMessage<Command = unknown> = {
  t: "cmd";
  /** Chosen by the client; echoed back in the matching `ack` or `reject`. */
  id: number;
  data: Command;
};

export type ServerMessage<View = unknown> =
  /** First frame on every connection, including reconnects. */
  | { t: "welcome"; v: number; you: string; seq: number; state: View; players: Player[] }
  /** The state changed. `seq` increases by one per change. */
  | { t: "state"; seq: number; state: View }
  /** Someone joined, dropped or came back. */
  | { t: "presence"; players: Player[] }
  /** The command was applied. Sent after the `state` frame it caused. */
  | { t: "ack"; id: number; seq: number }
  /** The command was refused and the state is unchanged. */
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
} as const;

export function isFatalCloseCode(code: number): boolean {
  return code >= 4000 && code < 4100;
}
