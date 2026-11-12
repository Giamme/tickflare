/**
 * The client side: connecting to rooms, lockstep, matchmaking, accounts and
 * smoothing. Runs in browsers, Node and anywhere with a global `WebSocket`
 * and `fetch`.
 *
 * @packageDocumentation
 * @module tickflare/client
 */
import { applyPatch } from "../patch.js";
import { roomIn, withFreshToken, type TokenSource } from "./token.js";
import {
  CloseCode,
  PING,
  PONG,
  isFatalCloseCode,
  type ClientMessage,
  type Player,
  type ServerMessage,
} from "../protocol.js";

export { CloseCode, type MatchFound, type Player } from "../protocol.js";
export { findMatch, type FindMatchOptions } from "./matchmaking.js";
export type { TokenSource } from "./token.js";
export {
  AccountClient,
  AccountRequestError,
  type Account,
  type AccountClientOptions,
  type Guest,
  type KeyValueStore,
  type Leaderboard,
  type LeaderboardLine,
  type Profile,
} from "./accounts.js";
export { Interpolator } from "./interpolate.js";
export { LockstepClient, type LockstepClientOptions } from "./lockstep.js";
export {
  runReplay,
  seededRandom,
  type LockstepView,
  type TurnsMessage,
  type Replay,
  type Simulation,
  type TurnEntry,
} from "../lockstep.js";

/**
 * Where a connection stands. `connecting` covers the first attempt and every
 * reconnect; `closed` is final.
 */
export type ConnectionStatus = "connecting" | "open" | "closed";

/** Why a connection closed: the WebSocket close code and reason. */
export interface CloseDetail {
  /** The WebSocket close code, e.g. `CloseCode.RoomFull`, or 1006 for a connection that was lost. */
  code: number;
  /** The close reason, e.g. `room_full`, or what the room passed to `removePlayer`. */
  reason: string;
}

/** What a `RoomClient` reports, for `on(event, listener)`. Each is also an `on…` option. */
export interface RoomClientEvents<View> {
  /** See `RoomClientOptions.onState`. */
  state(state: View, seq: number): void;
  /** See `RoomClientOptions.onPresence`. */
  presence(players: Player[]): void;
  /** See `RoomClientOptions.onMessage`. */
  message(message: unknown): void;
  /** See `RoomClientOptions.onStatus`. */
  status(status: ConnectionStatus, detail?: CloseDetail): void;
  /** See `RoomClientOptions.onMoved`. */
  moved(roomId: string): void;
}

/** What a `RoomClient` reports and how it connects. Every option has a default. */
export interface RoomClientOptions<View> {
  /**
   * The state changed, or was received for the first time after (re)connecting.
   * Every call gets a new object; parts that did not change are the same
   * objects as before, so they can be compared by reference.
   */
  onState?(state: View, seq: number): void;
  /** Someone joined, dropped or came back. */
  onPresence?(players: Player[]): void;
  /** A message the room sent with `send` or `broadcast`. */
  onMessage?(message: unknown): void;
  /**
   * `closed` carries the close code and reason, e.g. when the room was full
   * or the seat was removed. So does `connecting` when it follows a
   * connection that was lost or never opened: it is called again for every
   * failed attempt. A client that keeps failing this way while the network is
   * fine is being turned away before it reaches the room, most often because
   * the join token in its URL has expired: see `token`.
   */
  onStatus?(status: ConnectionStatus, detail?: CloseDetail): void;
  /**
   * Supplies the join token, instead of putting one in the URL. It is called
   * before every connection attempt (the first, every reconnect, and when the
   * room hands the player to another room) with the id of the room being
   * connected to, and what it returns is sent as the `token` query parameter,
   * where `tokenAuth` reads it.
   *
   * Use it whenever tokens expire: a token in the URL is fixed for the life
   * of the client, so once it has run out the client can no longer
   * reconnect. Return the token you have while it is still good and fetch a
   * new one when it is not. If this throws, the attempt counts as failed
   * (`onStatus` gets `connecting` with the reason `token_failed`) and is
   * tried again like any other.
   */
  token?: TokenSource;
  /** The room handed this player to another room, and the client is now connecting there. */
  onMoved?(roomId: string): void;
  /** Reconnect after an unexpected close. Defaults to true. */
  reconnect?: boolean;
  /**
   * Keepalive interval in milliseconds. Defaults to 25 seconds; 0 disables
   * it. A connection that goes a whole interval without answering is taken
   * for dead and replaced.
   */
  pingIntervalMs?: number;
}

/** A command or leave the room refused, or one that was in flight when the connection dropped. */
export class CommandRejected extends Error {
  /** What the room passed to `reject()`, or `not_connected` or `disconnected`. */
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
  #state: View | undefined;
  #seq = 0;
  #tick = 0;
  #tickRate = 0;
  #you: string | undefined;
  #players: Player[] = [];
  #status: ConnectionStatus = "connecting";
  #listeners = new Map<keyof RoomClientEvents<View>, Set<(...args: never[]) => void>>();

  #url: string;
  readonly #options: RoomClientOptions<View>;
  #socket: WebSocket | undefined;
  #nextId = 1;
  #pending = new Map<number, { resolve(): void; reject(error: Error): void }>();
  #attempt = 0;
  #stopped = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  /** A keepalive was sent and nothing has come back since. */
  #unanswered = false;

  constructor(url: string | URL, options: RoomClientOptions<View> = {}) {
    this.#url = String(url);
    this.#options = options;
    this.#open();
  }

  /** The latest state the room sent: this player's view. Undefined until the first one arrives. */
  get state(): View | undefined {
    return this.#state;
  }

  /** The room's change counter for `state`. It goes up by one with every change. */
  get seq(): number {
    return this.#seq;
  }

  /** Simulation ticks the room has run. Stays 0 in event mode. */
  get tick(): number {
    return this.#tick;
  }

  /** The room's simulation rate in ticks per second; 0 in event mode. */
  get tickRate(): number {
    return this.#tickRate;
  }

  /** This player's id, as the server knows it. Set once connected. */
  get you(): string | undefined {
    return this.#you;
  }

  /** Everyone with a seat in the room, in join order. */
  get players(): Player[] {
    return this.#players;
  }

  /** Where the connection stands. */
  get status(): ConnectionStatus {
    return this.#status;
  }

  /**
   * Listen for `state`, `presence`, `message`, `status` or `moved`, in
   * addition to the `on…` options. Returns a function that stops listening,
   * which suits UI frameworks:
   *
   *     useEffect(() => room.on("state", setState), [room]);
   */
  on<E extends keyof RoomClientEvents<View>>(event: E, listener: RoomClientEvents<View>[E]): () => void {
    let listeners = this.#listeners.get(event);
    if (!listeners) this.#listeners.set(event, (listeners = new Set()));
    const added = listener as (...args: never[]) => void;
    listeners.add(added);
    return () => {
      listeners.delete(added);
    };
  }

  #emit<E extends keyof RoomClientEvents<View>>(event: E, ...args: Parameters<RoomClientEvents<View>[E]>): void {
    const option = {
      state: this.#options.onState,
      presence: this.#options.onPresence,
      message: this.#options.onMessage,
      status: this.#options.onStatus,
      moved: this.#options.onMoved,
    }[event] as ((...a: Parameters<RoomClientEvents<View>[E]>) => void) | undefined;
    option?.(...args);
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as unknown as (...a: Parameters<RoomClientEvents<View>[E]>) => void)(...args);
    }
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
    if (!socket || this.#status !== "open") {
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
    const { token } = this.#options;
    if (!token) return this.#connect(this.#url);

    withFreshToken(this.#url, roomIn(this.#url), token).then(
      (url) => {
        // close() may have been called while the token was on its way.
        if (!this.#stopped) this.#connect(url);
      },
      (err) => {
        if (this.#stopped) return;
        console.warn("[tickflare] could not get a join token:", err);
        this.#closed(1006, "token_failed");
      },
    );
  }

  #connect(url: string): void {
    const socket = new WebSocket(url);
    this.#socket = socket;

    socket.addEventListener("message", (event) => {
      if (socket !== this.#socket || typeof event.data !== "string") return;
      // Anything the server sends shows the connection is alive.
      this.#unanswered = false;
      if (event.data === PONG) return;
      this.#handle(JSON.parse(event.data) as ServerMessage<View>);
    });

    socket.addEventListener("close", (event) => {
      if (socket === this.#socket) this.#closed(event.code, event.reason);
    });
    // Browsers follow a failed connection's error with a close. Node's WebSocket does not when the
    // server turns the upgrade away, which would leave the client waiting on a socket that will
    // never open. A socket that errs before it opened has failed either way.
    socket.addEventListener("error", () => {
      if (socket === this.#socket && socket.readyState === 0) this.#closed(1006, "");
    });
  }

  /** The current connection is over: settle what was in flight, then follow, retry or stop. */
  #closed(code: number, reason: string): void {
    this.#socket = undefined;
    this.#stopPing();
    for (const pending of this.#pending.values()) {
      pending.reject(new CommandRejected("disconnected"));
    }
    this.#pending.clear();

    if (code === CloseCode.Moved && reason && !this.#stopped) {
      // Handed over to another room: same URL, with that room's id as the last path segment.
      const next = new URL(this.#url);
      next.pathname = next.pathname.replace(/[^/]+\/?$/, reason);
      this.#url = next.toString();
      this.#emit("moved", reason);
      this.#open();
      return;
    }

    const retry = !this.#stopped && this.#options.reconnect !== false && !isFatalCloseCode(code);
    if (!retry) {
      this.#stopped = true;
      this.#setStatus("closed", { code, reason });
      return;
    }
    this.#setStatus("connecting", { code, reason });
    const backoff = Math.min(MAX_BACKOFF_MS, 250 * 2 ** this.#attempt++);
    this.#retryTimer = setTimeout(() => this.#open(), backoff / 2 + Math.random() * (backoff / 2));
  }

  #handle(message: ServerMessage<View>): void {
    switch (message.t) {
      case "welcome": {
        this.#attempt = 0;
        this.#you = message.you;
        this.#players = message.players;
        this.#tick = message.tick;
        this.#tickRate = message.tickRate;
        this.#startPing();
        this.#setStatus("open");
        this.#emit("presence", this.#players);
        this.#setState(message.state, message.seq);
        break;
      }
      case "state":
        if (message.tick !== undefined) this.#tick = message.tick;
        this.#setState(message.state, message.seq);
        break;
      case "patch":
        this.#tick = message.tick;
        this.#setState(applyPatch(this.#state as View, message.p), message.seq);
        break;
      case "presence":
        this.#players = message.players;
        this.#emit("presence", this.#players);
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
      case "msg":
        this.#emit("message", message.d);
        break;
    }
  }

  #setState(state: View, seq: number): void {
    this.#state = state;
    this.#seq = seq;
    this.#emit("state", state, seq);
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
    this.#unanswered = false;
    this.#pingTimer = setInterval(() => {
      const socket = this.#socket;
      if (socket?.readyState !== 1) return;
      if (this.#unanswered) {
        // A dead connection can stay "open" for minutes. Do not wait for the browser to notice.
        this.#closed(1006, "keepalive_timeout");
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        return;
      }
      this.#unanswered = true;
      socket.send(PING);
    }, interval);
  }

  #stopPing(): void {
    if (this.#pingTimer !== undefined) clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
  }

  #setStatus(status: ConnectionStatus, detail?: CloseDetail): void {
    if (this.#status === status && !detail) return;
    this.#status = status;
    this.#emit("status", status, detail);
  }
}
