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

/** Thrown by a hook to refuse a command or a join. The reason is sent to the client. */
export class Rejection extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "Rejection";
    this.reason = reason;
  }
}

/** Refuse the current command or join. Any state changes made by the hook are rolled back. */
export function reject(reason: string): never {
  throw new Rejection(reason);
}

type Outcome = { ok: true } | { ok: false; reason: string };

type StoredRoom = { seq: number; state: string; players: string };

const SOCKET_OPEN = 1;
/** Close reasons are limited to 123 bytes by the WebSocket protocol. */
const MAX_CLOSE_REASON = 120;

/**
 * An authoritative game room in event mode: one Durable Object per room.
 *
 * There is no tick loop. The room wakes when a player connects, sends a
 * command or drops, runs the matching hook, saves the state and sends each
 * connected player their view of it. Between events it hibernates while the
 * WebSockets stay open, and rebuilds itself from storage on the next event.
 *
 * Hooks are synchronous and change `this.state` in place. The state must be
 * JSON-serializable.
 */
export abstract class Room<State, Command = unknown, Env = Cloudflare.Env> extends DurableObject<Env> {
  /** How many distinct players may take a seat. */
  protected maxPlayers = Number.POSITIVE_INFINITY;

  /** Longest client frame accepted, in characters. */
  protected maxMessageLength = 16 * 1024;

  /** The authoritative state. Change it only inside hooks. */
  protected state!: State;

  #loaded = false;
  #seq = 0;
  #roster: string[] = [];
  /** JSON of the state as last committed; what a failed hook rolls back to. */
  #committed = "";

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

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const playerId = request.headers.get(PLAYER_HEADER);
    if (!playerId) {
      return new Response("Missing player identity", { status: 401 });
    }
    this.#load();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const player: Player = { id: playerId, connected: true };

    if (!this.#roster.includes(playerId)) {
      if (this.#roster.length >= this.maxPlayers) {
        return refuse(client, server, CloseCode.RoomFull, "room_full");
      }
      this.#roster.push(playerId);
      const joined = this.#apply(() => this.onJoin(player), true);
      if (!joined.ok) {
        this.#roster.pop();
        return refuse(client, server, CloseCode.JoinRejected, joined.reason);
      }
    } else if (!this.#isConnected(playerId)) {
      this.#apply(() => this.onReconnect(player));
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

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.#load();
    const playerId = this.#playerOf(ws);
    if (!playerId) return;

    if (typeof message !== "string") {
      return this.#send(ws, { t: "error", reason: "binary_not_supported" });
    }
    if (message.length > this.maxMessageLength) {
      return this.#send(ws, { t: "error", reason: "message_too_large" });
    }

    let frame: unknown;
    try {
      frame = JSON.parse(message);
    } catch {
      return this.#send(ws, { t: "error", reason: "invalid_json" });
    }
    if (!isCommandFrame(frame)) {
      return this.#send(ws, { t: "error", reason: "invalid_message" });
    }

    let command: Command;
    try {
      command = this.parseCommand(frame.data);
    } catch (err) {
      const reason = err instanceof Rejection ? err.reason : "invalid_command";
      return this.#send(ws, { t: "reject", id: frame.id, reason });
    }

    const applied = this.#apply(() => this.onCommand({ id: playerId, connected: true }, command));
    if (!applied.ok) {
      return this.#send(ws, { t: "reject", id: frame.id, reason: applied.reason });
    }
    // The state frame, if any, has already gone out: an ack means "you have seen the result".
    this.#send(ws, { t: "ack", id: frame.id, seq: this.#seq });
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    // Runtimes with a compatibility date before 2026-04-07 need the close echoed back.
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
    this.#dropped(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.#dropped(ws);
  }

  #dropped(ws: WebSocket): void {
    this.#load();
    const playerId = this.#playerOf(ws);
    if (!playerId || !this.#roster.includes(playerId)) return;
    // A newer connection for the same player took over: nothing to announce.
    if (this.#isConnected(playerId, ws)) return;

    this.#apply(() => this.onDisconnect({ id: playerId, connected: false }));
    this.#broadcastPresence(ws);
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
    const stored = sql
      .exec<StoredRoom>("SELECT seq, state, players FROM tickflare_room WHERE id = 1")
      .toArray()[0];

    if (stored) {
      this.#seq = stored.seq;
      this.#committed = stored.state;
      this.#roster = JSON.parse(stored.players) as string[];
    } else {
      const initial = JSON.stringify(this.initialState());
      if (initial === undefined) {
        throw new TypeError("initialState() must return a JSON-serializable value");
      }
      this.#committed = initial;
    }
    // Always start from the JSON round-trip, so new and resumed rooms behave the same.
    this.state = JSON.parse(this.#committed) as State;
    this.#loaded = true;
  }

  #save(): void {
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO tickflare_room (id, seq, state, players) VALUES (1, ?, ?, ?)",
      this.#seq,
      this.#committed,
      JSON.stringify(this.#roster),
    );
  }

  /**
   * Runs a hook. If it changed the state, the change is saved and broadcast.
   * If it threw, the state is put back as it was. `save` forces a write even
   * when the state is unchanged, for callers that changed the roster.
   */
  #apply(hook: () => void, save = false): Outcome {
    try {
      const returned = hook() as unknown;
      if (isThenable(returned)) {
        returned.then(undefined, () => {});
        throw new TypeError("Room hooks must be synchronous");
      }
      const json = JSON.stringify(this.state);
      if (json === undefined) {
        throw new TypeError("Room state must be JSON-serializable");
      }
      const changed = json !== this.#committed;
      if (changed) {
        this.#committed = json;
        this.#seq += 1;
      }
      if (changed || save) this.#save();
      if (changed) this.#broadcastState();
      return { ok: true };
    } catch (err) {
      this.state = JSON.parse(this.#committed) as State;
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

    for (const ws of this.ctx.getWebSockets()) {
      const id = this.#playerOf(ws);
      if (!id) continue;
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
        // A closing socket, or a view() that threw: don't let it starve the others.
        console.error(`[tickflare] could not send state to ${id}:`, err);
      }
    }
  }

  #broadcastPresence(except?: WebSocket): void {
    const frame = JSON.stringify({ t: "presence", players: this.players });
    for (const ws of this.ctx.getWebSockets()) {
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

  #playerOf(ws: WebSocket): string | undefined {
    return this.ctx.getTags(ws)[0];
  }

  #isConnected(playerId: string, except?: WebSocket): boolean {
    return this.ctx
      .getWebSockets(playerId)
      .some((ws) => ws !== except && ws.readyState === SOCKET_OPEN);
  }
}

/** Completes the upgrade, then closes straight away so the client learns why. */
function refuse(client: WebSocket, server: WebSocket, code: number, reason: string): Response {
  server.accept();
  server.close(code, reason.slice(0, MAX_CLOSE_REASON));
  return new Response(null, { status: 101, webSocket: client });
}

function isCommandFrame(value: unknown): value is { t: "cmd"; id: number; data: unknown } {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as { t?: unknown; id?: unknown };
  return frame.t === "cmd" && Number.isSafeInteger(frame.id);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown } | null | undefined)?.then === "function";
}
