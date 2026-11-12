import { DurableObject } from "cloudflare:workers";
import {
  CloseCode,
  PING,
  PONG,
  PROTOCOL_VERSION,
  type MatchResult,
  type Player,
  type ServerMessage,
} from "../protocol.js";
import { DeltaSender } from "./delta.js";
import { MAX_CLOSE_REASON, readFrame, refuse } from "./frames.js";
import { NAME_HEADER, PLAYER_HEADER, ROOM_HEADER } from "./gateway.js";
import { RateLimiter } from "./limiter.js";
import { SignalSender, type Signal } from "./signals.js";
import { RoomStorage, type OutboxEntry } from "./storage.js";

/** Thrown by a hook to refuse a command, a join or a leave. The reason is sent to the client. */
export class Rejection extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "Rejection";
    this.reason = reason;
  }
}

/** Refuse what the current hook was asked to do. Everything the hook changed is rolled back. */
export function reject(reason: string): never {
  throw new Rejection(reason);
}

type Outcome = { ok: true } | { ok: false; reason: string };

/** Everything a hook may change, as JSON. A hook that fails is rolled back to this. */
interface Committed {
  state: string;
  roster: string;
  timers: string;
}

const SOCKET_OPEN = 1;
/** Prefix of every timer name the kernel keeps for itself. */
const KERNEL_TIMER = "tickflare:";
/** Prefix of the kernel's own timers, which give up the seats of players who stay away. */
const AWAY_TIMER = "tickflare:away:";
/**
 * How long a room keeps sending a player on to the room it handed them to,
 * counted from the moment it first told them. Long enough for a client whose
 * connection dropped just then to come back and be told again.
 */
const FORWARD_GRACE_MS = 30_000;
/** Consecutive failed ticks after which the simulation pauses until the next event. */
const MAX_FAILED_TICKS = 5;

/**
 * An authoritative game room: one Durable Object per room.
 *
 * Event mode (the default) has no tick loop. The room wakes when a player
 * connects, sends a command, drops or leaves, or when a timer fires. It runs
 * the matching hook, saves what changed and sends each connected player their
 * view of the state. Between events it hibernates while the WebSockets stay
 * open, and rebuilds itself from storage on the next event.
 *
 * State sync adds a simulation: set `tickRate` and the room calls `onTick`
 * that many times a second while players are connected, sending each player
 * only what changed in their view since the previous tick.
 *
 * Hooks are synchronous and change `this.state` in place. The state must be
 * JSON-serializable. A hook that calls `reject()` or throws leaves no trace:
 * state, seats and timers go back to what they were.
 */
export abstract class Room<State, Command = unknown, Env = Cloudflare.Env> extends DurableObject<Env> {
  /** How many distinct players may hold a seat at once. */
  protected maxPlayers = Number.POSITIVE_INFINITY;

  /** Longest client frame accepted, in characters. */
  protected maxMessageLength = 16 * 1024;

  /**
   * How long a disconnected player keeps their seat, in milliseconds. When it
   * runs out, `onLeave` is called and the seat is given up, as if the player
   * had left; a later connection from them is a new join. The default,
   * `Infinity`, keeps seats until the player leaves or is removed, which is
   * what a game played over days wants. A real-time room should set it, or
   * closed tabs fill the room for good.
   */
  protected seatTimeoutMs = Number.POSITIVE_INFINITY;

  /**
   * How many frames a second one player may send, and also how many they may
   * send in a single burst. Frames over the limit are refused with
   * `rate_limited` and never reach `parseCommand`. `Infinity` turns it off.
   */
  protected maxCommandsPerSecond = 30;

  /**
   * Where `finishMatch` announces a finished match. Set it to a Queue binding:
   * `protected override matchQueue = this.env.MATCHES;`
   */
  protected matchQueue: Queue<MatchResult> | undefined;

  /**
   * Where `finishMatch` stores the replay it is given, if any. Set it to an R2
   * binding: `protected override matchBucket = this.env.REPLAYS;`
   */
  protected matchBucket: R2Bucket | undefined;

  /** Simulation rate in ticks per second. 0, the default, is event mode: no tick loop. */
  protected tickRate = 0;

  /**
   * While the room is ticking, how often the state is written to storage, in
   * milliseconds. It is also written whenever the simulation stops. A room
   * that is torn down mid-simulation (a deploy, a crash) resumes from the
   * last write.
   */
  protected saveIntervalMs = 5_000;

  /** The authoritative state. Change it only inside hooks. */
  protected state!: State;

  #loaded = false;
  /** The room's database. Set by `#load`. */
  #store!: RoomStorage;
  #seq = 0;
  #roster: string[] = [];
  /** Timer name to the time it fires, in epoch milliseconds. */
  #timers = new Map<string, number>();
  #committed: Committed = { state: "", roster: "[]", timers: "[]" };
  /** Seats given up during this event. Their sockets are closed once the event is over. */
  #removed: { id: string; reason: string }[] = [];
  /** The timers changed, so the object's alarm has to be moved before the event ends. */
  #alarmStale = false;

  /** The id this room is known by. Learned from the gateway or from `reserve`. */
  #roomId: string | null = null;
  /** If set, only these players may take a seat. Set by a matchmaker through `reserve`. */
  #invited: string[] | null = null;
  /** Players the current hook is handing to another room, not yet committed. */
  #moved: { player: string; to: string; carry: unknown }[] = [];
  /** Messages for other rooms sent by the current hook, not yet committed. */
  #signals: Signal[] = [];
  /** Messages for players, as frames, waiting for the end of the event. `to` null is everyone. */
  #mail: { to: string | null; frame: string }[] = [];
  /** Work for after the event, from `defer`. */
  #deferred: (() => unknown)[] = [];
  /** Messages for other rooms that are committed and waiting to go out. */
  #outgoing = new SignalSender();
  #flushing = false;
  /** Seats changed in a way the remaining players have not been told about yet. */
  #presenceStale = false;
  /** Finished matches announced by the current hook, not yet committed. */
  #finished: { message: MatchResult; replay?: string }[] = [];
  /** There are finished matches or handovers in storage that still have to be delivered. */
  #outboxPending = false;
  /** The current hook asked for its changes to be written at once. */
  #saveAsked = false;
  /** The player whose join or reconnect hook is running. Their socket is not accepted yet. */
  #connecting: string | null = null;
  /** A hook has returned a promise, so the state may be changed behind the kernel's back. */
  #suspect = false;
  /** `onHttp` calls that have not returned yet. They may not change the state either. */
  #reading = 0;

  /** Holds each player to `maxCommandsPerSecond`. */
  #limiter = new RateLimiter();

  /** Ticks run since the room was created. */
  #tick = 0;
  /** Set while the simulation is running. */
  #loop: ReturnType<typeof setInterval> | undefined;
  /** The committed state is newer than what is in storage. Only happens while ticking. */
  #unsaved = false;
  #ticksSinceSave = 0;
  #failedTicks = 0;
  /** onTick kept failing, so the loop stays off until something else happens. */
  #stalled = false;
  /** Knows what each socket holds, to send it only the difference at the next tick. */
  #deltas = new DeltaSender();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Keepalives are answered by the runtime, so they never wake the room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** The state of a brand new room. */
  protected abstract initialState(): State;

  /**
   * Turn an untrusted client payload into a command. Check everything here:
   * `raw` is whatever the client sent. Throwing refuses the command.
   */
  protected abstract parseCommand(raw: unknown): Command;

  /** Apply a command. Call `reject()` to refuse it. */
  protected abstract onCommand(player: Player, command: Command): void;

  /** A player takes a seat for the first time. Call `reject()` to turn them away. */
  protected onJoin(_player: Player): void {}

  /** A seated player's last connection closed. They keep their seat. */
  protected onDisconnect(_player: Player): void {}

  /** A seated player connected again after being fully disconnected. */
  protected onReconnect(_player: Player): void {}

  /**
   * A player is giving up their seat: they asked to leave, or they stayed
   * disconnected for longer than `seatTimeoutMs`. Tidy up after them here;
   * they are removed when this returns. Call `reject()` to make them stay.
   */
  protected onLeave(_player: Player): void {}

  /** A timer set with `setTimer(name, ...)` ran out. */
  protected onTimer(_name: string): void {}

  /**
   * Advance the simulation by one step of `dt` seconds (always `1 / tickRate`).
   * Runs `tickRate` times a second while the room is ticking.
   */
  protected onTick(_dt: number): void {}

  /**
   * Whether the simulation should be running. Checked after every event and
   * every tick, so base it on the state, e.g. `this.state.phase === "playing"`.
   * While it returns false the room behaves as in event mode and can
   * hibernate. The room never ticks while nobody is connected.
   */
  protected shouldTick(): boolean {
    return true;
  }

  /**
   * A plain HTTP request for this room, sent to `{prefix}/{roomId}/...` and
   * already authenticated by the gateway. For reading from the room, e.g. a
   * replay or a scoreboard: changes made to the state here are not saved or
   * sent to anyone.
   */
  protected onHttp(_request: Request, _player: Player): Response | Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  /** What `player` is allowed to see. Defaults to the whole state. */
  protected view(_player: Player): unknown {
    return this.state;
  }

  /** Everyone with a seat, in join order. */
  protected get players(): Player[] {
    return this.#roster.map((id) => ({ id, connected: id === this.#connecting || this.#isConnected(id) }));
  }

  /** Number of state changes so far. */
  protected get seq(): number {
    return this.#seq;
  }

  /** Number of ticks run so far. */
  protected get tick(): number {
    return this.#tick;
  }

  /** The id this room is reached under, once someone has connected through the gateway. */
  protected get roomId(): string | null {
    return this.#roomId;
  }

  /**
   * Have what the current hook changes written to storage as soon as the hook
   * returns, instead of at the next save interval. Only matters while the
   * room is ticking; outside the simulation every change is written at once.
   * Use it when the hook also writes to the room's database itself, so the
   * two cannot come apart. Call from inside a hook.
   */
  protected saveNow(): void {
    this.#saveAsked = true;
  }

  /**
   * Announce that a match is over. `result` is yours to define (winner,
   * scores, ...). It is put on `matchQueue` together with the room id and the
   * players, for a queue consumer such as `recordMatches` to store. Pass a
   * `replay` to have it written to `matchBucket` first; the message then
   * carries its key. Call from inside a hook.
   *
   * The announcement is saved with the room and sent after the hook has
   * committed. If sending fails it is tried again on the room's next event.
   */
  protected finishMatch(result: Record<string, unknown> = {}, replay?: unknown): void {
    if (!this.matchQueue) throw new TypeError("finishMatch() needs matchQueue to be set");
    const message: MatchResult = {
      id: crypto.randomUUID(),
      room: this.#roomId,
      endedAt: Date.now(),
      players: [...this.#roster],
      result,
    };
    if (replay !== undefined && this.matchBucket) {
      message.replayKey = `replays/${message.id}.json`;
      this.#finished.push({ message, replay: JSON.stringify(replay) });
    } else {
      this.#finished.push({ message });
    }
  }

  /**
   * Hand a player over to another room, for worlds that are split across
   * rooms. Their seat here is given up; once the other room has accepted
   * them, their connection is closed with `CloseCode.Moved` and the client
   * reconnects there by itself. `carry` (JSON) is delivered to the other
   * room's `onArrive`: put in it whatever the player takes along. Remove
   * their part of this room's state yourself. Call from inside a hook, and
   * implement `handOver`.
   *
   * A player who is not connected at that moment is sent on when they next
   * connect here.
   */
  protected movePlayer(playerId: string, toRoomId: string, carry?: unknown): void {
    if (this.handOver === Room.prototype.handOver) {
      throw new TypeError("movePlayer() needs handOver() to be implemented");
    }
    const seat = this.#roster.indexOf(playerId);
    if (seat === -1) return;
    this.#roster.splice(seat, 1);
    this.#timers.delete(AWAY_TIMER + playerId);
    this.#moved.push({ player: playerId, to: toRoomId, carry: carry ?? null });
  }

  /**
   * Deliver a player to another room. Typically:
   *
   *     const rooms = this.env.ROOMS;
   *     await rooms.get(rooms.idFromName(roomId)).arrive(roomId, playerId, carry);
   *
   * If it throws, the handover is tried again on this room's next event.
   */
  protected handOver(_roomId: string, _playerId: string, _carry: unknown): Promise<void> {
    return Promise.reject(new TypeError("handOver() is not implemented"));
  }

  /**
   * A player handed over by another room takes their seat. `carry` is what
   * that room passed to `movePlayer`. Defaults to treating them as a new
   * player.
   */
  protected onArrive(player: Player, _carry: unknown): void {
    this.onJoin(player);
  }

  /**
   * Called by another room, over RPC, to announce a player it is handing
   * over. The player is admitted when they connect, even if the room is full
   * or reserved.
   */
  async arrive(roomId: string, playerId: string, carry: unknown): Promise<void> {
    this.#load();
    this.#learnRoomId(roomId);
    this.#store.atomically(() => {
      this.#store.putArrival(playerId, carry);
      // They are coming back, so stop sending them to where they went.
      this.#store.removeForward(playerId);
    });
    await this.#finish();
  }

  /**
   * Send a message to one player, outside the state: an event they should
   * hear about once ("you were hit", a result with more in it than an ack),
   * or a stream you keep in step yourself. The client receives it in
   * `onMessage`.
   *
   * Messages go out when the event that sent them is over, in the order they
   * were sent: after the state frame that event caused, or in a ticking room
   * after the tick's patch. A message sent while handling a command can so
   * arrive before the next tick shows the command's effect. A message to a
   * player who is not connected is dropped, and so is everything a hook sent
   * if that hook is refused. Unlike the state, nothing is sent again on
   * reconnect: send what a returning player needs from `onReconnect`.
   */
  protected send(playerId: string, message: unknown): void {
    this.#mail.push({ to: playerId, frame: messageFrame(message) });
  }

  /** `send` to every player who is connected. */
  protected broadcast(message: unknown): void {
    this.#mail.push({ to: null, frame: messageFrame(message) });
  }

  /**
   * Run `task` once this event is over, outside the hook: for talking to the
   * world, which hooks cannot do because they are synchronous. Writing to
   * D1, calling another Durable Object, `fetch`. Dropped if the hook is
   * refused. Not awaited by anything and not retried: failures are logged.
   * To change the state with what comes back, use `act`; to be sure it gets
   * done across restarts, keep what is owed in the state and a timer that
   * tries again.
   */
  protected defer(task: () => unknown): void {
    this.#deferred.push(task);
  }

  /**
   * Run `hook` like any other hook, from code that is not one: the end of a
   * deferred task, a promise that resolved, an RPC method of your own. Its
   * changes are committed and sent, or all taken back if it throws or calls
   * `reject()`, which is what the returned outcome reports.
   */
  protected async act(hook: () => void): Promise<{ ok: true } | { ok: false; reason: string }> {
    this.#load();
    const outcome = this.#apply(hook);
    await this.#finish();
    return outcome;
  }

  /**
   * Send a message to another room, which receives it in `onSignal`. It goes
   * out once after this hook has committed. It is not saved and not retried:
   * use it for things that are replaced by the next one anyway, such as a
   * snapshot of what is near a border. Call from inside a hook, and implement
   * `relay`.
   *
   * With `onlyIfWatched`, a room that reports nobody connected is left alone
   * for two seconds at a time, so an empty neighbour is not kept awake.
   */
  protected signal(roomId: string, data: unknown, options: { onlyIfWatched?: boolean } = {}): void {
    if (this.relay === Room.prototype.relay) {
      throw new TypeError("signal() needs relay() to be implemented");
    }
    this.#signals.push({ to: roomId, data: data ?? null, onlyIfWatched: options.onlyIfWatched === true });
  }

  /**
   * Deliver a signal to another room and return what its `hear` returns.
   * Typically:
   *
   *     const rooms = this.env.ROOMS;
   *     return rooms.get(rooms.idFromName(roomId)).hear(this.roomId!, data);
   */
  protected relay(_roomId: string, _data: unknown): Promise<boolean> {
    return Promise.reject(new TypeError("relay() is not implemented"));
  }

  /** Another room sent this one a message with `signal`. */
  protected onSignal(_fromRoomId: string, _data: unknown): void {}

  /**
   * Called by another room, over RPC, to deliver a signal. Returns whether
   * anyone is connected here to see its effect.
   */
  async hear(fromRoomId: string, data: unknown): Promise<boolean> {
    this.#load();
    this.#apply(() => this.onSignal(fromRoomId, data));
    await this.#finish();
    return this.#seatedSockets().length > 0;
  }

  /**
   * Called by a matchmaker, over RPC, before a match's players arrive. It
   * creates the room where the matchmaker asked for it and closes it to
   * everyone but `playerIds`.
   */
  async reserve(roomId: string, playerIds: string[]): Promise<void> {
    this.#load();
    this.#learnRoomId(roomId);
    this.#invited = [...playerIds];
    this.#store.setMeta("invited", JSON.stringify(playerIds));
    await this.#finish();
  }

  /**
   * Run `onTimer(name)` once, `delayMs` from now. A timer with the same name
   * is replaced. Returns the time it fires in epoch milliseconds, which you
   * can put in the state to show a countdown. Call from inside a hook.
   *
   * Timers are saved with the room, so they survive hibernation and restarts.
   */
  protected setTimer(name: string, delayMs: number): number {
    if (!name) throw new TypeError("A timer needs a name");
    if (name.startsWith(KERNEL_TIMER)) throw new TypeError(`Timer names starting with "${KERNEL_TIMER}" are reserved`);
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError("delayMs must be a non-negative number");
    }
    const firesAt = Date.now() + Math.ceil(delayMs);
    this.#timers.set(name, firesAt);
    return firesAt;
  }

  /** Cancel a timer. Does nothing if it is not set. Call from inside a hook. */
  protected clearTimer(name: string): void {
    this.#timers.delete(name);
  }

  /**
   * Take a player's seat away and close their connection with
   * `CloseCode.Removed` and `reason`. `onLeave` is not called: clean up their
   * part of the state yourself. Call from inside a hook.
   */
  protected removePlayer(playerId: string, reason = "removed"): void {
    const seat = this.#roster.indexOf(playerId);
    if (seat === -1) return;
    this.#roster.splice(seat, 1);
    this.#timers.delete(AWAY_TIMER + playerId);
    this.#removed.push({ id: playerId, reason });
  }

  override async fetch(request: Request): Promise<Response> {
    const playerId = request.headers.get(PLAYER_HEADER);
    if (!playerId) {
      return new Response("Missing player identity", { status: 401 });
    }
    this.#load();
    const roomId = request.headers.get(ROOM_HEADER);
    if (roomId) this.#learnRoomId(roomId);
    const name = nameFrom(request);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      this.#reading += 1;
      try {
        const player: Player = { id: playerId, connected: this.#isConnected(playerId) };
        if (name !== undefined) player.name = name;
        return await this.onHttp(request, player);
      } finally {
        // onHttp is for reading. Whatever it changed is not kept.
        this.#reading -= 1;
        this.#undoDrift();
        await this.#finish();
      }
    }
    const response = this.#connect(playerId, name);
    await this.#finish();
    return response;
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.#load();
    this.#receive(ws, message);
    await this.#finish();
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Runtimes with a compatibility date before 2026-04-07 need the close echoed back.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
    this.#load();
    this.#dropped(ws);
    await this.#finish();
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#load();
    this.#dropped(ws);
    await this.#finish();
  }

  override async alarm(): Promise<void> {
    this.#load();
    // The alarm is always set for the earliest timer, so that one is due even
    // if this clock reads a little early.
    const now = Math.max(Date.now(), this.#nextTimer() ?? 0);
    const due = [...this.#timers]
      .filter(([, firesAt]) => firesAt <= now)
      .sort((a, b) => a[1] - b[1]);

    for (const [name, firesAt] of due) {
      // A timer that fired earlier in this batch may have cleared or moved this one.
      if (this.#timers.get(name) !== firesAt) continue;
      // Spend the timer first, on its own, so a failing hook cannot bring it back.
      this.#apply(() => this.#timers.delete(name));
      if (name.startsWith(AWAY_TIMER)) this.#giveUpSeat(name.slice(AWAY_TIMER.length));
      // Saved at once, even while ticking: the timer is spent, so its effect must not be lost.
      else this.#apply(() => this.onTimer(name), true);
    }
    this.#alarmStale = true;
    await this.#finish();
  }

  #connect(playerId: string, name: string | undefined): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const player: Player = { id: playerId, connected: true };
    if (name !== undefined) player.name = name;

    if (!this.#roster.includes(playerId)) {
      const arrival = this.#store.arrival(playerId);
      // A player handed over by another room is always let in.
      if (arrival === undefined) {
        const forward = this.#store.forward(playerId);
        if (forward && !forward.delivered) {
          // This room is still handing them over. Hold the connection without a seat:
          // it is closed with `Moved` as soon as the other room has them.
          this.#replaceSockets(playerId);
          this.ctx.acceptWebSocket(server, [playerId]);
          return new Response(null, { status: 101, webSocket: client });
        }
        if (forward && (forward.expires === null || forward.expires > Date.now())) {
          // They were handed over while away, or the news did not reach them. Send them on.
          if (forward.expires === null) this.#store.expireForward(playerId, Date.now() + FORWARD_GRACE_MS);
          return refuse(client, server, CloseCode.Moved, forward.room);
        }
        if (forward) this.#store.removeForward(playerId);
        if (this.#invited && !this.#invited.includes(playerId)) {
          return refuse(client, server, CloseCode.JoinRejected, "not_invited");
        }
        if (this.#roster.length >= this.maxPlayers) {
          return refuse(client, server, CloseCode.RoomFull, "room_full");
        }
      }
      const joined = this.#apply(() => {
        this.#roster.push(playerId);
        this.#connecting = playerId;
        if (arrival !== undefined) {
          this.onArrive(player, JSON.parse(arrival));
          this.#store.removeArrival(playerId);
        } else {
          this.onJoin(player);
        }
      });
      if (!joined.ok) {
        return refuse(client, server, CloseCode.JoinRejected, joined.reason);
      }
    } else if (!this.#isConnected(playerId)) {
      this.#apply(() => {
        this.#timers.delete(AWAY_TIMER + playerId);
        this.#connecting = playerId;
        this.onReconnect(player);
      });
    }
    // A hook may have removed the very player who is connecting.
    if (!this.#roster.includes(playerId)) {
      const reason = this.#removed.find((seat) => seat.id === playerId)?.reason ?? "removed";
      return refuse(client, server, CloseCode.Removed, reason);
    }

    // One connection per player: the newest wins.
    this.#replaceSockets(playerId);
    this.ctx.acceptWebSocket(server, [playerId]);

    const welcome = JSON.stringify({
      t: "welcome",
      v: PROTOCOL_VERSION,
      you: playerId,
      seq: this.#seq,
      tick: this.#tick,
      tickRate: this.tickRate,
      state: this.view(player),
      players: this.players,
    } satisfies ServerMessage);
    server.send(welcome);
    if (this.tickRate > 0) {
      // Remember exactly what this socket has, as a copy the simulation cannot touch.
      this.#deltas.remember(server, (JSON.parse(welcome) as { state: unknown }).state);
    }
    this.#broadcastPresence(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Closes a player's open connections because a newer one is taking over. */
  #replaceSockets(playerId: string): void {
    for (const old of this.ctx.getWebSockets(playerId)) {
      try {
        // Marked, so that its close is not taken for the player dropping.
        old.serializeAttachment({ replaced: true });
        old.close(CloseCode.Replaced, "replaced");
      } catch {
        // Already closed.
      }
    }
  }

  #receive(ws: WebSocket, message: string | ArrayBuffer): void {
    const playerId = this.#playerOf(ws);
    // A socket whose seat is gone is about to be closed; ignore what it still sends.
    if (!playerId || !this.#roster.includes(playerId)) return;

    // Every frame counts against the limit, including the ones refused below.
    const allowed = this.#limiter.spend(playerId, this.maxCommandsPerSecond);
    if (typeof message !== "string") {
      return this.#send(ws, { t: "error", reason: allowed ? "binary_not_supported" : "rate_limited" });
    }
    if (message.length > this.maxMessageLength) {
      return this.#send(ws, { t: "error", reason: allowed ? "message_too_large" : "rate_limited" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return this.#send(ws, { t: "error", reason: allowed ? "invalid_json" : "rate_limited" });
    }
    const frame = readFrame(parsed);
    if (!frame) {
      return this.#send(ws, { t: "error", reason: allowed ? "invalid_message" : "rate_limited" });
    }
    if (!allowed) {
      // Answered by id, so the client's pending command settles instead of hanging.
      return this.#send(ws, { t: "reject", id: frame.id, reason: "rate_limited" });
    }

    const player: Player = { id: playerId, connected: true };
    let outcome: Outcome;
    if (frame.t === "leave") {
      outcome = this.#apply(() => {
        this.onLeave(player);
        this.removePlayer(playerId, "left");
      });
    } else {
      let command: Command;
      try {
        command = this.parseCommand(frame.data);
      } catch (err) {
        const reason = err instanceof Rejection ? err.reason : "invalid_command";
        return this.#send(ws, { t: "reject", id: frame.id, reason });
      }
      outcome = this.#apply(() => this.onCommand(player, command));
    }

    if (!outcome.ok) {
      return this.#send(ws, { t: "reject", id: frame.id, reason: outcome.reason });
    }
    // The state frame, if any, has already gone out: an ack means "you have seen the result".
    this.#send(ws, { t: "ack", id: frame.id, seq: this.#seq });
  }

  #dropped(ws: WebSocket): void {
    const playerId = this.#playerOf(ws);
    // Players who left or were removed are not "disconnected": their seat is gone.
    if (!playerId || !this.#roster.includes(playerId)) return;
    // A newer connection for the same player took over: nothing to announce, now or
    // when this close arrives after the newer connection has itself gone.
    if ((ws.deserializeAttachment() as { replaced?: boolean } | null)?.replaced) return;
    if (this.#isConnected(playerId, ws)) return;

    this.#apply(() => this.onDisconnect({ id: playerId, connected: false }));
    this.#apply(() => this.#startSeatTimeout(playerId));
    this.#broadcastPresence(ws);
  }

  #startSeatTimeout(playerId: string): void {
    if (Number.isFinite(this.seatTimeoutMs) && this.#roster.includes(playerId)) {
      this.#timers.set(AWAY_TIMER + playerId, Date.now() + Math.max(0, this.seatTimeoutMs));
    }
  }

  /** A player stayed away for `seatTimeoutMs`: let the game tidy up, then take the seat back. */
  #giveUpSeat(playerId: string): void {
    if (!this.#roster.includes(playerId) || this.#isConnected(playerId)) return;
    this.#apply(() => {
      this.onLeave({ id: playerId, connected: false });
      this.removePlayer(playerId, "away");
    });
  }

  /**
   * The end of every event and every tick: close the sockets of removed
   * players, move the alarm, and start or stop the simulation.
   */
  async #finish(afterEvent = true): Promise<void> {
    // Before anyone removed is disconnected, so they hear why.
    if (this.#mail.length > 0) this.#deliverMail();
    if (this.#removed.length > 0 || this.#presenceStale) {
      this.#presenceStale = false;
      for (const { id, reason } of this.#removed.splice(0)) {
        for (const ws of this.ctx.getWebSockets(id)) {
          try {
            ws.close(CloseCode.Removed, reason.slice(0, MAX_CLOSE_REASON));
          } catch {
            // Already closed.
          }
        }
      }
      this.#broadcastPresence();
    }

    if (this.#alarmStale) {
      this.#alarmStale = false;
      const next = this.#nextTimer();
      if (next === undefined) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(next);
    }

    if (this.#outgoing.pending) await this.#outgoing.send((to, data) => this.relay(to, data));
    if (this.#outboxPending && !this.#flushing) {
      // One at a time: an event that arrives while a delivery is under way must not repeat it.
      // What that event adds to the outbox is picked up by the delivery already running.
      this.#flushing = true;
      try {
        await this.#flushOutbox();
      } finally {
        this.#flushing = false;
      }
    }

    if (afterEvent) this.#stalled = false;
    this.#syncLoop();

    for (const task of this.#deferred.splice(0)) {
      const running = Promise.resolve()
        .then(task)
        .catch((err) => console.error("[tickflare] deferred task failed:", err));
      this.ctx.waitUntil(running);
    }
  }

  /**
   * Delivers what is waiting in storage. A finished match: replay to R2, then
   * the message to the queue. A handover: the player to the other room, then
   * their connection is closed so the client follows.
   */
  async #flushOutbox(): Promise<void> {
    let failed = false;
    let last = 0;
    // Read one entry at a time: hooks that commit while a delivery is awaited add to the outbox.
    for (let next = this.#store.nextInOutbox(last); next; next = this.#store.nextInOutbox(last)) {
      last = next.id;
      try {
        await this.#deliver(next.entry);
        this.#store.removeFromOutbox(next.id);
      } catch (err) {
        // Left in storage; the next event tries again. The entries after it still go out.
        failed = true;
        console.error("[tickflare] could not deliver a finished match or a handover:", err);
      }
    }
    // Nothing has been awaited since the last read came back empty, so this cannot hide an entry.
    this.#outboxPending = failed;
  }

  async #deliver(entry: OutboxEntry): Promise<void> {
    if (entry.move) {
      const { player, to, carry } = entry.move;
      await this.handOver(to, player, carry);
      let told = false;
      for (const ws of this.ctx.getWebSockets(player)) {
        if (ws.readyState === SOCKET_OPEN) told = true;
        try {
          ws.close(CloseCode.Moved, to);
        } catch {
          // Already closed.
        }
      }
      // If they were away, they are told when they next connect here.
      this.#store.deliverForward(player, to, told ? Date.now() + FORWARD_GRACE_MS : null);
      return;
    }
    const { message, replay } = entry;
    if (replay !== undefined && message.replayKey && this.matchBucket) {
      await this.matchBucket.put(message.replayKey, replay, {
        httpMetadata: { contentType: "application/json" },
      });
    }
    await this.matchQueue?.send(message);
  }

  /** Starts the simulation if it should be running and stops it if it should not. */
  #syncLoop(): void {
    let wanted = false;
    if (this.tickRate > 0 && !this.#stalled && this.#seatedSockets().length > 0) {
      try {
        wanted = this.shouldTick() === true;
      } catch (err) {
        console.error("[tickflare] shouldTick() failed:", err);
      }
    }
    if (wanted && this.#loop === undefined) {
      this.#loop = setInterval(() => this.#runTick(), 1000 / this.tickRate);
    } else if (!wanted && this.#loop !== undefined) {
      clearInterval(this.#loop);
      this.#loop = undefined;
      // Send what changed since the last tick, or it would never go out.
      this.#broadcastTick();
      if (this.#unsaved) this.#writeRoom(this.#seq, this.#committed);
      this.#deltas.reset();
    }
  }

  #runTick(): void {
    this.#tick += 1;
    const ticked = this.#apply(() => this.onTick(1 / this.tickRate));
    if (ticked.ok) {
      this.#failedTicks = 0;
    } else if (++this.#failedTicks >= MAX_FAILED_TICKS) {
      console.error("[tickflare] onTick keeps failing; the simulation is paused until the next event");
      this.#failedTicks = 0;
      this.#stalled = true;
    }

    if (++this.#ticksSinceSave * 1000 >= this.saveIntervalMs * this.tickRate) {
      this.#ticksSinceSave = 0;
      if (this.#unsaved) this.#writeRoom(this.#seq, this.#committed);
    }
    this.#broadcastTick();
    this.#finish(false).catch((err) => console.error("[tickflare] tick cleanup failed:", err));
  }

  /** Reads the room from storage the first time an event arrives after a (re)start. */
  #load(): void {
    if (this.#loaded) {
      if (this.#suspect || this.#reading > 0) this.#undoDrift();
      return;
    }
    this.#store = new RoomStorage(this.ctx.storage);
    this.#store.purgeForwards(Date.now());
    const room = this.#store.room();

    let state: string;
    if (room) {
      state = room.state;
    } else {
      state = JSON.stringify(this.initialState());
      if (state === undefined) {
        throw new TypeError("initialState() must return a JSON-serializable value");
      }
    }
    const meta = this.#store.meta();
    this.#tick = Number(meta.get("tick") ?? 0);
    this.#roomId = meta.get("room") ?? null;
    this.#invited = meta.has("invited") ? (JSON.parse(meta.get("invited")!) as string[]) : null;
    this.#outboxPending = this.#store.hasOutbox();
    this.#seq = room?.seq ?? 0;
    this.#committed = {
      state,
      roster: room?.roster ?? "[]",
      timers: JSON.stringify(this.#store.timers()),
    };
    // Start from the JSON round-trip, so new and resumed rooms behave the same.
    this.#restore();
    this.#loaded = true;

    // Seats left by players who dropped while no timeout was running for them (the option was
    // added or shortened since, or the room was torn down mid-event) get one now.
    const adrift = this.#roster.filter((id) => !this.#timers.has(AWAY_TIMER + id) && !this.#isConnected(id));
    if (adrift.length > 0 && Number.isFinite(this.seatTimeoutMs)) {
      this.#apply(() => adrift.forEach((id) => this.#startSeatTimeout(id)));
    }
  }

  /** Puts state, seats and timers back to what was last committed. */
  #restore(): void {
    this.state = JSON.parse(this.#committed.state) as State;
    this.#roster = JSON.parse(this.#committed.roster) as string[];
    this.#timers = new Map(JSON.parse(this.#committed.timers) as [string, number][]);
  }

  /**
   * Puts the state back if something changed it outside a hook: `onHttp`, or
   * a hook that returned a promise and carried on after it was refused. Such
   * a change was never checked, saved or sent, and must not ride along with
   * the next commit. Comparing costs a pass over the state, so this is only
   * called where one of the two can have happened.
   */
  #undoDrift(): void {
    let live: string | undefined;
    try {
      live = JSON.stringify(this.state);
    } catch {
      // Not even serializable: certainly not what was committed.
    }
    if (live === this.#committed.state) return;
    console.error(
      "[tickflare] the state was changed outside a hook (in onHttp, or by a hook that returned a promise); the change was discarded",
    );
    this.#restore();
  }

  #writeRoom(seq: number, committed: Committed): void {
    this.#store.atomically(() => this.#persist(seq, committed));
    this.#unsaved = false;
  }

  #persist(seq: number, committed: Committed): void {
    this.#store.writeRoom({ seq, state: committed.state, roster: committed.roster });
    if (this.tickRate > 0) this.#store.setMeta("tick", String(this.#tick));
  }

  /** Remembers the id this room is reached under, the first time it hears it. */
  #learnRoomId(roomId: string): void {
    if (this.#roomId === roomId) return;
    this.#roomId = roomId;
    this.#store.setMeta("room", roomId);
  }

  /**
   * Runs a hook, then commits what it changed. If the hook fails, everything
   * it touched is put back and the reason is returned. That includes what it
   * wrote to the room's database: hook and commit run in one transaction.
   *
   * Outside the simulation a commit is saved and broadcast at once. While the
   * room is ticking, state changes are only kept in memory here: the next tick
   * sends them and the save interval writes them. The exception is a commit
   * that also changes something which is always saved at once (seats, timers,
   * the outbox) or that asks for it (`durable`, `saveNow()`): the state is
   * written with it, so storage never holds one without the other.
   */
  #apply(hook: () => void, durable = false): Outcome {
    if (this.#suspect || this.#reading > 0) this.#undoDrift();
    const removedBefore = this.#removed.length;
    const mailBefore = this.#mail.length;
    const deferredBefore = this.#deferred.length;
    this.#finished.length = 0;
    this.#moved.length = 0;
    this.#signals.length = 0;
    this.#saveAsked = false;
    const was = this.#committed;
    const ticking = this.#loop !== undefined;
    try {
      const { next, seq, stateChanged, saved } = this.#store.atomically(() => {
        const returned = hook() as unknown;
        if (isThenable(returned)) {
          returned.then(undefined, () => {});
          this.#suspect = true;
          throw new TypeError("Room hooks must be synchronous");
        }
        const state = JSON.stringify(this.state);
        if (state === undefined) {
          throw new TypeError("Room state must be JSON-serializable");
        }
        const next: Committed = {
          state,
          roster: JSON.stringify(this.#roster),
          timers: JSON.stringify([...this.#timers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
        };
        // Serialized before anything is written, so a value that cannot be is caught here.
        const owed = [
          ...this.#finished.map((finished) => JSON.stringify(finished satisfies OutboxEntry)),
          ...this.#moved.map((move) => JSON.stringify({ move } satisfies OutboxEntry)),
        ];

        const stateChanged = next.state !== was.state;
        const seq = stateChanged ? this.#seq + 1 : this.#seq;
        const rosterChanged = next.roster !== was.roster;
        const timersChanged = next.timers !== was.timers;
        // What must never be in storage without the state it belongs to.
        const anchored = rosterChanged || timersChanged || owed.length > 0 || durable || this.#saveAsked;
        const saved = rosterChanged || ((stateChanged || this.#unsaved) && (!ticking || anchored));

        if (saved) this.#persist(seq, next);
        if (timersChanged) this.#store.replaceTimers(this.#timers);
        for (const body of owed) this.#store.addToOutbox(body);
        for (const move of this.#moved) this.#store.putForward(move.player, move.to);
        return { next, seq, stateChanged, saved };
      });

      if (saved) this.#unsaved = false;
      else if (stateChanged) this.#unsaved = true;
      if (next.timers !== was.timers) this.#alarmStale = true;
      if (this.#finished.length > 0 || this.#moved.length > 0) this.#outboxPending = true;
      if (this.#moved.length > 0) this.#presenceStale = true;
      this.#finished.length = 0;
      this.#moved.length = 0;
      this.#outgoing.add(this.#signals.splice(0));

      this.#seq = seq;
      this.#committed = next;
      if (stateChanged && !ticking) this.#broadcastState();
      return { ok: true };
    } catch (err) {
      this.#restore();
      this.#removed.length = removedBefore;
      this.#mail.length = mailBefore;
      this.#deferred.length = deferredBefore;
      this.#finished.length = 0;
      this.#moved.length = 0;
      this.#signals.length = 0;
      if (err instanceof Rejection) return { ok: false, reason: err.reason };
      console.error("[tickflare] room hook failed:", err);
      return { ok: false, reason: "internal_error" };
    } finally {
      this.#connecting = null;
    }
  }

  /** Sends everyone their whole view. Used outside the simulation. */
  #broadcastState(): void {
    // Whatever the sockets were sent during an earlier simulation is now out of date.
    this.#deltas.reset();
    // Without a custom view everyone gets the same frame, so build it once.
    const shared =
      this.view === Room.prototype.view
        ? JSON.stringify({ t: "state", seq: this.#seq, state: this.state })
        : undefined;

    for (const { ws, id } of this.#seatedSockets()) {
      try {
        ws.send(
          shared ??
            JSON.stringify({
              t: "state",
              seq: this.#seq,
              state: this.view({ id, connected: true }),
            }),
        );
      } catch (err) {
        // A view() that threw must not starve the other players.
        console.error(`[tickflare] could not send state to ${id}:`, err);
      }
    }
  }

  /** Sends everyone what changed in their view since the last tick. */
  #broadcastTick(): void {
    const custom = this.view !== Room.prototype.view;
    this.#deltas.send(
      this.#seatedSockets(),
      this.#seq,
      this.#tick,
      this.state,
      custom ? (id) => this.view({ id, connected: true }) : undefined,
    );
  }

  #broadcastPresence(except?: WebSocket): void {
    const frame = JSON.stringify({ t: "presence", players: this.players });
    for (const { ws } of this.#seatedSockets()) {
      if (ws === except) continue;
      try {
        ws.send(frame);
      } catch {
        // Socket is closing.
      }
    }
  }

  #send(ws: WebSocket, message: ServerMessage): void {
    try {
      ws.send(JSON.stringify(message));
    } catch {
      // Socket is closing.
    }
  }

  #deliverMail(): void {
    const mail = this.#mail.splice(0);
    let everyone: { ws: WebSocket; id: string }[] | undefined;
    for (const { to, frame } of mail) {
      const sockets =
        to === null
          ? (everyone ??= this.#seatedSockets()).map(({ ws }) => ws)
          : this.#roster.includes(to) || this.#removed.some((seat) => seat.id === to)
            ? this.ctx.getWebSockets(to).filter((ws) => ws.readyState === SOCKET_OPEN)
            : [];
      for (const ws of sockets) {
        try {
          ws.send(frame);
        } catch {
          // Socket is closing.
        }
      }
    }
  }

  /** Open sockets of players who still hold a seat. */
  #seatedSockets(): { ws: WebSocket; id: string }[] {
    const sockets: { ws: WebSocket; id: string }[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const id = this.#playerOf(ws);
      if (id && ws.readyState === SOCKET_OPEN && this.#roster.includes(id)) {
        sockets.push({ ws, id });
      }
    }
    return sockets;
  }

  #playerOf(ws: WebSocket): string | undefined {
    return this.ctx.getTags(ws)[0];
  }

  #isConnected(playerId: string, except?: WebSocket): boolean {
    return this.ctx
      .getWebSockets(playerId)
      .some((ws) => ws !== except && ws.readyState === SOCKET_OPEN);
  }

  #nextTimer(): number | undefined {
    let next: number | undefined;
    for (const firesAt of this.#timers.values()) {
      if (next === undefined || firesAt < next) next = firesAt;
    }
    return next;
  }
}

function messageFrame(message: unknown): string {
  const frame = JSON.stringify({ t: "msg", d: message ?? null });
  // `undefined` and functions vanish in JSON; a cycle or a BigInt throws on its own.
  if (frame === undefined) throw new TypeError("A message must be JSON-serializable");
  return frame;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}

/** The name the gateway forwarded, if any. */
function nameFrom(request: Request): string | undefined {
  const header = request.headers.get(NAME_HEADER);
  if (!header) return undefined;
  try {
    return decodeURIComponent(header);
  } catch {
    return undefined;
  }
}
