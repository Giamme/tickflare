import { DurableObject } from "cloudflare:workers";
import { CloseCode, PING, PONG, type MatchFound } from "../protocol.js";
import { HINT_HEADER, PLAYER_HEADER } from "./gateway.js";

interface Waiting {
  player: string;
  hint: string | null;
  /** When the player started waiting, in epoch milliseconds. */
  since: number;
}

/**
 * Puts waiting players together into matches. One Durable Object per queue
 * name.
 *
 * A player waits by holding a WebSocket open. As soon as `matchSize` players
 * are waiting, the matchmaker picks a new room id, reserves the room for
 * them, tells each of them where to go and closes their sockets. The queue
 * is the set of open sockets, so the object hibernates while people wait.
 */
export abstract class Matchmaker<Env = Cloudflare.Env> extends DurableObject<Env> {
  /** Players per match. */
  protected matchSize = 2;

  /**
   * The fewest players a match may start with once the longest-waiting
   * player has waited `maxWaitMs`. Defaults to `matchSize`: full matches only.
   */
  protected minPlayers: number | undefined;

  /**
   * How long the longest-waiting player waits for a full match before one
   * starts with whoever is there, provided that is at least `minPlayers`.
   * 0, the default, waits for a full match however long it takes.
   */
  protected maxWaitMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * Set the room up for these players. Typically:
   *
   *     const stub = this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId), { locationHint });
   *     await stub.reserve(roomId, players);
   *
   * `locationHint` is where most of the players are; passing it to `get`
   * places the new room near them.
   */
  protected abstract reserveRoom(
    roomId: string,
    players: string[],
    locationHint: DurableObjectLocationHint | undefined,
  ): Promise<void>;

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const player = request.headers.get(PLAYER_HEADER);
    if (!player) {
      return new Response("Missing player identity", { status: 401 });
    }

    // A player waits once: a newer request replaces the older one.
    for (const old of this.ctx.getWebSockets(player)) {
      old.close(CloseCode.Replaced, "replaced");
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [player]);
    pair[1].serializeAttachment({
      player,
      hint: request.headers.get(HINT_HEADER),
      since: Date.now(),
    } satisfies Waiting);

    await this.#match();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }

  /** The wait is over for whoever is in the queue. */
  override async alarm(): Promise<void> {
    await this.#match();
  }

  /** Forms as many matches as the waiting players allow, longest wait first. */
  async #match(): Promise<void> {
    const queue = this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === 1)
      .map((ws) => ({ ws, ...(ws.deserializeAttachment() as Waiting) }))
      .sort((a, b) => a.since - b.since);

    while (queue.length >= this.matchSize) {
      if (!(await this.#start(queue.splice(0, this.matchSize)))) return;
    }

    const fewest = this.minPlayers ?? this.matchSize;
    if (this.maxWaitMs <= 0 || fewest >= this.matchSize) return;
    const longest = queue[0];
    if (!longest || queue.length < fewest) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const due = longest.since + this.maxWaitMs;
    if (Date.now() < due) {
      await this.ctx.storage.setAlarm(due);
    } else {
      await this.ctx.storage.deleteAlarm();
      await this.#start(queue.splice(0));
    }
  }

  /** Reserves a room for the group and sends them there. False if the room could not be reserved. */
  async #start(group: (Waiting & { ws: WebSocket })[]): Promise<boolean> {
    const players = group.map((waiting) => waiting.player);
    const room = crypto.randomUUID();
    try {
      await this.reserveRoom(room, players, mostCommonHint(group));
    } catch (err) {
      // They keep waiting; the next arrival tries again.
      console.error("[tickflare] could not reserve a room:", err);
      return false;
    }
    const found = JSON.stringify({ t: "match", room, players } satisfies MatchFound);
    for (const { ws } of group) {
      try {
        ws.send(found);
        ws.close(1000, "matched");
      } catch {
        // The player gave up at the last moment. Their seat stays reserved.
      }
    }
    return true;
  }
}

function mostCommonHint(group: Waiting[]): DurableObjectLocationHint | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  for (const { hint } of group) {
    if (!hint) continue;
    const count = (counts.get(hint) ?? 0) + 1;
    counts.set(hint, count);
    if (best === undefined || count > counts.get(best)!) best = hint;
  }
  return best as DurableObjectLocationHint | undefined;
}
