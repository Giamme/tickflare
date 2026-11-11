/** Header the gateway uses to tell a room who is connecting. Never trusted from the client. */
export const PLAYER_HEADER = "x-tickflare-player";
/** Header the gateway uses to tell a room the id it is known by. */
export const ROOM_HEADER = "x-tickflare-room";
/** Header the gateway uses to tell a matchmaker roughly where a player is. */
export const HINT_HEADER = "x-tickflare-hint";

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Visible ASCII without spaces: safe as a header value and as a WebSocket tag. */
const PLAYER_ID = /^[\x21-\x7E]{1,128}$/;

/** The part of a Durable Object namespace the gateway needs. `env.ROOMS` fits. */
export interface RoomNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

export interface RouteOptions {
  /** Durable Object namespace of your `Room` class, e.g. `env.ROOMS`. */
  rooms: RoomNamespace;
  /** URL prefix rooms live under. Defaults to `/rooms`. */
  prefix?: string;
  /**
   * Work out who is connecting. Return the player's id, or a `Response` to
   * refuse the connection. This is the only place identity is established:
   * rooms trust whatever id this returns.
   */
  authenticate(request: Request): string | Response | Promise<string | Response>;
}

/**
 * Forwards room traffic to the room's Durable Object: WebSocket upgrades on
 * `{prefix}/{roomId}`, and plain HTTP requests on `{prefix}/{roomId}/...`,
 * which reach the room's `onHttp` hook. Both are authenticated first.
 * Returns `null` when the URL is not a room URL, so the caller can fall
 * through to its other routes.
 */
export async function routeToRoom(
  request: Request,
  options: RouteOptions,
): Promise<Response | null> {
  const prefix = (options.prefix ?? "/rooms").replace(/\/+$/, "");
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${prefix}/`)) return null;

  const [roomId = "", ...rest] = pathname.slice(prefix.length + 1).split("/");
  const upgrade = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  if (!ROOM_ID.test(roomId) || (upgrade && rest.length > 0)) {
    return new Response("Invalid room id", { status: 400 });
  }
  if (!upgrade && rest.length === 0) {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }

  const identity = await options.authenticate(request);
  if (identity instanceof Response) return identity;
  if (!PLAYER_ID.test(identity)) {
    return new Response("Invalid player id", { status: 400 });
  }

  // Overwrites anything the client sent under the same names.
  const headers = new Headers(request.headers);
  headers.set(PLAYER_HEADER, identity);
  headers.set(ROOM_HEADER, roomId);

  const stub = options.rooms.get(options.rooms.idFromName(roomId));
  return stub.fetch(new Request(request, { headers }));
}

export interface MatchmakerRouteOptions {
  /** Durable Object namespace of your `Matchmaker` class, e.g. `env.MATCHMAKER`. */
  matchmaker: RoomNamespace;
  /** URL prefix queues live under. Defaults to `/matchmaking`. */
  prefix?: string;
  /** Same contract as for rooms: the player's id, or a `Response` to refuse. */
  authenticate(request: Request): string | Response | Promise<string | Response>;
}

/**
 * Forwards `{prefix}/{queue}` WebSocket upgrades to a matchmaker. Each queue
 * name is its own Durable Object, so `/matchmaking/ranked` and
 * `/matchmaking/casual` fill separately. Returns `null` for other URLs.
 */
export async function routeToMatchmaker(
  request: Request,
  options: MatchmakerRouteOptions,
): Promise<Response | null> {
  const prefix = (options.prefix ?? "/matchmaking").replace(/\/+$/, "");
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith(`${prefix}/`)) return null;

  const queue = pathname.slice(prefix.length + 1);
  if (!ROOM_ID.test(queue)) {
    return new Response("Invalid queue name", { status: 400 });
  }
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 426 });
  }
  const identity = await options.authenticate(request);
  if (identity instanceof Response) return identity;
  if (!PLAYER_ID.test(identity)) {
    return new Response("Invalid player id", { status: 400 });
  }

  const headers = new Headers(request.headers);
  headers.set(PLAYER_HEADER, identity);
  const hint = locationHintFor(request);
  if (hint) headers.set(HINT_HEADER, hint);
  else headers.delete(HINT_HEADER);

  const stub = options.matchmaker.get(options.matchmaker.idFromName(queue));
  return stub.fetch(new Request(request, { headers }));
}

/**
 * The Durable Object location hint closest to where a request came from,
 * worked out from Cloudflare's `request.cf`. Undefined when that is missing,
 * as it is in local development.
 */
export function locationHintFor(request: Request): DurableObjectLocationHint | undefined {
  const cf = (request as { cf?: { continent?: string; longitude?: string } }).cf;
  const longitude = Number(cf?.longitude);
  switch (cf?.continent) {
    case "NA":
      return longitude < -100 ? "wnam" : "enam";
    case "SA":
      return "sam";
    case "EU":
      return longitude > 20 ? "eeur" : "weur";
    case "AS":
      return longitude < 60 ? "me" : "apac";
    case "OC":
      return "oc";
    case "AF":
      return "afr";
    default:
      return undefined;
  }
}
