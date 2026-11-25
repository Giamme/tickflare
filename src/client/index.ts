/**
 * The client side: connecting to rooms, lockstep, matchmaking, accounts and
 * smoothing. Runs in browsers, Node and anywhere with a global `WebSocket`
 * and `fetch`.
 *
 * @packageDocumentation
 * @module tickflare/client
 */
import { BINARY_PATCHES, decodePatchFrame } from "../binary.js";
import { applyPatch } from "../patch.js";
import { ServerClock, localNow } from "./clock.js";
import { roomIn, withFreshToken, type TokenSource } from "./token.js";
import {
  CloseCode,
  PING,
  PONG,
  PROTOCOL_VERSION,
  isFatalCloseCode,
  type ClientMessage,
  type Player,
  type ServerMessage,
  type WelcomeFrame,
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
export { ServerClock } from "./clock.js";
export { BufferedInterpolator, type BufferedInterpolatorOptions, type TickSource } from "./buffered.js";
export { Predictor, type PredictorOptions } from "./predict.js";
export { produce } from "./draft.js";
export { decodePatchFrame } from "../binary.js";
export { LockstepClient, type LockstepClientOptions } from "./lockstep.js";
export {
  fingerprint,
  runReplay,
  seededRandom,
  stepThrough,
  type CatchUp,
  type LockstepView,
  type TurnsMessage,
  type Replay,
  type SeededRandom,
  type Simulation,
  type Snapshot,
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
   * Ask the room for its patches in binary. Off by default, and better left
   * off in a browser or in Node: there the connection is compressed, and
   * binary frames are a few percent smaller than JSON ones at best, and not
   * readable in the developer tools. It is for a client whose WebSocket is
   * not compressed, and here so that the format has a client to be tested
   * with. A room that does not know the format sends JSON, which is read as
   * always.
   */
  binary?: boolean;
  /**
   * Keepalive interval in milliseconds. Defaults to 25 seconds; 0 disables
   * it. A connection that goes a whole interval without answering is taken
   * for dead and replaced.
   */
  pingIntervalMs?: number;
  /**
   * How long a command may wait for a connection, in milliseconds. Defaults
   * to 10 seconds.
   *
   * A command sent while the client is connecting, the first time or again,
   * is held and sent as soon as the room answers. A command that was on its
   * way when the connection dropped is kept too: when the client is back,
   * the room says which of them it handled, the client sends the others
   * again, and none is applied twice. Either way the promise `send` returned
   * settles as if nothing had happened.
   *
   * A command that has waited this long is given up: its promise rejects
   * with `not_connected` if it was never sent, and `disconnected` if it was.
   * Keep it short in a game where a late command is worse than a lost one.
   *
   * 0 keeps nothing: `send` rejects at once while there is no connection,
   * and whatever is in flight when one drops rejects with `disconnected`.
   */
  keepCommandsMs?: number;
}

/** A command on its way: sent, and not yet shown by the room's state. */
export interface SentCommand<Command = unknown> {
  /** The number it was sent under. They go up with every command. */
  id: number;
  /** The command. */
  command: Command;
}

/** A command or leave the room refused, or one the client gave up on for want of a connection. */
export class CommandRejected extends Error {
  /**
   * What the room passed to `reject()`. Or `not_connected`: the command never
   * left this client, and was not applied. Or `disconnected`: it was sent,
   * the connection dropped, and the client could not learn what became of
   * it. It may or may not have been applied.
   */
  readonly reason: string;

  constructor(reason: string) {
    super(`Command rejected: ${reason}`);
    this.name = "CommandRejected";
    this.reason = reason;
  }
}

const MAX_BACKOFF_MS = 5_000;
/** How long a command waits for a connection unless `keepCommandsMs` says otherwise. */
const KEEP_COMMANDS_MS = 10_000;

/** A command or leave that the room has not answered yet. */
interface Pending<Command> {
  resolve(): void;
  reject(error: Error): void;
  /** The frame, as it is sent, and sent again if it has to be. */
  frame: ClientMessage<Command>;
  /** It has been sent, on this connection or an earlier one. */
  sent: boolean;
  /** Set while it waits for a connection: gives it up when `keepCommandsMs` has passed. */
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * A name for one client, for as long as it lives. The room tells one
 * client's commands from another's by it, so only the same player's other
 * clients must not share it: a few random characters are plenty.
 */
function clientName(): string {
  let name = "";
  while (name.length < 12) name += Math.random().toString(36).slice(2);
  return name.slice(0, 12);
}

/**
 * A connection to one room. Holds the latest state the server sent and
 * reconnects on its own; after a reconnect the server sends the current state
 * again, so there is nothing to replay. Commands that were on their way when
 * the connection dropped are settled then too: see `keepCommandsMs`.
 */
export class RoomClient<View = unknown, Command = unknown> {
  #state: View | undefined;
  #seq = 0;
  #tick = 0;
  #tickRate = 0;
  #patchRate = 0;
  #you: string | undefined;
  #players: Player[] = [];
  #status: ConnectionStatus = "connecting";
  #listeners = new Map<keyof RoomClientEvents<View>, Set<(...args: never[]) => void>>();

  #url: string;
  readonly #options: RoomClientOptions<View>;
  #socket: WebSocket | undefined;
  /** The name this client goes by: see `clientName`. */
  readonly #name = clientName();
  #nextId = 1;
  /** By id, which is also the order they were sent in: ids only go up, and none is put back. */
  #pending = new Map<number, Pending<Command>>();
  /** The room speaks version 5, by its last welcome: after a drop it can say which commands it handled. */
  #resumes = false;
  /** Commands sent that `#state` does not show yet, oldest first. Replaced, never changed, so that it can be compared by reference. */
  #unconfirmed: readonly SentCommand<Command>[] = [];
  #attempt = 0;
  #stopped = false;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #pingTimer: ReturnType<typeof setInterval> | undefined;
  /** A keepalive was sent and nothing has come back since. */
  #unanswered = false;
  /** When each `ping` that has not been answered yet was sent, oldest first, by `localNow()`. */
  #pingsAt: number[] = [];
  /** Which tick the room is on, from what it says of its clock. */
  readonly #clock = new ServerClock();

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

  /**
   * How many times a second the room sends what changed while it ticks: its
   * `patchRate` if it has one, and otherwise `tickRate`. 0 in event mode.
   * It is what to set the duration of an `Interpolator` from.
   */
  get patchRate(): number {
    return this.#patchRate;
  }

  /**
   * The tick the room is on right now, by estimate, with the fraction of the
   * next that has passed: for drawing the game in step with the room, or
   * sending a command in time for a tick. Worked out from the clock the room
   * sends (see `ClockFrame`) and the round trip to it, so it carries on
   * between frames, and is usually ahead of `tick`, which is the latest the
   * room has sent. While the room's simulation is stopped, the tick it
   * stopped at. Undefined in event mode, before the room has said where its
   * clock is, and with a room older than 0.2.
   *
   * @param now the moment to estimate it for, from `performance.now()`
   */
  serverTick(now?: number): number | undefined {
    return this.#clock.tick(now);
  }

  /**
   * The round trip to the room in milliseconds, smoothed over the latest
   * keepalives. Undefined until one has come back. In a ticking room the
   * client measures it every few seconds; otherwise with the keepalive.
   */
  get rtt(): number | undefined {
    return this.#clock.rtt;
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
   * The commands sent with `send` that `state` does not show yet, oldest
   * first: the room has not applied them, or has and the news is on its way.
   * A command leaves the list in the same moment `state` changes to show it,
   * or when the room refuses it. `Predictor` draws them over `state`. The
   * array is a new one whenever it changes.
   */
  get unconfirmed(): readonly SentCommand<Command>[] {
    return this.#unconfirmed;
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
   * already reflects it: at once in event mode, and with the next tick in a
   * room that is ticking. Rejects with `CommandRejected` if the room refused
   * it.
   *
   * A connection that drops on the way does not lose the command, or apply
   * it twice: the client learns what became of it when it is back, and sends
   * it again if it never arrived. Without a connection the command waits for
   * one. Both for at most `keepCommandsMs`, after which it rejects.
   */
  send(command: Command): Promise<void> {
    return this.#request((id) => {
      this.#unconfirmed = [...this.#unconfirmed, { id, command }];
      return { t: "cmd", id, data: command };
    });
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
      this.#forget();
      this.#setStatus("closed", { code: 1000, reason: "client_closed" });
    }
  }

  /** How long a command may wait for a connection. 0: not at all. */
  #keepMs(): number {
    const keep = this.#options.keepCommandsMs ?? KEEP_COMMANDS_MS;
    return keep > 0 ? keep : 0;
  }

  #request(frame: (id: number) => ClientMessage<Command>): Promise<void> {
    const socket = this.#socket;
    const open = socket !== undefined && this.#status === "open";
    const keep = this.#keepMs();
    // Without a connection it waits for one, if the client is still trying and may keep it.
    if (!open && (this.#status === "closed" || keep === 0)) {
      return Promise.reject(new CommandRejected("not_connected"));
    }
    const id = this.#nextId++;
    const message = frame(id);
    return new Promise<void>((resolve, reject) => {
      const pending: Pending<Command> = { resolve, reject, frame: message, sent: open };
      this.#pending.set(id, pending);
      if (open) socket.send(JSON.stringify(message));
      else this.#waitFor(id, pending, keep);
    });
  }

  /** Has `pending` wait for a connection, for `keep` milliseconds at most. */
  #waitFor(id: number, pending: Pending<Command>, keep: number): void {
    // `setTimeout` takes no delay longer than this, some 24 days: a wait without end is one of those.
    pending.timer = setTimeout(() => this.#giveUp(id, pending), Math.min(keep, 2 ** 31 - 1));
  }

  /** `pending` has waited for a connection as long as it may. */
  #giveUp(id: number, pending: Pending<Command>): void {
    if (this.#pending.get(id) !== pending || pending.timer === undefined) return;
    this.#pending.delete(id);
    if (this.#unconfirmed.some((sent) => sent.id === id)) {
      this.#unconfirmed = this.#unconfirmed.filter((sent) => sent.id !== id);
    }
    pending.reject(new CommandRejected(pending.sent ? "disconnected" : "not_connected"));
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
    const { binary } = this.#options;
    const asked = new URL(url);
    // The version of the protocol this client speaks: the room answers with the one it will use.
    asked.searchParams.set("v", String(PROTOCOL_VERSION));
    if (binary) asked.searchParams.set("patches", BINARY_PATCHES);
    // Who is asking, so that the room can say which of this client's commands it has handled.
    if (this.#keepMs() > 0) asked.searchParams.set("client", this.#name);
    url = asked.toString();
    const socket = new WebSocket(url);
    if (binary) socket.binaryType = "arraybuffer";
    this.#socket = socket;
    /** The keys the room has defined on this connection, by number. */
    const keys: string[] = [];

    socket.addEventListener("message", (event) => {
      if (socket !== this.#socket) return;
      const data: unknown = event.data;
      if (data instanceof ArrayBuffer) {
        this.#unanswered = false;
        let frame: ServerMessage<View>;
        try {
          frame = decodePatchFrame(new Uint8Array(data), keys);
        } catch (err) {
          // Whatever it was, the keys can no longer be trusted. Start again from a welcome.
          console.warn("[tickflare] could not read a binary frame:", err);
          return this.#resync();
        }
        return this.#handle(frame);
      }
      if (typeof data !== "string") return;
      // Anything the server sends shows the connection is alive.
      this.#unanswered = false;
      if (data === PONG) {
        const sentAt = this.#pingsAt.shift();
        if (sentAt !== undefined) this.#clock.roundTrip(localNow() - sentAt);
        return;
      }
      this.#handle(JSON.parse(data) as ServerMessage<View>);
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

  /** The current connection is over: keep or settle what was in flight, then follow, retry or stop. */
  #closed(code: number, reason: string): void {
    this.#socket = undefined;
    this.#stopPing();
    this.#pingsAt = [];
    this.#clock.reset();

    if (code === CloseCode.Moved && reason && !this.#stopped) {
      // What was sent to the room this player has left, or was waiting to be, stays behind.
      this.#forget();
      this.#resumes = false;
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
      this.#forget();
      this.#stopped = true;
      this.#setStatus("closed", { code, reason });
      return;
    }
    this.#keep();
    this.#setStatus("connecting", { code, reason });
    const backoff = Math.min(MAX_BACKOFF_MS, 250 * 2 ** this.#attempt++);
    this.#retryTimer = setTimeout(() => this.#open(), backoff / 2 + Math.random() * (backoff / 2));
  }

  /** Gives up on everything: what was sent and not answered, and what was waiting to be sent. */
  #forget(): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.reject(new CommandRejected(pending.sent ? "disconnected" : "not_connected"));
    }
    this.#pending.clear();
    if (this.#unconfirmed.length > 0) this.#unconfirmed = [];
  }

  /**
   * The connection dropped, and the client is about to try for another. What
   * was on its way waits for it, if the room is one that can say what became
   * of it: see `#resume`. If not, it is given up now.
   */
  #keep(): void {
    const keep = this.#keepMs();
    const lost = new Set<number>();
    for (const [id, pending] of this.#pending) {
      // Waiting already, from before this attempt: its time runs from when it began to.
      if (pending.timer !== undefined) continue;
      if (keep > 0 && this.#resumes) {
        this.#waitFor(id, pending, keep);
      } else {
        this.#pending.delete(id);
        lost.add(id);
        pending.reject(new CommandRejected("disconnected"));
      }
    }
    if (this.#unconfirmed.some((sent) => lost.has(sent.id))) {
      this.#unconfirmed = this.#unconfirmed.filter((sent) => !lost.has(sent.id));
    }
  }

  /**
   * A welcome has arrived: the room is there, and has said what it knows of
   * the commands that were on their way when the last connection dropped.
   *
   * Those it handled are settled, by what this returns, once `state` has
   * been set: the state in the welcome already shows them. Those it did not
   * are sent again, and those that waited to be sent are sent, all in the
   * order they were first sent in and before anything else can be: the room
   * takes a command with a lower number than the last for one it has seen.
   *
   * Without `c` the room knows nothing of what this client sent before: it
   * is older than version 5, the seat is newly taken, or it came back from
   * its last save on a connection that stayed open. What was sent is then
   * given up, as `disconnected`. So is a command up to `from`, of which the
   * room cannot say what became.
   */
  #resume(welcome: WelcomeFrame<View>): (() => void)[] {
    this.#resumes = welcome.v >= 5;
    const socket = this.#socket;
    const handled = this.#resumes ? welcome.c : undefined;
    /** Up to this one the room cannot say what became of a command: see `WelcomeFrame.from`. */
    const from = welcome.from ?? 0;
    const refused = new Map(welcome.refused ?? []);
    const settle: (() => void)[] = [];
    const answered = new Set<number>();
    for (const [id, pending] of this.#pending) {
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      pending.timer = undefined;
      if (!pending.sent || (handled !== undefined && id > handled)) {
        pending.sent = true;
        socket?.send(JSON.stringify(pending.frame));
        continue;
      }
      this.#pending.delete(id);
      answered.add(id);
      const reason = handled === undefined || id <= from ? "disconnected" : refused.get(id);
      settle.push(reason === undefined ? pending.resolve : () => pending.reject(new CommandRejected(reason)));
    }
    if (this.#unconfirmed.some((sent) => answered.has(sent.id))) {
      this.#unconfirmed = this.#unconfirmed.filter((sent) => !answered.has(sent.id));
    }
    return settle;
  }

  /** The state about to be set shows this player's commands up to `id`: they are no longer unconfirmed. */
  #shown(id: number | undefined): void {
    if (id === undefined || this.#unconfirmed.length === 0) return;
    const left = this.#unconfirmed.filter((sent) => sent.id > id);
    if (left.length !== this.#unconfirmed.length) this.#unconfirmed = left;
  }

  /** Resolves the commands up to `id`, whose effect `state` now has. */
  #resolveUpTo(id: number | undefined): void {
    if (id === undefined) return;
    for (const pending of [...this.#pending.keys()]) {
      if (pending <= id) this.#settle(pending)?.resolve();
    }
  }

  #handle(message: ServerMessage<View>): void {
    switch (message.t) {
      case "welcome": {
        // Before anything is told to anyone, who might send a command on hearing it.
        const settle = this.#resume(message);
        this.#attempt = 0;
        this.#you = message.you;
        this.#players = message.players;
        this.#tick = message.tick;
        this.#tickRate = message.tickRate;
        this.#patchRate = message.patchRate ?? message.tickRate;
        this.#clock.reset();
        if (message.ms !== undefined) this.#clock.reading(message.tick, message.tickRate, message.ms, message.epoch);
        this.#startPing();
        if (message.tickRate > 0) this.#measure();
        this.#setStatus("open");
        this.#emit("presence", this.#players);
        this.#setState(message.state, message.seq);
        for (const settled of settle) settled();
        break;
      }
      case "state":
        if (message.tick !== undefined) this.#tick = message.tick;
        this.#shown(message.c);
        this.#setState(message.state, message.seq);
        this.#resolveUpTo(message.c);
        break;
      case "patch":
        if (message.from !== undefined && message.from !== this.#seq) {
          // A patch of a view this client does not hold. Applying it would leave the screen
          // wrong with nothing to show for it, so start again from the whole view.
          this.#resync();
          break;
        }
        this.#tick = message.tick;
        this.#shown(message.c);
        this.#setState(applyPatch(this.#state as View, message.p), message.seq);
        this.#resolveUpTo(message.c);
        break;
      case "clock":
        this.#clock.reading(message.tick, this.#tickRate, message.ms, message.epoch);
        if (message.ms !== undefined) this.#measure();
        break;
      case "presence":
        this.#players = message.players ?? withPresence(this.#players, message.set, message.gone);
        this.#emit("presence", this.#players);
        break;
      case "ack":
        // The view is of this tick even if nothing in it changed and no frame said so.
        if (message.tick !== undefined && message.tick > this.#tick) this.#tick = message.tick;
        this.#shown(message.id);
        this.#settle(message.id)?.resolve();
        break;
      case "reject":
        if (this.#unconfirmed.some((sent) => sent.id === message.id)) {
          this.#unconfirmed = this.#unconfirmed.filter((sent) => sent.id !== message.id);
        }
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

  /** Drops the connection and opens a new one, which begins with the whole view. */
  #resync(): void {
    const socket = this.#socket;
    if (!socket) return;
    console.warn("[tickflare] out of step with the room; reconnecting");
    this.#socket = undefined;
    try {
      socket.close(1000, "resync");
    } catch {
      // Already closing.
    }
    this.#closed(1006, "resync");
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
      this.#pingsAt.push(localNow());
      socket.send(PING);
    }, interval);
  }

  /** Sends a `ping` to time the round trip, unless one is on its way already. Leaves the keepalive's watch alone. */
  #measure(): void {
    const socket = this.#socket;
    if (socket?.readyState !== 1 || this.#pingsAt.length > 0) return;
    this.#pingsAt.push(localNow());
    try {
      socket.send(PING);
    } catch {
      this.#pingsAt.pop();
    }
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

/** The list of players after a `presence` frame that says what changed: a new array, in join order. */
function withPresence(players: Player[], set: Player[] = [], gone: string[] = []): Player[] {
  const changed = new Map(set.map((player) => [player.id, player]));
  const left = new Set(gone);
  const out: Player[] = [];
  for (const player of players) {
    if (left.has(player.id)) continue;
    const now = changed.get(player.id);
    out.push(now ?? player);
    if (now) changed.delete(player.id);
  }
  // Whoever is left is new, and goes to the end in the order the room gave.
  for (const player of set) if (changed.has(player.id)) out.push(player);
  return out;
}
