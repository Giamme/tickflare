import { applyPatch } from "../patch.js";
import {
  PING,
  PONG,
  isFatalCloseCode,
  type ClientMessage,
  type Player,
  type ServerMessage,
} from "../protocol.js";

export { CloseCode, type Player } from "../protocol.js";
export { LockstepClient, type LockstepClientOptions } from "./lockstep.js";
export {
  runReplay,
  seededRandom,
  type LockstepView,
  type Replay,
  type Simulation,
  type TurnEntry,
} from "../lockstep.js";

export type ConnectionStatus = "connecting" | "open" | "closed";

export interface RoomClientOptions<View> {
  /**
   * The state changed, or was received for the first time after (re)connecting.
   * Every call gets a new object; parts that did not change are the same
   * objects as before, so they can be compared by reference.
   */
  onState?(state: View, seq: number): void;
  /** Someone joined, dropped or came back. */
  onPresence?(players: Player[]): void;
  /** `closed` carries the close code and reason, e.g. when the room was full or the seat was removed. */
  onStatus?(status: ConnectionStatus, detail?: { code: number; reason: string }): void;
  /** Reconnect after an unexpected close. Defaults to true. */
  reconnect?: boolean;
  /** Keepalive interval in milliseconds. Defaults to 25 seconds; 0 disables it. */
  pingIntervalMs?: number;
}

/** A command or leave the room refused, or one that was in flight when the connection dropped. */
export class CommandRejected extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Command rejected: ${reason}`);
    this.name = "CommandRejected";
    this.reason = reason;
  }
}

const MAX_BACKOFF_MS = 5_000;

/**
 * A connection to one room. Holds the latest state the server sent and
 * reconnects on its own; after a reconnect the server sends the current state
 * again, so there is nothing to replay.
 */
export class RoomClient<View = unknown, Command = unknown> {
  state: View | undefined;
  seq = 0;
  /** Simulation ticks the room has run. Stays 0 in event mode. */
  tick = 0;
  /** The room's simulation rate in ticks per second; 0 in event mode. */
  tickRate = 0;
  /** This player's id, as the server knows it. Set once connected. */
  you: string | undefined;
  players: Player[] = [];
  status: ConnectionStatus = "connecting";

  readonly #url: string;
  readonly #options: RoomClientOptions<View>;
  #socket: WebSocket | undefined;
  #nextId = 1;
  #pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  #attempt = 0;
  #stopped = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(url: string | URL, options: RoomClientOptions<View> = {}) {
    this.#url = String(url);
    this.#options = options;
    this.#open();
  }

  /**
   * Send a command. Resolves once the room applied it, by which time `state`
   * already reflects it. Rejects with `CommandRejected` if the room refused
   * it or the connection dropped first.
   */
  send(command: Command): Promise<void> {
    return this.#request((id) => ({ t: "cmd", id, data: command }));
  }

  /**
   * Give up the seat in this room. Resolves once the room let the player go,
   * after which it closes the connection and `status` becomes `closed`.
   * Rejects with `CommandRejected` if the room made the player stay.
   */
  leave(): Promise<void> {
    return this.#request((id) => ({ t: "leave", id }));
  }

  /** Close the connection for good, keeping the seat. No reconnect follows. */
  close(): void {
    this.#stopped = true;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    const socket = this.#socket;
    if (socket && socket.readyState < 2) {
      socket.close(1000, "client_closed");
    } else {
      // Between reconnect attempts there is no socket left to report the close.
      this.#setStatus("closed", { code: 1000, reason: "client_closed" });
    }
  }

  #request(frame: (id: number) => ClientMessage<Command>): Promise<void> {
    const socket = this.#socket;
    if (!socket || this.status !== "open") {
      return Promise.reject(new CommandRejected("not_connected"));
    }
    const id = this.#nextId++;
    return new Promise<void>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      socket.send(JSON.stringify(frame(id)));
    });
  }

  #open(): void {
    this.#setStatus("connecting");
    const socket = new WebSocket(this.#url);
    this.#socket = socket;

    socket.addEventListener("message", (event) => {
      if (socket !== this.#socket || typeof event.data !== "string") return;
      if (event.data === PONG) return;
      this.#handle(JSON.parse(event.data) as ServerMessage<View>);
    });

    socket.addEventListener("close", (event) => {
      if (socket !== this.#socket) return;
      this.#stopPing();
      for (const pending of this.#pending.values()) {
        pending.reject(new CommandRejected("disconnected"));
      }
      this.#pending.clear();

      const retry =
        !this.#stopped && this.#options.reconnect !== false && !isFatalCloseCode(event.code);
      if (!retry) {
        this.#stopped = true;
        this.#setStatus("closed", { code: event.code, reason: event.reason });
        return;
      }
      this.#setStatus("connecting");
      const backoff = Math.min(MAX_BACKOFF_MS, 250 * 2 ** this.#attempt++);
      this.#retryTimer = setTimeout(() => this.#open(), backoff / 2 + Math.random() * (backoff / 2));
    });
  }

  #handle(message: ServerMessage<View>): void {
    switch (message.t) {
      case "welcome": {
        this.#attempt = 0;
        this.you = message.you;
        this.players = message.players;
        this.tick = message.tick;
        this.tickRate = message.tickRate;
        this.#startPing();
        this.#setStatus("open");
        this.#options.onPresence?.(this.players);
        this.#setState(message.state, message.seq);
        break;
      }
      case "state":
        if (message.tick !== undefined) this.tick = message.tick;
        this.#setState(message.state, message.seq);
        break;
      case "patch":
        this.tick = message.tick;
        this.#setState(applyPatch(this.state as View, message.p), message.seq);
        break;
      case "presence":
        this.players = message.players;
        this.#options.onPresence?.(this.players);
        break;
      case "ack":
        this.#settle(message.id)?.resolve();
        break;
      case "reject":
        this.#settle(message.id)?.reject(new CommandRejected(message.reason));
        break;
      case "error":
        console.warn(`[tickflare] server could not read a frame: ${message.reason}`);
        break;
    }
  }

  #setState(state: View, seq: number): void {
    this.state = state;
    this.seq = seq;
    this.#options.onState?.(state, seq);
  }

  #settle(id: number) {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    return pending;
  }

  #startPing(): void {
    const interval = this.#options.pingIntervalMs ?? 25_000;
    this.#stopPing();
    if (interval <= 0) return;
    this.#pingTimer = setInterval(() => {
      if (this.#socket?.readyState === 1) this.#socket.send(PING);
    }, interval);
  }

  #stopPing(): void {
    if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
  }

  #setStatus(status: ConnectionStatus, detail?: { code: number; reason: string }): void {
    if (this.status === status && !detail) return;
    this.status = status;
    this.#options.onStatus?.(status, detail);
  }
}
