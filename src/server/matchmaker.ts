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
  /** What `ratingOf` gave when the player started waiting, if it gave a number. */
  rating?: number;
  /** What `regionOf` gave. */
  region?: string;
}

type Queued = Waiting & { ws: WebSocket };

/**
 * Puts waiting players together into matches. One Durable Object per queue
 * name.
 *
 * A player waits by holding a WebSocket open. As soon as `matchSize` players
 * are waiting, the matchmaker picks a new room id, reserves the room for
 * them, tells each of them where to go and closes their sockets. The queue
 * is the set of open sockets, so the object hibernates while people wait.
 *
 * Who is matched with whom is first come, first served, unless you say
 * otherwise: `ratingOf` and `ratingGap` keep players of different skill
 * apart, and `regionWaitMs` keeps players of different regions apart, each
 * for as long as you think a player should wait for a better match.
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
   * How far apart two players' ratings may be for them to be matched.
   * Infinity, the default, matches players whatever `ratingOf` says. A match
   * is built around whoever has waited longest: the players nearest to them
   * in rating, none further away than this.
   */
  protected ratingGap = Infinity;

  /**
   * How much `ratingGap` grows for every second a player has waited, so that
   * a player nobody is close to still gets a match. 0, the default, never
   * widens it: such a player waits until someone close enough arrives.
   */
  protected ratingGapPerSecond = 0;

  /**
   * For how long a player is matched only with players of their own region.
   * After that they are matched with anyone, players of their region first.
   * 0, the default, matches across regions from the start.
   */
  protected regionWaitMs = 0;

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

  /**
   * How good this player is, as a number in which players who are close are
   * a fair match: an Elo rating, a rank, a level. It is asked once, when the
   * player starts waiting, and only matters once `ratingGap` is set. A player
   * without a rating, which is what the default gives everyone, can be
   * matched with anyone.
   *
   *     protected override ratingGap = 150;
   *     protected override async ratingOf(player: string) {
   *       const stats = await new Accounts(this.env.DB, options).stats(player);
   *       return stats.rating ?? 1000;
   *     }
   */
  protected ratingOf(player: string, request: Request): number | undefined | Promise<number | undefined> {
    void player;
    void request;
    return undefined;
  }

  /**
   * Which region this player is in, for `regionWaitMs`. The default is the
   * part of the world the gateway saw the request come from, one of
   * Cloudflare's location hints such as "weur" or "enam", and undefined when
   * that is not known, as in local development. A player without a region
   * can be matched with anyone.
   */
  protected regionOf(player: string, request: Request): string | undefined | Promise<string | undefined> {
    void player;
    return request.headers.get(HINT_HEADER) ?? undefined;
  }

  /** Durable Object entry point for players joining the queue. Tickflare's: don't override it. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }
    const player = request.headers.get(PLAYER_HEADER);
    if (!player) {
      return new Response("Missing player identity", { status: 401 });
    }

    let rating: number | undefined;
    let region: string | undefined;
    try {
      if (this.ratingGap !== Infinity) rating = await this.ratingOf(player, request);
      if (this.regionWaitMs > 0) region = await this.regionOf(player, request);
    } catch (err) {
      // They wait as someone about whom nothing is known, which is better than not at all.
      console.error("[tickflare] could not rate or place a player:", err);
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
      ...(typeof rating === "number" && Number.isFinite(rating) ? { rating } : {}),
      ...(typeof region === "string" && region ? { region: region.slice(0, 64) } : {}),
    } satisfies Waiting);

    await this.#match();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Durable Object entry point for players leaving the queue. Tickflare's: don't override it. */
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
    const now = Date.now();
    const queue: Queued[] = this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === 1)
      .map((ws) => ({ ws, ...(ws.deserializeAttachment() as Waiting) }))
      .sort((a, b) => a.order - b.order);

    const fewest = Math.max(1, this.minPlayers ?? this.matchSize);
    // Whether a match may start short of `matchSize`, once someone has waited long enough.
    const short = this.maxWaitMs > 0 && fewest < this.matchSize;
    const picky = this.ratingGap !== Infinity || this.regionWaitMs > 0;
    // Without ratings or regions everyone suits everyone, and the one who has waited longest says it all.
    const anchors = picky ? queue : queue.slice(0, 1);

    // The soonest the queue could look different with nobody arriving or leaving.
    let wake = Infinity;
    for (const anchor of anchors) {
      const others = this.#around(anchor, queue);
      const ready = others.filter((other) => other.from <= now).map((other) => other.waiting);

      let group: Queued[] | undefined;
      if (ready.length >= this.matchSize - 1) {
        group = [anchor, ...ready.slice(0, this.matchSize - 1)];
      } else if (short && ready.length + 1 >= fewest && now >= anchor.since + this.maxWaitMs) {
        group = [anchor, ...ready];
      }
      if (group) {
        const started = await this.#start(group.sort((a, b) => a.order - b.order));
        if (started === "failed") {
          // They keep waiting. Try again soon, sooner still if someone else arrives.
          await this.ctx.storage.setAlarm(Date.now() + Math.min(30_000, 500 * 2 ** this.#failures++));
          return "done";
        }
        this.#failures = 0;
        // Matched or not, the queue is no longer what was read above.
        return "changed";
      }

      const times = others.map((other) => other.from).sort((a, b) => a - b);
      wake = Math.min(wake, times[this.matchSize - 2] ?? Infinity);
      if (short) {
        const enough = fewest <= 1 ? 0 : (times[fewest - 2] ?? Infinity);
        wake = Math.min(wake, Math.max(anchor.since + this.maxWaitMs, enough));
      }
    }

    // Only a queue that waits for a moment in time needs an alarm, or to be rid of one.
    if (short || this.ratingGapPerSecond > 0 || this.regionWaitMs > 0) {
      if (wake !== Infinity) await this.ctx.storage.setAlarm(Math.max(wake, now + 1));
      else await this.ctx.storage.deleteAlarm();
    }
    return "done";
  }

  /**
   * Everyone else in the queue as a match for `anchor`: from when on they may
   * be matched, which is Infinity for never, with the ones to pick first at
   * the front.
   */
  #around(anchor: Queued, queue: Queued[]): { waiting: Queued; from: number }[] {
    const ranked: { waiting: Queued; from: number; far: boolean; distance: number }[] = [];
    for (const waiting of queue) {
      if (waiting === anchor) continue;
      const far = anchor.region !== undefined && waiting.region !== undefined && anchor.region !== waiting.region;
      let from = far && this.regionWaitMs > 0 ? anchor.since + this.regionWaitMs : 0;

      let distance = 0;
      if (anchor.rating !== undefined && waiting.rating !== undefined) {
        distance = Math.abs(anchor.rating - waiting.rating);
        const beyond = distance - this.ratingGap;
        if (beyond > 0) {
          const widened =
            this.ratingGapPerSecond > 0 ? anchor.since + Math.ceil((beyond / this.ratingGapPerSecond) * 1000) : Infinity;
          from = Math.max(from, widened);
        }
      }
      ranked.push({ waiting, from, far, distance });
    }
    // Their own region first, then the nearest in rating, then whoever has waited longest.
    return ranked.sort(
      (a, b) => Number(a.far) - Number(b.far) || a.distance - b.distance || a.waiting.order - b.waiting.order,
    );
  }

  /**
   * Reserves a room for the group and sends them there. "failed" if the room
   * could not be reserved, "gone" if one of them stopped waiting meanwhile:
   * the others go back in the queue and the room is left unused.
   */
  async #start(group: Queued[]): Promise<"matched" | "gone" | "failed"> {
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
