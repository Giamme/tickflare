/** Header the gateway uses to tell a room who is connecting. Never trusted from the client. */
export const PLAYER_HEADER = "x-tickflare-player";
/** Header the gateway uses to tell a room the id it is known by. */
export const ROOM_HEADER = "x-tickflare-room";
/** Header the gateway uses to tell a room the player's name, URI-encoded. Never trusted from the client. */
export const NAME_HEADER = "x-tickflare-name";
/** Header the gateway uses to tell a matchmaker roughly where a player is. */
export const HINT_HEADER = "x-tickflare-hint";

const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Visible ASCII without spaces: safe as a header value and as a WebSocket tag. */
const PLAYER_ID = /^[\x21-\x7E]{1,128}$/;
/** Up to 64 characters without control characters. */
const PLAYER_NAME = /^[^\p{Cc}]{1,64}$/u;

/**
 * Who `authenticate` found: a player id, or a player id with a display name.
 * A name reaches the room's hooks as `player.name`.
 */
export type Authenticated = string | { id: string; name?: string };

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
   * Work out who is connecting. Return the player's id (or `{ id, name }`),
   * or a `Response` to refuse the connection. This is the only place
   * identity is established: rooms trust whatever this returns. `roomId` is
   * the room being opened. `tokenAuth` gives you one that checks signed join
   * tokens, and `Accounts.authenticate` one that also knows signed-in players.
   */
  authenticate(request: Request, roomId: string): Authenticated | Response | Promise<Authenticated | Response>;
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

  const identity = checkIdentity(await options.authenticate(request, roomId));
  if (identity instanceof Response) return identity;

  const headers = identityHeaders(request, identity);
  headers.set(ROOM_HEADER, roomId);

  const stub = options.rooms.get(options.rooms.idFromName(roomId));
  return stub.fetch(new Request(request, { headers }));
}

/** What `authenticate` returned, as an id and maybe a name, or the answer for something that cannot be a player. */
function checkIdentity(identity: unknown): { id: string; name?: string } | Response {
  if (identity instanceof Response) return identity;
  const id = typeof identity === "object" && identity !== null ? (identity as { id?: unknown }).id : identity;
  const name = typeof identity === "object" && identity !== null ? (identity as { name?: unknown }).name : undefined;
  // An `authenticate` that falls off its end returns undefined. That is nobody, not a player.
  if (typeof id !== "string") {
    return new Response("Not authenticated", { status: 401 });
  }
  // "__proto__" would do damage as a key in a game's state.
  if (!PLAYER_ID.test(id) || id === "__proto__") {
    return new Response("Invalid player id", { status: 400 });
  }
  if (name !== undefined && (typeof name !== "string" || !PLAYER_NAME.test(name))) {
    return new Response("Invalid player name", { status: 400 });
  }
  return name === undefined ? { id } : { id, name };
}

/** The request's headers with the gateway's own: anything the client sent under the same names is replaced or dropped. */
function identityHeaders(request: Request, identity: { id: string; name?: string }): Headers {
  const headers = new Headers(request.headers);
  headers.set(PLAYER_HEADER, identity.id);
  if (identity.name === undefined) headers.delete(NAME_HEADER);
  else headers.set(NAME_HEADER, encodeURIComponent(identity.name));
  return headers;
}

export interface MatchmakerRouteOptions {
  /** Durable Object namespace of your `Matchmaker` class, e.g. `env.MATCHMAKER`. */
  matchmaker: RoomNamespace;
  /** URL prefix queues live under. Defaults to `/matchmaking`. */
  prefix?: string;
  /** Same contract as for rooms: the player's id (or `{ id, name }`), or a `Response` to refuse. `queue` is the queue name. */
  authenticate(request: Request, queue: string): Authenticated | Response | Promise<Authenticated | Response>;
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
  const identity = checkIdentity(await options.authenticate(request, queue));
  if (identity instanceof Response) return identity;

  const headers = identityHeaders(request, identity);
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
