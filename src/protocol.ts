/**
 * Wire protocol shared by the room kernel and the client.
 *
 * Every frame is a JSON text frame, except the keepalive: the client sends the
 * literal string "ping" and the runtime answers "pong" without waking the room.
 */

import type { Patch } from "./patch.js";

/**
 * The latest version of the protocol. A client asks for a version with `v`
 * in the query when it connects, and the room's `welcome` frame says which
 * it will speak: the one asked for, or this one if that is later. A client
 * that does not ask is spoken to in version 1.
 *
 * Version 2 adds array patches: an array that changes can be sent element
 * by element, as `[changes, length]` in a patch.
 *
 * Version 3 adds presence as changes: a `presence` frame can say who is new
 * or different (`set`) and who is gone (`gone`) in place of the whole list.
 *
 * Version 4 adds the room's clock: while the simulation runs, `welcome`
 * says where the clock is (`ms` and `epoch`), and `clock` frames say it
 * again every few seconds, whenever it starts, stops or moves on.
 */
export const PROTOCOL_VERSION = 4;

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
  /** The version of the protocol the room speaks on this connection: see `PROTOCOL_VERSION`. */
  v: number;
  /** This player's id. */
  you: string;
  /** The room's change counter. Every later `state` or `patch` carries the next one. */
  seq: number;
  /** Ticks run so far; 0 in event mode. */
  tick: number;
  /** Ticks a second; 0 in event mode. */
  tickRate: number;
  /** Version 4, while the simulation runs: as in `ClockFrame`. Absent while it does not. */
  ms?: number;
  /** Version 4, while the simulation runs: as in `ClockFrame`. */
  epoch?: number;
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

/**
 * Someone joined, dropped, came back or left. Either the whole list, in
 * `players`, or what changed in it since the last frame, in `set` and
 * `gone`: a client of version 3 or later is sent whichever is shorter.
 */
export interface PresenceFrame {
  /** Frame type. */
  t: "presence";
  /** Everyone with a seat, in join order. When present, it replaces the list. */
  players?: Player[];
  /**
   * Players who are new, or whose `connected` or `name` changed. One the
   * list has already takes the place of the old entry; a new one goes to
   * the end, in the order given.
   */
  set?: Player[];
  /** The ids of players who no longer have a seat. */
  gone?: string[];
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

/**
 * Version 4: where the room's clock is. Ticks fall due on a fixed clock, one
 * every `1 / tickRate` seconds from when the simulation started, so a client
 * that knows how long ago one tick was due can tell which tick the room is on
 * at any moment: `tick + (ms + elapsed) * tickRate / 1000`, where `elapsed`
 * is the time since the frame was sent, about half a round trip when it
 * arrives. `RoomClient.serverTick()` works this out.
 *
 * Sent every five seconds while the simulation runs, and at once when it
 * starts, stops, or lets ticks go after a stall. The same reading is in
 * `welcome` for a client that connects while it runs.
 */
export interface ClockFrame {
  /** Frame type. */
  t: "clock";
  /** The latest tick the room has run. */
  tick: number;
  /**
   * How long before this frame was sent `tick` fell due, in milliseconds:
   * usually less than one tick, more when the room is running late. Absent
   * when the simulation has stopped, at `tick`, until a frame says otherwise.
   */
  ms?: number;
  /**
   * Which run of the clock this is. It changes when the simulation starts
   * again, and when the room lets ticks go after a stall; while it stays the
   * same, readings can be averaged.
   */
  epoch?: number;
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
  | ClockFrame
  | AckFrame
  | RejectFrame
  | ErrorFrame
  | MessageFrame;

/** WebSocket close codes the room uses. The client does not reconnect after those from 4000 to 4099. */
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
  /**
   * A ticking room heard nothing on this connection for `silentAfterMs`, not
   * even a keepalive, and took it for dead. A client that is there after
   * all connects again: this code is outside those it gives up on.
   */
  Silent: 4100,
} as const;

/** Sent by a matchmaker to every player of a match it has just put together. */
export interface MatchFound {
  /** Frame type. */
  t: "match";
  /** The room to connect to. Only these players can take a seat in it. */
  room: string;
  /** The players of the match, this one included. */
  players: string[];
  /** With a matchmaker that splits matches into sides: the players of each, in order. */
  teams?: string[][];
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
