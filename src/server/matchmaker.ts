import { DurableObject } from "cloudflare:workers";
import { CloseCode, PING, PONG, type MatchFound } from "../protocol.js";
import { HINT_HEADER, PARTY_HEADER, PLAYER_HEADER, type RoomNamespace } from "./gateway.js";
import type { RoomCall } from "./room.js";
import type { Party } from "./tokens.js";

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
  /** What `partyOf` gave: the party's id and how many it has. */
  party?: string;
  partySize?: number;
}

type Queued = Waiting & { ws: WebSocket };

/**
 * What is matched: a player alone, or the members of a party who are
 * waiting, which are never split.
 */
interface Unit {
  members: Queued[];
  size: number;
  /** The members' average rating, if any of them has one. */
  rating?: number;
  /** The members' most common region. */
  region?: string;
  /** When its longest-waiting member started waiting, and that member's place in the queue. */
  since: number;
  order: number;
  /** From when it may be matched: at once, or for a party not all there yet, when it has waited long enough. */
  readyAt: number;
}

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
 *
 * Friends who queue together are a party: their join tokens say so, or
 * `partyOf` does. A party is matched as one, never split, and with `teams`
 * set it plays on one side.
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
   * How many sides a match is split into. 1, the default, says nothing about
   * sides. With more, the matchmaker shares each match's players out among
   * that many teams of as equal a size as it can, keeps every party on one
   * team, and evens out the teams' ratings. The teams go in the `match`
   * message and to the room, as `this.teams`. A party larger than a team is
   * turned away.
   */
  protected teams = 1;

  /**
   * How long the first member of a party to arrive waits for the others.
   * After that the members who are there are matched without the rest.
   */
  protected partyWaitMs = 60_000;

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
    teams?: string[][],
  ): Promise<void> {
    const rooms = this.rooms;
    if (!rooms) throw new TypeError("a matchmaker needs `rooms` to be set");
    const stub = rooms.get(rooms.idFromName(roomId), locationHint ? { locationHint } : undefined) as unknown as {
      tickflare(call: RoomCall): Promise<unknown>;
    };
    await stub.tickflare(teams ? { op: "reserve", roomId, players, teams } : { op: "reserve", roomId, players });
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

  /**
   * The party this player queues with, if any: friends who are to be matched
   * together. The default is what their join token says, which only your
   * server can write (see `JoinTokenClaims.party`). Override it to look the
   * party up yourself, in a table of your own for instance. Never take it
   * from the request's query: a player who could name any party could join
   * a stranger's.
   */
  protected partyOf(player: string, request: Request): Party | undefined | Promise<Party | undefined> {
    void player;
    const header = request.headers.get(PARTY_HEADER);
    const colon = header?.indexOf(":") ?? -1;
    if (!header || colon < 1) return undefined;
    return { size: Number(header.slice(0, colon)), id: header.slice(colon + 1) };
  }

  /** The most players a team can have: a party larger than this can never be matched. */
  #largestParty(): number {
    return Math.max(1, Math.floor(this.matchSize / Math.max(1, this.teams)));
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
    let party: Party | undefined;
    try {
      if (this.ratingGap !== Infinity) rating = await this.ratingOf(player, request);
      if (this.regionWaitMs > 0) region = await this.regionOf(player, request);
    } catch (err) {
      // They wait as someone about whom nothing is known, which is better than not at all.
      console.error("[tickflare] could not rate or place a player:", err);
    }
    try {
      party = await this.partyOf(player, request);
    } catch (err) {
      console.error("[tickflare] could not look up a player's party:", err);
    }
    if (party && (typeof party.id !== "string" || !party.id || !Number.isInteger(party.size) || party.size < 1)) party = undefined;
    // A party of one is a player alone.
    if (party?.size === 1) party = undefined;
    if (party && party.size > this.#largestParty()) {
      // It could never be matched. Say so, rather than leave them waiting.
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].close(CloseCode.JoinRejected, "party_too_large");
      return new Response(null, { status: 101, webSocket: pair[0] });
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
      ...(party ? { party: party.id.slice(0, 64), partySize: party.size } : {}),
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
    const units = this.#units(queue);

    const fewest = Math.max(1, this.minPlayers ?? this.matchSize);
    // Whether a match may start short of `matchSize`, once someone has waited long enough.
    const short = this.maxWaitMs > 0 && fewest < this.matchSize;
    const ready = units.filter((unit) => unit.readyAt <= now);
    // A party may not fit beside the one who has waited longest, and still make a match with others.
    const picky = this.ratingGap !== Infinity || this.regionWaitMs > 0 || this.teams > 1 || ready.some((unit) => unit.size > 1);
    // Without ratings, regions, teams or parties, every player suits every other, and the one who has waited longest says it all.
    const anchors = picky ? ready : ready.slice(0, 1);

    // The soonest the queue could look different with nobody arriving or leaving.
    let wake = Infinity;
    for (const unit of units) if (unit.readyAt > now) wake = Math.min(wake, unit.readyAt);

    for (const anchor of anchors) {
      const others = this.#around(anchor, ready);
      const chosen = this.#fill(anchor, others.filter((other) => other.from <= now).map((other) => other.unit), this.matchSize);
      let group: Unit[] | undefined;
      if (chosen.size === this.matchSize) {
        group = chosen.units;
      } else if (short && chosen.size >= fewest && now >= anchor.since + this.maxWaitMs) {
        group = chosen.units;
      }
      if (group) {
        const players = group.flatMap((unit) => unit.members).sort((a, b) => a.order - b.order);
        const teams = this.teams > 1 ? (this.#split(group) ?? this.#split(group, this.matchSize)) : undefined;
        const started = await this.#start(players, teams);
        if (started === "failed") {
          // They keep waiting. Try again soon, sooner still if someone else arrives.
          await this.ctx.storage.setAlarm(Date.now() + Math.min(30_000, 500 * 2 ** this.#failures++));
          return "done";
        }
        this.#failures = 0;
        // Matched or not, the queue is no longer what was read above.
        return "changed";
      }

      // When enough of the others will be acceptable to make a match, or a short one.
      const later = others.filter((other) => other.from > now && other.from !== Infinity).sort((a, b) => a.from - b.from);
      let size = chosen.size;
      for (const other of later) {
        size += other.unit.size;
        if (size >= this.matchSize || (short && size >= fewest)) {
          wake = Math.min(wake, short && size < this.matchSize ? Math.max(other.from, anchor.since + this.maxWaitMs) : other.from);
          break;
        }
      }
      if (short && chosen.size >= fewest) wake = Math.min(wake, Math.max(now + 1, anchor.since + this.maxWaitMs));
    }

    // Only a queue that waits for a moment in time needs an alarm, or to be rid of one.
    if (short || this.ratingGapPerSecond > 0 || this.regionWaitMs > 0 || units.some((unit) => unit.members[0]!.party !== undefined)) {
      if (wake !== Infinity) await this.ctx.storage.setAlarm(Math.max(wake, now + 1));
      else await this.ctx.storage.deleteAlarm();
    }
    return "done";
  }

  /** The queue as what is matched: players alone, and parties with the members who are waiting. */
  #units(queue: Queued[]): Unit[] {
    const units: Unit[] = [];
    const parties = new Map<string, Queued[]>();
    for (const waiting of queue) {
      if (waiting.party === undefined) {
        units.push({ members: [waiting], size: 1, rating: waiting.rating, region: waiting.region, since: waiting.since, order: waiting.order, readyAt: 0 });
        continue;
      }
      let members = parties.get(waiting.party);
      if (!members) parties.set(waiting.party, (members = []));
      members.push(waiting);
    }
    const largest = this.#largestParty();
    for (const members of parties.values()) {
      // More members than the party said it has, or than a team holds: the first ones, in the order they came.
      const taken = members.slice(0, Math.min(largest, Math.max(...members.map((member) => member.partySize ?? 1))));
      const expected = Math.min(largest, taken[0]!.partySize ?? taken.length);
      const rated = taken.filter((member) => member.rating !== undefined);
      const since = Math.min(...taken.map((member) => member.since));
      units.push({
        members: taken,
        size: taken.length,
        rating: rated.length ? rated.reduce((sum, member) => sum + member.rating!, 0) / rated.length : undefined,
        region: mostCommon(taken.map((member) => member.region)),
        since,
        order: Math.min(...taken.map((member) => member.order)),
        readyAt: taken.length >= expected ? 0 : since + this.partyWaitMs,
      });
      // Anyone past what fits waits as a party of their own, for the next match.
      for (const extra of members.slice(taken.length)) {
        units.push({ members: [extra], size: 1, rating: extra.rating, region: extra.region, since: extra.since, order: extra.order, readyAt: 0 });
      }
    }
    return units.sort((a, b) => a.order - b.order);
  }

  /**
   * Everyone else in the queue as a match for `anchor`: from when on they may
   * be matched, which is Infinity for never, with the ones to pick first at
   * the front.
   */
  #around(anchor: Unit, units: Unit[]): { unit: Unit; from: number }[] {
    const ranked: { unit: Unit; from: number; far: boolean; distance: number }[] = [];
    for (const unit of units) {
      if (unit === anchor) continue;
      const far = anchor.region !== undefined && unit.region !== undefined && anchor.region !== unit.region;
      let from = far && this.regionWaitMs > 0 ? anchor.since + this.regionWaitMs : 0;

      let distance = 0;
      if (anchor.rating !== undefined && unit.rating !== undefined) {
        distance = Math.abs(anchor.rating - unit.rating);
        const beyond = distance - this.ratingGap;
        if (beyond > 0) {
          const widened =
            this.ratingGapPerSecond > 0 ? anchor.since + Math.ceil((beyond / this.ratingGapPerSecond) * 1000) : Infinity;
          from = Math.max(from, widened);
        }
      }
      ranked.push({ unit, from, far, distance });
    }
    // Their own region first, then the nearest in rating, then whoever has waited longest.
    return ranked.sort(
      (a, b) => Number(a.far) - Number(b.far) || a.distance - b.distance || a.unit.order - b.unit.order,
    );
  }

  /**
   * As many of `candidates`, in their order, as fit in a match of `capacity`
   * with `anchor`, taking a party only where all of it fits, and only where
   * the teams can still be made.
   */
  #fill(anchor: Unit, candidates: Unit[], capacity: number): { units: Unit[]; size: number } {
    const units = [anchor];
    let size = anchor.size;
    for (const unit of candidates) {
      if (size === capacity) break;
      if (size + unit.size > capacity) continue;
      if (this.teams > 1 && !this.#split([...units, unit], capacity)) continue;
      units.push(unit);
      size += unit.size;
    }
    return { units, size };
  }

  /**
   * The players of a match as `teams` sides, or undefined if its parties
   * cannot be shared out so. Each side holds at most `capacity / teams`,
   * rounded up; the largest parties are placed first, each on the side with
   * room for it whose ratings add up to least, which keeps the sides even.
   */
  #split(units: Unit[], capacity = units.reduce((sum, unit) => sum + unit.size, 0)): string[][] | undefined {
    const teams = Math.max(1, this.teams);
    const room = Math.ceil(capacity / teams);
    const sides = Array.from({ length: teams }, () => ({ players: [] as Queued[], rating: 0, size: 0 }));
    // With no ratings at all, units count as equal, and the sides are evened out by size.
    const average = (() => {
      const rated = units.filter((unit) => unit.rating !== undefined);
      return rated.length ? rated.reduce((sum, unit) => sum + unit.rating!, 0) / rated.length : 0;
    })();
    const ordered = [...units].sort((a, b) => b.size - a.size || (b.rating ?? average) - (a.rating ?? average) || a.order - b.order);
    for (const unit of ordered) {
      const fits = sides.filter((side) => side.size + unit.size <= room);
      if (fits.length === 0) return undefined;
      const side = fits.reduce((best, side) => (side.rating < best.rating || (side.rating === best.rating && side.size < best.size) ? side : best));
      side.players.push(...unit.members);
      side.size += unit.size;
      side.rating += (unit.rating ?? average) * unit.size;
    }
    return sides.map((side) => side.players.sort((a, b) => a.order - b.order).map((member) => member.player));
  }

  /**
   * Reserves a room for the group and sends them there. "failed" if the room
   * could not be reserved, "gone" if one of them stopped waiting meanwhile:
   * the others go back in the queue and the room is left unused.
   */
  async #start(group: Queued[], teams?: string[][]): Promise<"matched" | "gone" | "failed"> {
    const players = group.map((waiting) => waiting.player);
    const room = crypto.randomUUID();
    try {
      await this.reserveRoom(room, players, mostCommonHint(group), teams);
    } catch (err) {
      console.error("[tickflare] could not reserve a room:", err);
      return "failed";
    }
    // Someone who left during the reservation would leave the others in a room that never fills.
    if (group.some(({ ws }) => ws.readyState !== 1)) return "gone";

    const found = JSON.stringify((teams ? { t: "match", room, players, teams } : { t: "match", room, players }) satisfies MatchFound);
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

/** The value that occurs most often, ignoring undefined. */
function mostCommon(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  let best: string | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (best === undefined || count > counts.get(best)!) best = value;
  }
  return best;
}
