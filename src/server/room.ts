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
import { BINARY_PATCHES } from "../binary.js";
import { DeltaSender, type SeatedSocket } from "./delta.js";
import { MAX_CLOSE_REASON, readFrame, refuse } from "./frames.js";
import { NAME_HEADER, PLAYER_HEADER, ROOM_HEADER, type RoomNamespace } from "./gateway.js";
import { RateLimiter } from "./limiter.js";
import { SignalSender, type Signal } from "./signals.js";
import { Tracker } from "./tracked.js";
import { RoomStorage, type OutboxEntry } from "./storage.js";

/** Thrown by a hook to refuse a command, a join or a leave. The reason is sent to the client. */
export class Rejection extends Error {
  /** Sent to the client as the reason. */
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "Rejection";
    this.reason = reason;
  }
}

/** What `act` reports: the hook's changes were committed, or it was refused and why. */
export type ActOutcome =
  | {
      /** The hook's changes were committed and sent. */
      ok: true;
    }
  | {
      /** The hook was refused: nothing it did was kept. */
      ok: false;
      /** What it passed to `reject()`, or `internal_error` if it threw. */
      reason: string;
    };

/** What one room or matchmaker asks of another over RPC. @internal */
export type RoomCall =
  | { op: "arrive"; roomId: string; playerId: string; carry: unknown }
  | { op: "signal"; from: string | null; data: unknown }
  | { op: "reserve"; roomId: string; players: string[] };

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

/** Marks the socket of a client that asked for patches in binary. No player's id starts with a control character. */
const BINARY_TAG = "\u0001patches=b1";
/** Marks the socket of a client that speaks version 2 of the protocol: it knows array patches. */
const V2_TAG = "\u0001v=2";
const isMark = (tag: string) => tag.charCodeAt(0) === 1;
/** Prefix of every timer name the kernel keeps for itself. */
const KERNEL_TIMER = "tickflare:";
/** Prefix of the kernel's own timers, which give up the seats of players who stay away. */
const AWAY_TIMER = "tickflare:away:";
/** Set by `deleteRoom()`: when it fires, the room deletes everything it stored. */
const DELETE_TIMER = "tickflare:delete";
/** A room that still owes a delivery puts its deletion off by this much, and tries the delivery again. */
const DELETE_RETRY_MS = 30_000;
/**
 * Set while a room ticks with nobody connected. Cloudflare takes an object
 * with no connections out of memory after about a minute without an event,
 * timers and all; an alarm is an event, and it is also what starts the
 * simulation again after a deploy or a crash.
 */
const AWAKE_TIMER = "tickflare:awake";
const AWAKE_MS = 20_000;
/** How long a room that is being deleted waits for deferred work that is still running. */
const DELETE_PATIENCE_MS = 10_000;
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

  /**
   * Where the other rooms are, for `movePlayer` and `signal`: the Durable
   * Object namespace they live in, usually this room's own.
   * `protected override rooms = this.env.ROOMS;`
   */
  protected rooms: RoomNamespace | undefined;

  /** Simulation rate in ticks per second. 0, the default, is event mode: no tick loop. */
  protected tickRate = 0;

  /**
   * While the room is ticking, how often the state is written to storage, in
   * milliseconds. It is also written whenever the simulation stops. A room
   * that is torn down mid-simulation (a deploy, a crash) resumes from the
   * last write.
   */
  protected saveIntervalMs = 5_000;

  /**
   * Whether the kernel follows what each hook writes to the state, rather
   * than turning the whole state into JSON after every hook to see what
   * changed and to be able to undo it. On by default: a hook then costs what
   * it touches, not what the state weighs.
   *
   * It means that inside a hook other than `onTick`, `this.state` and
   * everything reached through it are proxies of the state's objects. They
   * read and write like the objects themselves, with two exceptions: a proxy
   * is not `===` to an object that did not come from the state, and
   * `structuredClone` refuses one. `plain(value)` gives the object underneath
   * for those. Reach the state through `this.state` in every hook, rather
   * than through a reference kept from an earlier one: a change made through
   * such a reference is not seen until the next tick or save, and is not
   * undone if the hook is refused.
   *
   * Set to false to have every hook work on the plain state, at the old cost.
   */
  protected trackChanges = true;

  /**
   * The authoritative state. Change it only inside hooks, through
   * `this.state`: see `trackChanges` for what a hook is handed.
   */
  protected get state(): State {
    return this.#tracker.active ? this.#tracker.wrap(this.#state) : this.#state;
  }

  /** Replaces the whole state. Like any other change, only inside hooks. */
  protected set state(value: State) {
    if (!this.#tracker.active) {
      this.#state = value;
      return;
    }
    const before = this.#state;
    this.#tracker.note(() => {
      this.#state = before;
    });
    this.#state = this.#tracker.clean(value);
  }

  /** The state itself: plain objects, never proxies. */
  #state!: State;
  #tracker = new Tracker();
  /**
   * The state has changed since `#committed.state` was written. Happens while
   * ticking, when a tracked hook changes the state and nothing needs its JSON
   * yet. Whatever does need it calls `#snapshot` first.
   */
  #stale = false;

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
  /** While ticking: the commands each socket has had applied and not yet been told about. */
  #owed = new Map<WebSocket, number[]>();
  /** The command being handled, and who sent it. */
  #answering: { ws: WebSocket; id: number } | undefined;
  /** Work for after the event, from `defer`. */
  #deferred: (() => unknown)[] = [];
  /** Deferred tasks that have started and not finished. */
  #working = new Set<Promise<unknown>>();
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

  /**
   * The last seat was given up: nobody is in the room any more, whichever way
   * they went (they left, stayed away too long, were removed, or moved to
   * another room). `this.players` is empty. Nothing ends a room by itself, so
   * this is where to say what becomes of it: `deleteRoom()`, a timer that
   * deletes it unless somebody comes back, or nothing, for a room that waits
   * for its next players. Not called for a room nobody ever sat in.
   *
   * It runs as a hook of its own, straight after the one that emptied the
   * room. If it fails it alone is undone: the players are still gone.
   */
  protected onEmpty(): void {}

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
   * hibernate. The room does not tick while nobody is connected, unless
   * `ticksWhileEmpty()` says so.
   */
  protected shouldTick(): boolean {
    return true;
  }

  /**
   * Whether the simulation keeps running while nobody is connected, for a
   * match that has to reach its end whoever is watching. `shouldTick()` has
   * to agree. Checked like `shouldTick()`, so base it on the state.
   *
   * Give such a room an end. It is awake, and billed, for every second it
   * ticks, and nobody is there to notice one that never stops: have `onTick`
   * finish or delete the room when the match is over or has run too long.
   * After a deploy or a crash it carries on from its last save within
   * twenty seconds.
   */
  protected ticksWhileEmpty(): boolean {
    return false;
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
   * The players a matchmaker reserved this room for, or null if it was not
   * reserved. Only they can take a seat (players handed over from another
   * room aside), so a match can start once all of them have joined.
   */
  protected get invited(): readonly string[] | null {
    return this.#invited;
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
   * set `rooms`.
   *
   * A player who is not connected at that moment is sent on when they next
   * connect here.
   */
  protected movePlayer(playerId: string, toRoomId: string, carry?: unknown): void {
    if (!this.roomsFor(toRoomId) && this.handOver === Room.prototype.handOver) {
      throw new TypeError("movePlayer() needs `rooms` to be set");
    }
    const seat = this.#roster.indexOf(playerId);
    if (seat === -1) return;
    this.#roster.splice(seat, 1);
    this.#timers.delete(AWAY_TIMER + playerId);
    this.#moved.push({ player: playerId, to: toRoomId, carry: carry ?? null });
  }

  /**
   * Deliver a player to another room, through `roomsFor`. If it throws, the
   * handover is tried again on this room's next event.
   */
  protected async handOver(roomId: string, playerId: string, carry: unknown): Promise<void> {
    await this.#roomStub(roomId).tickflare({ op: "arrive", roomId, playerId, carry });
  }

  /**
   * A player handed over by another room takes their seat. `carry` is what
   * that room passed to `movePlayer`. Defaults to treating them as a new
   * player.
   */
  protected onArrive(player: Player, _carry: unknown): void {
    this.onJoin(player);
  }

  async #arrive(roomId: string, playerId: string, carry: unknown): Promise<void> {
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
  protected async act(hook: () => void): Promise<ActOutcome> {
    this.#load();
    const outcome = this.#apply(hook);
    await this.#finish();
    return outcome;
  }

  /**
   * Send a message to another room, which receives it in `onSignal`. It goes
   * out once after this hook has committed. It is not saved and not retried:
   * use it for things that are replaced by the next one anyway, such as a
   * snapshot of what is near a border. Call from inside a hook, and set
   * `rooms`.
   *
   * With `onlyIfWatched`, a room that reports nobody connected is left alone
   * for two seconds at a time, so an empty neighbour is not kept awake.
   */
  protected signal(roomId: string, data: unknown, options: { onlyIfWatched?: boolean } = {}): void {
    if (!this.roomsFor(roomId) && this.relay === Room.prototype.relay) {
      throw new TypeError("signal() needs `rooms` to be set");
    }
    // A signal goes out after the hook, so it takes a copy: what it was given may be part of the state.
    const copy: unknown = this.#tracker.active ? JSON.parse(JSON.stringify(data ?? null)) : (data ?? null);
    this.#signals.push({ to: roomId, data: copy, onlyIfWatched: options.onlyIfWatched === true });
  }

  /**
   * Deliver a signal to another room, through `roomsFor`, resolving to
   * whether anyone is connected there.
   */
  protected async relay(roomId: string, data: unknown): Promise<boolean> {
    const watched = await this.#roomStub(roomId).tickflare({ op: "signal", from: this.roomId, data });
    return watched === true;
  }

  /** Another room sent this one a message with `signal`. */
  protected onSignal(_fromRoomId: string, _data: unknown): void {}

  /**
   * How rooms and matchmakers reach each other over RPC: handing a player
   * over, delivering a signal, reserving a room for a match. Reserved for
   * Tickflare: don't call it, and don't name a method of your own `tickflare`.
   * @internal
   */
  async tickflare(call: RoomCall): Promise<unknown> {
    switch (call.op) {
      case "arrive":
        return this.#arrive(call.roomId, call.playerId, call.carry);
      case "signal":
        return this.#hear(call.from ?? "", call.data);
      case "reserve":
        return this.#reserve(call.roomId, call.players);
    }
  }

  /**
   * The namespace the room called `roomId` lives in. Defaults to `rooms`.
   * Override it when handovers and signals go to rooms of more than one
   * class, e.g. by the id's prefix.
   */
  protected roomsFor(_roomId: string): RoomNamespace | undefined {
    return this.rooms;
  }

  #roomStub(roomId: string): { tickflare(call: RoomCall): Promise<unknown> } {
    const rooms = this.roomsFor(roomId);
    if (!rooms) throw new TypeError("reaching another room needs `rooms` to be set");
    return rooms.get(rooms.idFromName(roomId)) as unknown as { tickflare(call: RoomCall): Promise<unknown> };
  }

  async #hear(fromRoomId: string, data: unknown): Promise<boolean> {
    this.#load();
    this.#apply(() => this.onSignal(fromRoomId, data));
    await this.#finish();
    return this.#seatedSockets().length > 0;
  }

  /**
   * A matchmaker is about to send a match's players here: the room is created
   * where the matchmaker asked for it and closed to everyone but `playerIds`.
   */
  async #reserve(roomId: string, playerIds: string[]): Promise<void> {
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

  /**
   * End this room for good. Shortly after the current event, everyone still
   * connected is disconnected with `CloseCode.Removed` and the reason
   * `"room_deleted"`, and everything the room stored is deleted: its state,
   * seats and timers, a lockstep recording, and any tables of your own. With
   * nothing stored the Durable Object itself ceases to exist.
   *
   * What the room still owes is delivered first: a finished match's result,
   * a player on their way to another room. Until it is, the room stays.
   * Work passed to `defer()` that is still running is given ten seconds to
   * finish.
   *
   * The room id is not used up. Someone who comes to it later finds a new,
   * empty room. Call from inside a hook.
   */
  protected deleteRoom(): void {
    this.#timers.set(DELETE_TIMER, Date.now());
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

  /** Durable Object entry point for connections and HTTP requests from the gateway. Tickflare's: override `onHttp` instead. */
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
      // While onHttp runs, the state is compared with `#committed.state` to see that it left it alone.
      this.#freshen();
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
    const asked = new URL(request.url).searchParams;
    const marks: string[] = [];
    if (asked.get("patches") === BINARY_PATCHES) marks.push(BINARY_TAG);
    if (Number(asked.get("v")) >= 2) marks.push(V2_TAG);
    const response = this.#connect(playerId, name, marks);
    await this.#finish();
    return response;
  }

  /** Durable Object entry point for incoming frames. Tickflare's: override `parseCommand` and `onCommand` instead. */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    this.#load();
    this.#receive(ws, message);
    await this.#finish();
  }

  /** Durable Object entry point for closed connections. Tickflare's: override `onDisconnect` instead. */
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

  /** Durable Object entry point for broken connections. Tickflare's: override `onDisconnect` instead. */
  override async webSocketError(ws: WebSocket): Promise<void> {
    this.#load();
    this.#dropped(ws);
    await this.#finish();
  }

  /** Durable Object entry point for the alarm that drives timers and retries. Tickflare's: override `onTimer` instead. */
  override async alarm(): Promise<void> {
    this.#load();
    // The alarm is always set for the earliest timer, so that one is due even
    // if this clock reads a little early.
    const now = Math.max(Date.now(), this.#nextTimer() ?? 0);
    const due = [...this.#timers]
      .filter(([, firesAt]) => firesAt <= now)
      .sort((a, b) => a[1] - b[1]);

    let doomed = false;
    for (const [name, firesAt] of due) {
      // A timer that fired earlier in this batch may have cleared or moved this one.
      if (this.#timers.get(name) !== firesAt) continue;
      // Deleting comes last, after everything else that is due and after what is owed has gone out.
      if (name === DELETE_TIMER) {
        doomed = true;
        continue;
      }
      // Waking the room is all this one is for. `#finish` moves it on, or drops it.
      if (name === AWAKE_TIMER) continue;
      // Spend the timer first, on its own, so a failing hook cannot bring it back.
      this.#apply(() => this.#timers.delete(name));
      if (name.startsWith(AWAY_TIMER)) this.#giveUpSeat(name.slice(AWAY_TIMER.length));
      // Saved at once, even while ticking: the timer is spent, so its effect must not be lost.
      else this.#apply(() => this.onTimer(name), true);
    }
    this.#alarmStale = true;
    await this.#finish();
    if (doomed) await this.#delete();
  }

  /** `deleteRoom()` was called, and its moment has come. */
  async #delete(): Promise<void> {
    // Deferred work that is under way gets to finish: it may be telling someone that this room is going.
    const patience = scheduler.wait(DELETE_PATIENCE_MS);
    while (this.#working.size > 0) {
      const waited = await Promise.race([Promise.allSettled([...this.#working]).then(() => true), patience.then(() => false)]);
      if (!waited) break;
    }
    if (this.#store.hasOutbox()) {
      // Something is still owed, and `#finish` has just failed to deliver it. Keep the room, and
      // let the next alarm try again.
      this.#apply(() => this.#timers.set(DELETE_TIMER, Date.now() + DELETE_RETRY_MS));
      this.#alarmStale = true;
      await this.#finish();
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(CloseCode.Removed, "room_deleted");
      } catch {
        // Already closed.
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Wait until the deletion is on disk. That is also when the close frames above are let out.
    await this.ctx.storage.sync();
    // Whatever this instance still holds in memory describes a room that is gone. Start over:
    // the next event, if one ever comes, finds a new room. Cloudflare logs the reason as an
    // uncaught error, so it says what it is.
    (this.ctx.abort as (reason?: string, options?: { retryAlarm?: boolean }) => void)(
      "deleteRoom(): this room deleted itself and its storage. Not a failure.",
      { retryAlarm: false },
    );
  }

  #connect(playerId: string, name: string | undefined, marks: string[] = []): Response {
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
    // What the client asked for is kept with the socket, where it outlasts the room's sleep.
    this.ctx.acceptWebSocket(server, [playerId, ...marks]);
    this.#welcome(server, player, this.#loop !== undefined);
    this.#broadcastPresence(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Sends a socket everything from the start: who they are, the players and their whole view. */
  #welcome(ws: WebSocket, player: Player, ticking: boolean): void {
    const welcome = JSON.stringify({
      t: "welcome",
      v: this.ctx.getTags(ws).includes(V2_TAG) ? PROTOCOL_VERSION : 1,
      you: player.id,
      seq: this.#seq,
      tick: this.#tick,
      tickRate: this.tickRate,
      state: this.view(player),
      players: this.players,
    } satisfies ServerMessage);
    ws.send(welcome);
    if (ticking || this.view !== Room.prototype.view) {
      // Remember exactly what this socket has, as a copy the room cannot touch. Outside the
      // simulation and without a custom view there is no need: it has the state as it is saved.
      this.#deltas.remember(ws, (JSON.parse(welcome) as { state: unknown }).state, this.#seq);
    }
  }

  /** Closes a player's open connections because a newer one is taking over. */
  #replaceSockets(playerId: string): void {
    for (const old of this.ctx.getWebSockets(playerId)) {
      this.#owed.delete(old);
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
    // While the simulation runs, what a command changed is sent with the next tick.
    const ticking = this.#loop !== undefined;
    if (frame.t === "leave") {
      outcome = this.#apply(() => {
        this.onLeave(player);
        this.removePlayer(playerId, "left");
      });
      // They are going: what they were still waiting to hear is said now.
      if (outcome.ok) this.#answer(ws);
    } else {
      let command: Command;
      try {
        command = this.parseCommand(frame.data);
      } catch (err) {
        const reason = err instanceof Rejection ? err.reason : "invalid_command";
        return this.#send(ws, { t: "reject", id: frame.id, reason });
      }
      // If this changes what the player sees, the frame that says so says whose command it shows.
      this.#answering = { ws, id: frame.id };
      try {
        outcome = this.#apply(() => this.onCommand(player, command));
      } finally {
        this.#answering = undefined;
      }
    }

    if (!outcome.ok) {
      return this.#send(ws, { t: "reject", id: frame.id, reason: outcome.reason });
    }
    if (ticking && frame.t === "cmd") {
      // An ack means "you have seen the result", and the result goes out with the tick.
      const owed = this.#owed.get(ws);
      if (owed) owed.push(frame.id);
      else this.#owed.set(ws, [frame.id]);
      return;
    }
    // The state frame, if any, has already gone out.
    this.#send(ws, { t: "ack", id: frame.id, seq: this.#seq });
  }

  /** Acks the commands `ws` is still owed an answer to, or everyone's. */
  #answer(ws?: WebSocket): void {
    if (this.#owed.size === 0) return;
    const owed = ws ? new Map([[ws, this.#owed.get(ws) ?? []]]) : this.#owed;
    if (ws) this.#owed.delete(ws);
    else this.#owed = new Map();
    for (const [to, ids] of owed) {
      for (const id of ids) this.#send(to, { t: "ack", id, seq: this.#seq, tick: this.#tick });
    }
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

    this.#stayAwake();
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
        .catch((err) => console.error("[tickflare] deferred task failed:", err))
        .finally(() => this.#working.delete(running));
      this.#working.add(running);
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

  /** Whether the simulation should be running now. `connected` is whether anybody is. */
  #wantsTicks(connected: boolean, evenIfStalled = false): boolean {
    if (this.tickRate <= 0 || (this.#stalled && !evenIfStalled)) return false;
    try {
      return this.shouldTick() === true && (connected || this.ticksWhileEmpty() === true);
    } catch (err) {
      console.error("[tickflare] shouldTick() or ticksWhileEmpty() failed:", err);
      return false;
    }
  }

  /**
   * A room that ticks with nobody connected keeps an alarm a few seconds
   * ahead of itself: see `AWAKE_TIMER`. A simulation that keeps failing is
   * woken too, since every alarm is an event and lets it try again.
   */
  #stayAwake(): void {
    const alone = this.#seatedSockets().length === 0 && this.#wantsTicks(false, true);
    const firesAt = this.#timers.get(AWAKE_TIMER);
    if (alone ? firesAt !== undefined && firesAt > Date.now() : firesAt === undefined) return;
    // Saved at once: if the room is taken out of memory, this is what brings it back.
    this.#apply(() => {
      if (alone) this.#timers.set(AWAKE_TIMER, Date.now() + AWAKE_MS);
      else this.#timers.delete(AWAKE_TIMER);
    }, true);
    this.#alarmStale = true;
  }

  /** Starts the simulation if it should be running and stops it if it should not. */
  #syncLoop(): void {
    const wanted = this.#wantsTicks(this.#seatedSockets().length > 0);
    if (wanted && this.#loop === undefined) {
      this.#loop = setInterval(() => this.#runTick(), 1000 / this.tickRate);
    } else if (!wanted && this.#loop !== undefined) {
      clearInterval(this.#loop);
      this.#loop = undefined;
      // Send what changed since the last tick, or it would never go out.
      this.#broadcastTick();
      if (this.#unsaved) this.#writeRoom();
    }
  }

  #runTick(): void {
    this.#tick += 1;
    const ticked = this.#apply(() => this.onTick(1 / this.tickRate), false, true);
    if (ticked.ok) {
      this.#failedTicks = 0;
    } else if (++this.#failedTicks >= MAX_FAILED_TICKS) {
      console.error("[tickflare] onTick keeps failing; the simulation is paused until the next event");
      this.#failedTicks = 0;
      this.#stalled = true;
    }

    if (++this.#ticksSinceSave * 1000 >= this.saveIntervalMs * this.tickRate) {
      this.#ticksSinceSave = 0;
      if (this.#unsaved) this.#writeRoom();
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
    // Rooms saved before the counter moved into the room's own row still have it here.
    this.#tick = Math.max(room?.tick ?? 0, Number(meta.get("tick") ?? 0));
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

    // A room that comes back with its simulation due and players connected was taken out of
    // memory while it ran. It resumes from its last save, which is older than what the players
    // hold, and whatever they were waiting to hear is gone with the old instance. So each of them
    // starts again from the whole view, as after a reconnect, without having to reconnect.
    if (this.tickRate > 0) {
      const sockets = this.#seatedSockets();
      if (sockets.length > 0 && this.#wantsTicks(true)) {
        for (const { ws, id } of sockets) {
          try {
            this.#welcome(ws, { id, connected: true }, true);
          } catch (err) {
            console.error(`[tickflare] could not send the state to ${id}:`, err);
          }
        }
      }
    }

    // Seats left by players who dropped while no timeout was running for them (the option was
    // added or shortened since, or the room was torn down mid-event) get one now.
    const adrift = this.#roster.filter((id) => !this.#timers.has(AWAY_TIMER + id) && !this.#isConnected(id));
    if (adrift.length > 0 && Number.isFinite(this.seatTimeoutMs)) {
      this.#apply(() => adrift.forEach((id) => this.#startSeatTimeout(id)));
    }
  }

  /** Puts state, seats and timers back to what was last committed. */
  #restore(): void {
    this.#state = JSON.parse(this.#committed.state) as State;
    this.#stale = false;
    this.#restoreSeats();
  }

  /** Puts seats and timers back to what was last committed. */
  #restoreSeats(): void {
    this.#roster = JSON.parse(this.#committed.roster) as string[];
    this.#timers = new Map(JSON.parse(this.#committed.timers) as [string, number][]);
  }

  /** Brings `#committed.state` up to date with the state. Throws if the state is not JSON. */
  #snapshot(): void {
    const state = JSON.stringify(this.#state);
    if (state === undefined) throw new TypeError("Room state must be JSON-serializable");
    this.#committed = { ...this.#committed, state };
    this.#stale = false;
  }

  /**
   * `#snapshot`, for where there is no hook to blame. A state that cannot be
   * turned into JSON got that way through a reference kept from outside a
   * hook, since what hooks write is checked as it is written. There is no
   * knowing which change it was, so the state goes back to the last JSON
   * there is.
   */
  #freshen(): void {
    if (!this.#stale) return;
    try {
      this.#snapshot();
    } catch (err) {
      console.error("[tickflare] the state can no longer be saved; going back to the last state that could:", err);
      this.#restore();
    }
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
      live = JSON.stringify(this.#state);
    } catch {
      // Not even serializable: certainly not what was committed.
    }
    if (live === this.#committed.state) return;
    console.error(
      "[tickflare] the state was changed outside a hook (in onHttp, or by a hook that returned a promise); the change was discarded",
    );
    this.#restore();
  }

  /** Writes the state as it is now. */
  #writeRoom(): void {
    this.#freshen();
    this.#store.atomically(() => this.#persist(this.#seq, this.#committed));
    this.#unsaved = false;
  }

  #persist(seq: number, committed: Committed): void {
    this.#store.writeRoom({ seq, state: committed.state, roster: committed.roster, tick: this.#tick });
  }

  /** Remembers the id this room is reached under, the first time it hears it. */
  #learnRoomId(roomId: string): void {
    if (this.#roomId === roomId) return;
    this.#roomId = roomId;
    this.#store.rememberRoomId(roomId);
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
   *
   * What the hook did to the state is known in one of two ways. A tracked
   * hook writes through proxies that note each write: the kernel knows at
   * once whether anything changed and how to undo it, and turns the state
   * into JSON only if this commit saves or sends it. Otherwise the whole
   * state is turned into JSON after the hook and compared with the JSON from
   * before, which is also what it is put back from. That is how `onTick`
   * runs (`plainly`), since a simulation reads far more than a proxy should
   * be asked to pass on, and how every hook runs with `trackChanges` off or
   * while something may be changing the state behind the kernel's back.
   */
  #apply(hook: () => void, durable = false, plainly = false): Outcome {
    if (this.#suspect || this.#reading > 0) this.#undoDrift();
    const removedBefore = this.#removed.length;
    const mailBefore = this.#mail.length;
    const deferredBefore = this.#deferred.length;
    this.#finished.length = 0;
    this.#moved.length = 0;
    this.#signals.length = 0;
    this.#saveAsked = false;
    const ticking = this.#loop !== undefined;
    const seated = this.#roster.length;
    const tracked = this.trackChanges && !plainly && !this.#suspect && this.#reading === 0;
    let committed = false;
    try {
      // Comparing needs a "before" that is up to date, and so does putting the state back from it.
      if (!tracked && this.#stale) this.#snapshot();
      const was = this.#committed;
      if (tracked) this.#tracker.begin();
      const { next, seq, stateChanged, saved, current } = this.#store.atomically(() => {
        const returned = hook() as unknown;
        if (isThenable(returned)) {
          returned.then(undefined, () => {});
          this.#suspect = true;
          throw new TypeError("Room hooks must be synchronous");
        }
        const roster = JSON.stringify(this.#roster);
        const timers = JSON.stringify([...this.#timers].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
        // Serialized before anything is written, so a value that cannot be is caught here.
        const owed = [
          ...this.#finished.map((finished) => JSON.stringify(finished satisfies OutboxEntry)),
          ...this.#moved.map((move) => JSON.stringify({ move } satisfies OutboxEntry)),
        ];
        const rosterChanged = roster !== was.roster;
        const timersChanged = timers !== was.timers;
        // What must never be in storage without the state it belongs to.
        const anchored = rosterChanged || timersChanged || owed.length > 0 || durable || this.#saveAsked;
        // Whether a state that is newer than storage is written by this commit.
        const writes = !ticking || anchored;

        // A tracked hook that wrote nothing changed nothing. One that did, while nothing needs
        // the state as JSON, is taken at its word, and `#committed.state` falls behind.
        const touched = !tracked || this.#tracker.changed;
        let state = was.state;
        let stateChanged = false;
        let current = !this.#stale;
        if (!tracked || ((touched || this.#stale) && writes)) {
          const json = JSON.stringify(this.#state);
          if (json === undefined) throw new TypeError("Room state must be JSON-serializable");
          stateChanged = touched && json !== was.state;
          state = json;
          current = true;
        } else if (touched) {
          stateChanged = true;
          current = false;
        }
        const next: Committed = { state, roster, timers };
        const seq = stateChanged ? this.#seq + 1 : this.#seq;
        const saved = rosterChanged || ((stateChanged || this.#unsaved) && writes);

        if (saved) this.#persist(seq, next);
        if (timersChanged) this.#store.replaceTimers(this.#timers);
        for (const body of owed) this.#store.addToOutbox(body);
        for (const move of this.#moved) this.#store.putForward(move.player, move.to);
        return { next, seq, stateChanged, saved, current };
      });
      this.#tracker.end();

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
      this.#stale = !current;
      committed = true;
      if (stateChanged && !ticking) this.#broadcastState(was.state);
      // No await between the two commits, so storage holds both or neither.
      if (seated > 0 && this.#roster.length === 0) this.#apply(() => this.onEmpty());
      return { ok: true };
    } catch (err) {
      if (committed) {
        // The hook's changes stand. What failed came after them: telling the players.
        console.error("[tickflare] could not send the state:", err);
        return { ok: true };
      }
      if (this.#tracker.active) {
        this.#tracker.undo();
        this.#restoreSeats();
      } else {
        this.#restore();
      }
      this.#removed.length = removedBefore;
      this.#mail.length = mailBefore;
      this.#deferred.length = deferredBefore;
      this.#finished.length = 0;
      this.#moved.length = 0;
      this.#signals.length = 0;
      // From here on every hook compares against `#committed.state`, so it has to be current.
      if (this.#suspect) this.#freshen();
      if (err instanceof Rejection) return { ok: false, reason: err.reason };
      console.error("[tickflare] room hook failed:", err);
      if (tracked && (err as { name?: unknown } | null)?.name === "DataCloneError") {
        console.error(
          "[tickflare] inside a hook, `this.state` and what is read from it are proxies, which cannot be cloned. Use `plain(value)` from tickflare to get the object itself.",
        );
      }
      return { ok: false, reason: "internal_error" };
    } finally {
      this.#connecting = null;
    }
  }

  /**
   * Sends everyone what this change did to their view. Used outside the
   * simulation, where every change is sent as it is made.
   *
   * `before` is the state as JSON as it was before the change. Without a
   * custom view that is what every seated socket holds, since each was sent
   * every change so far, so a socket nothing is known about (the room has
   * slept since, or the socket has just joined) can still be sent a patch.
   * With a custom view only what was actually sent to a socket will do, and
   * one that nothing is known about gets its whole view.
   */
  #broadcastState(before: string): void {
    const sockets = this.#seatedSockets();
    if (sockets.length === 0) return;
    const custom = this.view !== Room.prototype.view;
    // Not for a room that is about to simulate again: one that was taken out of memory in the
    // middle of a simulation saved its state some ticks before its players last heard from it.
    if (!custom && !this.#deltas.knows(sockets) && !this.#wantsTicks(true)) {
      this.#deltas.seed(sockets, this.#seq - 1, () => JSON.parse(before) as unknown);
    }
    const answering = this.#answering;
    this.#deltas.send(
      sockets,
      this.#seq,
      this.#tick,
      this.#state,
      custom ? (id) => this.view({ id, connected: true }) : undefined,
      true,
      answering && new Map([[answering.ws, answering.id]]),
    );
  }

  /** Sends everyone what changed in their view since the last tick. */
  #broadcastTick(): void {
    const custom = this.view !== Room.prototype.view;
    // Commands handled since the last tick: this is the state that shows them.
    let shows: Map<WebSocket, number> | undefined;
    if (this.#owed.size > 0) {
      shows = new Map();
      for (const [ws, ids] of this.#owed) shows.set(ws, ids[ids.length - 1]!);
    }
    this.#deltas.send(
      this.#seatedSockets(),
      this.#seq,
      this.#tick,
      this.#state,
      custom ? (id) => this.view({ id, connected: true }) : undefined,
      false,
      shows,
    );
    this.#answer();
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
  #seatedSockets(): SeatedSocket[] {
    const sockets: SeatedSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const tags = this.ctx.getTags(ws);
      const id = tags.find((tag) => !isMark(tag));
      if (id && ws.readyState === SOCKET_OPEN && this.#roster.includes(id)) {
        sockets.push(
          tags.length > 1 ? { ws, id, binary: tags.includes(BINARY_TAG), arrays: tags.includes(V2_TAG) } : { ws, id },
        );
      }
    }
    return sockets;
  }

  #playerOf(ws: WebSocket): string | undefined {
    return this.ctx.getTags(ws).find((tag) => !isMark(tag));
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
