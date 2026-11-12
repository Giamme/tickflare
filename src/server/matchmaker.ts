import { DurableObject } from "cloudflare:workers";
import { CloseCode, PING, PONG, type MatchFound } from "../protocol.js";
import { HINT_HEADER, PLAYER_HEADER, type RoomNamespace } from "./gateway.js";
import type { RoomCall } from "./room.js";

interface Waiting {
  player: string;
  hint: string | null;
  /** When the player started waiting, in epoch milliseconds. */
  since: number;
  /** Place in the queue. Two players can arrive in the same millisecond; this still tells them apart. */
  order: number;
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

  /**
   * Where the rooms for matches are: the Durable Object namespace of your
   * `Room` class. `protected override rooms = this.env.ROOMS;`
   */
  protected rooms: RoomNamespace | undefined;

  /** A pass over the queue is under way. */
  #matching = false;
  /** Someone arrived or the wait ran out during that pass, so the queue needs another look. */
  #again = false;
  /** Reservations that failed in a row. Spaces out the next try. */
  #failures = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /**
   * Set the room up for these players. The default creates it in `rooms`,
   * near `locationHint` (where most of the players are), and closes it to
   * everyone else. Override it to do more first, such as writing down the
   * match, and call `super.reserveRoom` from yours. If it throws, the players
   * keep waiting and the match is tried again shortly.
   */
  protected async reserveRoom(
    roomId: string,
    players: string[],
    locationHint: DurableObjectLocationHint | undefined,
  ): Promise<void> {
    const rooms = this.rooms;
    if (!rooms) throw new TypeError("a matchmaker needs `rooms` to be set");
    const stub = rooms.get(rooms.idFromName(roomId), locationHint ? { locationHint } : undefined) as unknown as {
      tickflare(call: RoomCall): Promise<unknown>;
    };
    await stub.tickflare({ op: "reserve", roomId, players });
  }

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
    const last = Math.max(
      0,
      ...this.ctx.getWebSockets().map((ws) => (ws.deserializeAttachment() as Waiting | null)?.order ?? 0),
    );
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [player]);
    pair[1].serializeAttachment({
      player,
      hint: request.headers.get(HINT_HEADER),
      since: Date.now(),
      order: last + 1,
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

  /**
   * Forms as many matches as the waiting players allow, longest wait first.
   *
   * Reserving a room takes a moment, and players come and go meanwhile. So
   * only one pass runs at a time: whoever calls during a pass asks for the
   * queue to be looked at again when that pass is done, with whoever is
   * waiting by then.
   */
  async #match(): Promise<void> {
    if (this.#matching) {
      this.#again = true;
      return;
    }
    this.#matching = true;
    try {
      do {
        this.#again = false;
        if ((await this.#pass()) === "changed") this.#again = true;
      } while (this.#again);
    } finally {
      this.#matching = false;
    }
  }

  /** One look at the queue. "changed" means it has to be looked at again from the start. */
  async #pass(): Promise<"done" | "changed"> {
    const queue = this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === 1)
      .map((ws) => ({ ws, ...(ws.deserializeAttachment() as Waiting) }))
      .sort((a, b) => a.order - b.order);

    if (queue.length >= this.matchSize) {
      const started = await this.#start(queue.splice(0, this.matchSize));
      if (started === "failed") {
        // They keep waiting. Try again soon, sooner still if someone else arrives.
        await this.ctx.storage.setAlarm(Date.now() + Math.min(30_000, 500 * 2 ** this.#failures++));
        return "done";
      }
      this.#failures = 0;
      // Matched or not, the queue is no longer what was read above.
      return "changed";
    }

    const fewest = this.minPlayers ?? this.matchSize;
    if (this.maxWaitMs <= 0 || fewest >= this.matchSize) return "done";
    const longest = queue[0];
    if (!longest || queue.length < fewest) {
      await this.ctx.storage.deleteAlarm();
      return "done";
    }
    const due = longest.since + this.maxWaitMs;
    if (Date.now() < due) {
      await this.ctx.storage.setAlarm(due);
      return "done";
    }
    await this.ctx.storage.deleteAlarm();
    const started = await this.#start(queue.splice(0));
    if (started === "failed") {
      await this.ctx.storage.setAlarm(Date.now() + Math.min(30_000, 500 * 2 ** this.#failures++));
      return "done";
    }
    this.#failures = 0;
    return "changed";
  }

  /**
   * Reserves a room for the group and sends them there. "failed" if the room
   * could not be reserved, "gone" if one of them stopped waiting meanwhile:
   * the others go back in the queue and the room is left unused.
   */
  async #start(group: (Waiting & { ws: WebSocket })[]): Promise<"matched" | "gone" | "failed"> {
    const players = group.map((waiting) => waiting.player);
    const room = crypto.randomUUID();
    try {
      await this.reserveRoom(room, players, mostCommonHint(group));
    } catch (err) {
      console.error("[tickflare] could not reserve a room:", err);
      return "failed";
    }
    // Someone who left during the reservation would leave the others in a room that never fills.
    if (group.some(({ ws }) => ws.readyState !== 1)) return "gone";

    const found = JSON.stringify({ t: "match", room, players } satisfies MatchFound);
    for (const { ws } of group) {
      try {
        ws.send(found);
        ws.close(1000, "matched");
      } catch {
        // The player gave up at the last moment. Their seat stays reserved.
      }
    }
    return "matched";
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
