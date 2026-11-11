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
import { applyPatch, diff } from "../patch.js";
import { PLAYER_HEADER, ROOM_HEADER } from "./gateway.js";

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

type ClientFrame = { t: "cmd"; id: number; data: unknown } | { t: "leave"; id: number };

type StoredRoom = { seq: number; state: string; players: string };
type StoredTimer = { name: string; fire_at: number };

/** Everything a hook may change, as JSON. A hook that fails is rolled back to this. */
interface Committed {
  state: string;
  roster: string;
  timers: string;
}

const SOCKET_OPEN = 1;
/** Consecutive failed ticks after which the simulation pauses until the next event. */
const MAX_FAILED_TICKS = 5;
/** Close reasons are limited to 123 bytes by the WebSocket protocol. */
const MAX_CLOSE_REASON = 120;

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
  /** Finished matches announced by the current hook, not yet committed. */
  #finished: { message: MatchResult; replay?: string }[] = [];
  /** There are finished matches in storage that still have to reach the queue. */
  #outboxPending = false;

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
  /** What each socket was last sent, to diff the next tick against. */
  #baselines = new Map<WebSocket, unknown>();
  /** The `seq` of the last tick broadcast. */
  #sentSeq = -1;

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
   * A player asked to give up their seat. Tidy up after them here; they are
   * removed when this returns. Call `reject()` to make them stay.
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
    return this.#roster.map((id) => ({ id, connected: this.#isConnected(id) }));
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
   * Called by a matchmaker, over RPC, before a match's players arrive. It
   * creates the room where the matchmaker asked for it and closes it to
   * everyone but `playerIds`.
   */
  async reserve(roomId: string, playerIds: string[]): Promise<void> {
    this.#load();
    this.#roomId = roomId;
    this.#invited = [...playerIds];
    const sql = this.ctx.storage.sql;
    sql.exec("INSERT OR REPLACE INTO tickflare_meta (key, value) VALUES ('room', ?)", roomId);
    sql.exec("INSERT OR REPLACE INTO tickflare_meta (key, value) VALUES ('invited', ?)", JSON.stringify(playerIds));
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
    this.#removed.push({ id: playerId, reason });
  }

  override async fetch(request: Request): Promise<Response> {
    const playerId = request.headers.get(PLAYER_HEADER);
    if (!playerId) {
      return new Response("Missing player identity", { status: 401 });
    }
    this.#load();
    const roomId = request.headers.get(ROOM_HEADER);
    if (roomId && roomId !== this.#roomId) {
      this.#roomId = roomId;
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO tickflare_meta (key, value) VALUES ('room', ?)", roomId);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return this.onHttp(request, { id: playerId, connected: this.#isConnected(playerId) });
    }
    const response = this.#connect(playerId);
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
      this.#apply(() => this.clearTimer(name));
      this.#apply(() => this.onTimer(name));
    }
    this.#alarmStale = true;
    await this.#finish();
  }

  #connect(playerId: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const player: Player = { id: playerId, connected: true };

    if (!this.#roster.includes(playerId)) {
      if (this.#invited && !this.#invited.includes(playerId)) {
        return refuse(client, server, CloseCode.JoinRejected, "not_invited");
      }
      if (this.#roster.length >= this.maxPlayers) {
        return refuse(client, server, CloseCode.RoomFull, "room_full");
      }
      const joined = this.#apply(() => {
        this.#roster.push(playerId);
        this.onJoin(player);
      });
      if (!joined.ok) {
        return refuse(client, server, CloseCode.JoinRejected, joined.reason);
      }
    } else if (!this.#isConnected(playerId)) {
      this.#apply(() => this.onReconnect(player));
    }
    // A hook may have removed the very player who is connecting.
    if (!this.#roster.includes(playerId)) {
      const reason = this.#removed.find((seat) => seat.id === playerId)?.reason ?? "removed";
      return refuse(client, server, CloseCode.Removed, reason);
    }

    // One connection per player: the newest wins.
    for (const old of this.ctx.getWebSockets(playerId)) {
      old.close(CloseCode.Replaced, "replaced");
    }
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
      this.#baselines.set(server, (JSON.parse(welcome) as { state: unknown }).state);
    }
    this.#broadcastPresence(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  #receive(ws: WebSocket, message: string | ArrayBuffer): void {
    const playerId = this.#playerOf(ws);
    // A socket whose seat is gone is about to be closed; ignore what it still sends.
    if (!playerId || !this.#roster.includes(playerId)) return;

    if (typeof message !== "string") {
      return this.#send(ws, { t: "error", reason: "binary_not_supported" });
    }
    if (message.length > this.maxMessageLength) {
      return this.#send(ws, { t: "error", reason: "message_too_large" });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return this.#send(ws, { t: "error", reason: "invalid_json" });
    }
    const frame = readFrame(parsed);
    if (!frame) {
      return this.#send(ws, { t: "error", reason: "invalid_message" });
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
    // A newer connection for the same player took over: nothing to announce.
    if (this.#isConnected(playerId, ws)) return;

    this.#apply(() => this.onDisconnect({ id: playerId, connected: false }));
    this.#broadcastPresence(ws);
  }

  /**
   * The end of every event and every tick: close the sockets of removed
   * players, move the alarm, and start or stop the simulation.
   */
  async #finish(afterEvent = true): Promise<void> {
    if (this.#removed.length > 0) {
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

    if (this.#outboxPending) await this.#sendFinished();

    if (afterEvent) this.#stalled = false;
    this.#syncLoop();
  }

  /** Delivers finished matches that are waiting in storage: replay to R2, then the message to the queue. */
  async #sendFinished(): Promise<void> {
    const sql = this.ctx.storage.sql;
    const waiting = sql
      .exec<{ id: number; body: string }>("SELECT id, body FROM tickflare_outbox ORDER BY id")
      .toArray();
    try {
      for (const row of waiting) {
        const { message, replay } = JSON.parse(row.body) as { message: MatchResult; replay?: string };
        if (replay !== undefined && message.replayKey && this.matchBucket) {
          await this.matchBucket.put(message.replayKey, replay, {
            httpMetadata: { contentType: "application/json" },
          });
        }
        await this.matchQueue?.send(message);
        sql.exec("DELETE FROM tickflare_outbox WHERE id = ?", row.id);
      }
      this.#outboxPending = false;
    } catch (err) {
      // Left in storage; the next event tries again.
      console.error("[tickflare] could not announce a finished match:", err);
    }
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
      this.#baselines.clear();
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
    if (this.#loaded) return;
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS tickflare_room (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         seq INTEGER NOT NULL,
         state TEXT NOT NULL,
         players TEXT NOT NULL
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS tickflare_timers (
         name TEXT PRIMARY KEY,
         fire_at INTEGER NOT NULL
       )`,
    );
    sql.exec("CREATE TABLE IF NOT EXISTS tickflare_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS tickflare_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
    const room = sql
      .exec<StoredRoom>("SELECT seq, state, players FROM tickflare_room WHERE id = 1")
      .toArray()[0];
    const timers = sql
      .exec<StoredTimer>("SELECT name, fire_at FROM tickflare_timers ORDER BY name")
      .toArray()
      .map((timer) => [timer.name, timer.fire_at]);

    let state: string;
    if (room) {
      state = room.state;
    } else {
      state = JSON.stringify(this.initialState());
      if (state === undefined) {
        throw new TypeError("initialState() must return a JSON-serializable value");
      }
    }
    const meta = new Map(
      sql
        .exec<{ key: string; value: string }>("SELECT key, value FROM tickflare_meta")
        .toArray()
        .map((row) => [row.key, row.value]),
    );
    this.#tick = Number(meta.get("tick") ?? 0);
    this.#roomId = meta.get("room") ?? null;
    this.#invited = meta.has("invited") ? (JSON.parse(meta.get("invited")!) as string[]) : null;
    this.#outboxPending = sql.exec("SELECT 1 FROM tickflare_outbox LIMIT 1").toArray().length > 0;
    this.#seq = room?.seq ?? 0;
    this.#committed = { state, roster: room?.players ?? "[]", timers: JSON.stringify(timers) };
    // Start from the JSON round-trip, so new and resumed rooms behave the same.
    this.#restore();
    this.#loaded = true;
  }

  /** Puts state, seats and timers back to what was last committed. */
  #restore(): void {
    this.state = JSON.parse(this.#committed.state) as State;
    this.#roster = JSON.parse(this.#committed.roster) as string[];
    this.#timers = new Map(JSON.parse(this.#committed.timers) as [string, number][]);
  }

  #writeRoom(seq: number, committed: Committed): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "INSERT OR REPLACE INTO tickflare_room (id, seq, state, players) VALUES (1, ?, ?, ?)",
      seq,
      committed.state,
      committed.roster,
    );
    if (this.tickRate > 0) {
      sql.exec("INSERT OR REPLACE INTO tickflare_meta (key, value) VALUES ('tick', ?)", String(this.#tick));
    }
    this.#unsaved = false;
  }

  /**
   * Runs a hook, then commits what it changed. If the hook fails, everything
   * it touched is put back and the reason is returned.
   *
   * Outside the simulation a commit is saved and broadcast at once. While the
   * room is ticking, state changes are only kept in memory here: the next tick
   * sends them and the save interval writes them. Seats and timers are always
   * saved at once.
   */
  #apply(hook: () => void): Outcome {
    const removedBefore = this.#removed.length;
    this.#finished.length = 0;
    try {
      const returned = hook() as unknown;
      if (isThenable(returned)) {
        returned.then(undefined, () => {});
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
      const was = this.#committed;
      const ticking = this.#loop !== undefined;
      const stateChanged = next.state !== was.state;
      const seq = stateChanged ? this.#seq + 1 : this.#seq;

      const sql = this.ctx.storage.sql;
      if (next.roster !== was.roster || (stateChanged && !ticking)) {
        this.#writeRoom(seq, next);
      } else if (stateChanged) {
        this.#unsaved = true;
      }
      if (next.timers !== was.timers) {
        sql.exec("DELETE FROM tickflare_timers");
        for (const [name, firesAt] of this.#timers) {
          sql.exec("INSERT INTO tickflare_timers (name, fire_at) VALUES (?, ?)", name, firesAt);
        }
        this.#alarmStale = true;
      }

      for (const finished of this.#finished.splice(0)) {
        sql.exec("INSERT INTO tickflare_outbox (body) VALUES (?)", JSON.stringify(finished));
        this.#outboxPending = true;
      }

      this.#seq = seq;
      this.#committed = next;
      if (stateChanged && !ticking) this.#broadcastState();
      return { ok: true };
    } catch (err) {
      this.#restore();
      this.#removed.length = removedBefore;
      this.#finished.length = 0;
      if (err instanceof Rejection) return { ok: false, reason: err.reason };
      console.error("[tickflare] room hook failed:", err);
      return { ok: false, reason: "internal_error" };
    }
  }

  /** Sends everyone their whole view. Used outside the simulation. */
  #broadcastState(): void {
    // Whatever the sockets were sent during an earlier simulation is now out of date.
    this.#baselines.clear();
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
    const sockets = this.#seatedSockets();
    if (
      !custom &&
      this.#seq === this.#sentSeq &&
      sockets.every(({ ws }) => this.#baselines.has(ws))
    ) {
      return;
    }

    const baselines = new Map<WebSocket, unknown>();
    // Without a custom view, sockets that were last sent the same snapshot share one diff,
    // and everyone ends the tick on the same snapshot.
    const shared = new Map<unknown, { frame?: string; next: unknown }>();
    let common: { next: unknown } | undefined;

    for (const { ws, id } of sockets) {
      try {
        const base = this.#baselines.get(ws);
        let update = custom || base === undefined ? undefined : shared.get(base);
        if (!update) {
          update = this.#tickFrame(base, custom ? this.view({ id, connected: true }) : this.state);
          if (!custom) {
            if (common) update.next = common.next;
            else common = update;
            if (base !== undefined) shared.set(base, update);
          }
        }
        if (update.frame) ws.send(update.frame);
        baselines.set(ws, update.next);
      } catch (err) {
        // A view() that threw must not starve the other players.
        console.error(`[tickflare] could not send the tick to ${id}:`, err);
      }
    }
    this.#baselines = baselines;
    this.#sentSeq = this.#seq;
  }

  /** The frame that brings a socket from `base` to `live`, and the snapshot it will then hold. */
  #tickFrame(base: unknown, live: unknown): { frame?: string; next: unknown } {
    const head = `"seq":${this.#seq},"tick":${this.#tick}`;
    if (base !== undefined) {
      const patch = diff(base, live);
      if (patch === undefined) return { next: base };
      if (patch !== null) {
        const json = JSON.stringify(patch);
        return {
          frame: `{"t":"patch",${head},"p":${json}}`,
          next: applyPatch(base, JSON.parse(json)),
        };
      }
    }
    const json = JSON.stringify(live) ?? "null";
    return { frame: `{"t":"state",${head},"state":${json}}`, next: JSON.parse(json) };
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

/** Completes the upgrade, then closes straight away so the client learns why. */
function refuse(client: WebSocket, server: WebSocket, code: number, reason: string): Response {
  server.accept();
  server.close(code, reason.slice(0, MAX_CLOSE_REASON));
  return new Response(null, { status: 101, webSocket: client });
}

function readFrame(value: unknown): ClientFrame | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const frame = value as { t?: unknown; id?: unknown; data?: unknown };
  if (!Number.isSafeInteger(frame.id)) return undefined;
  const id = frame.id as number;
  if (frame.t === "cmd") return { t: "cmd", id, data: frame.data };
  if (frame.t === "leave") return { t: "leave", id };
  return undefined;
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}
