/** Header the gateway uses to tell a room who is connecting. Never trusted from the client. */
export const PLAYER_HEADER = "x-tickflare-player";

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

  // Overwrites anything the client sent under the same name.
  const headers = new Headers(request.headers);
  headers.set(PLAYER_HEADER, identity);

  const stub = options.rooms.get(options.rooms.idFromName(roomId));
  return stub.fetch(new Request(request, { headers }));
}
