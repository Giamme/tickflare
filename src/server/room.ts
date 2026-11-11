import { DurableObject } from "cloudflare:workers";
import {
  CloseCode,
  PING,
  PONG,
  PROTOCOL_VERSION,
  type Player,
  type ServerMessage,
} from "../protocol.js";
import { PLAYER_HEADER } from "./gateway.js";

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
/** Close reasons are limited to 123 bytes by the WebSocket protocol. */
const MAX_CLOSE_REASON = 120;

/**
 * An authoritative game room in event mode: one Durable Object per room.
 *
 * There is no tick loop. The room wakes when a player connects, sends a
 * command, drops or leaves, or when a timer fires. It runs the matching hook,
 * saves what changed and sends each connected player their view of the state.
 * Between events it hibernates while the WebSockets stay open, and rebuilds
 * itself from storage on the next event.
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
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const playerId = request.headers.get(PLAYER_HEADER);
    if (!playerId) {
      return new Response("Missing player identity", { status: 401 });
    }
    this.#load();
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

    this.#send(server, {
      t: "welcome",
      v: PROTOCOL_VERSION,
      you: playerId,
      seq: this.#seq,
      state: this.view(player),
      players: this.players,
    });
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

  /** The end of every event: close the sockets of removed players and move the alarm. */
  async #finish(): Promise<void> {
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

  /**
   * Runs a hook, then commits what it changed: saves it and, if the state
   * changed, broadcasts the state. If the hook fails, everything it touched is
   * put back and the reason is returned.
   */
  #apply(hook: () => void): Outcome {
    const removedBefore = this.#removed.length;
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
      const stateChanged = next.state !== was.state;
      const seq = stateChanged ? this.#seq + 1 : this.#seq;

      const sql = this.ctx.storage.sql;
      if (stateChanged || next.roster !== was.roster) {
        sql.exec(
          "INSERT OR REPLACE INTO tickflare_room (id, seq, state, players) VALUES (1, ?, ?, ?)",
          seq,
          next.state,
          next.roster,
        );
      }
      if (next.timers !== was.timers) {
        sql.exec("DELETE FROM tickflare_timers");
        for (const [name, firesAt] of this.#timers) {
          sql.exec("INSERT INTO tickflare_timers (name, fire_at) VALUES (?, ?)", name, firesAt);
        }
        this.#alarmStale = true;
      }

      this.#seq = seq;
      this.#committed = next;
      if (stateChanged) this.#broadcastState();
      return { ok: true };
    } catch (err) {
      this.#restore();
      this.#removed.length = removedBefore;
      if (err instanceof Rejection) return { ok: false, reason: err.reason };
      console.error("[tickflare] room hook failed:", err);
      return { ok: false, reason: "internal_error" };
    }
  }

  #broadcastState(): void {
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
