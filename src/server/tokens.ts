/**
 * Signed join tokens: how a room knows who is connecting without trusting
 * the client.
 *
 * Your own backend creates a token once it knows who the player is (after a
 * login, or when it hands out a guest account). The client presents it when
 * connecting, and `tokenAuth` checks it at the gateway. A token is an
 * HMAC-SHA256 signature over the player id and an expiry, so it cannot be
 * forged or altered without the secret.
 */

import type { Authenticated } from "./gateway.js";

/** What a join token says. See `createJoinToken`. */
export interface JoinTokenClaims {
  /** The player this token speaks for. */
  player: string;
  /**
   * The player's account name. Rooms see it as `player.name`. Leave it out
   * for guests: `Accounts` takes a token with a name for a signed-in player.
   */
  name?: string;
  /** If set, the token only opens the room or matchmaking queue with this id. */
  scope?: string;
  /**
   * The party the player queues with: friends who are to be matched
   * together. Every member's token carries the same `id`, and `size` says
   * how many they are. Only your server should make these, once it knows
   * the player is in that party: a player who could name any party could
   * join a stranger's.
   */
  party?: Party;
  /** Lifetime in seconds. Defaults to one hour. */
  expiresIn?: number;
}

/** Friends who queue together. See `JoinTokenClaims.party`. */
export interface Party {
  /** The same for every member: any string of up to 64 visible characters. */
  id: string;
  /** How many members the party has, the player included. */
  size: number;
}

/** What a valid join token said. See `verifyJoinToken`. */
export interface VerifiedJoinToken {
  /** The player it speaks for. */
  player: string;
  /** The account name, if it carried one. */
  name?: string;
  /** The room or queue it is limited to, if any. */
  scope?: string;
  /** The party the player queues with, if it carried one. */
  party?: Party;
  /** When it stops working, in epoch seconds. */
  expiresAt: number;
}

interface Payload {
  p: string;
  n?: string;
  s?: string;
  /** The party's id and size. */
  pa?: string;
  ps?: number;
  e: number;
}

const VERSION = "v1";
const MIN_SECRET_LENGTH = 16;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keys = new Map<string, Promise<CryptoKey>>();

/** Sign a token for a player. Keep the secret on the server: `wrangler secret put JOIN_SECRET`. */
export async function createJoinToken(secret: string, claims: JoinTokenClaims): Promise<string> {
  const payload: Payload = {
    p: claims.player,
    e: Math.floor(Date.now() / 1000) + (claims.expiresIn ?? 3600),
  };
  if (claims.name !== undefined) payload.n = claims.name;
  if (claims.scope !== undefined) payload.s = claims.scope;
  if (claims.party !== undefined) {
    payload.pa = claims.party.id;
    payload.ps = claims.party.size;
  }
  const body = `${VERSION}.${toBase64Url(encoder.encode(JSON.stringify(payload)))}`;
  const signature = await crypto.subtle.sign("HMAC", await keyFor(secret), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Check a token. Returns what it says, or `null` if it is malformed, signed
 * with another secret, expired, or scoped to a different room or queue than
 * `scope`.
 */
export async function verifyJoinToken(
  secret: string,
  token: string,
  scope?: string,
): Promise<VerifiedJoinToken | null> {
  const key = await keyFor(secret);
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64Url(parts[2]!),
      encoder.encode(`${parts[0]}.${parts[1]}`),
    );
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(fromBase64Url(parts[1]!))) as Payload;
    if (typeof payload.p !== "string" || typeof payload.e !== "number") return null;
    if (payload.e <= Date.now() / 1000) return null;
    if (payload.s !== undefined && payload.s !== scope) return null;
    const verified: VerifiedJoinToken = { player: payload.p, expiresAt: payload.e };
    if (typeof payload.n === "string") verified.name = payload.n;
    if (payload.s !== undefined) verified.scope = payload.s;
    if (typeof payload.pa === "string" && typeof payload.ps === "number") verified.party = { id: payload.pa, size: payload.ps };
    return verified;
  } catch {
    return null;
  }
}

/** How `tokenAuth` checks tokens. */
export interface TokenAuthOptions {
  /** The signing secret, e.g. `env.JOIN_SECRET`. At least 16 characters. */
  secret: string;
  /** Query parameter the client sends the token in. Defaults to `token`. */
  param?: string;
}

/**
 * An `authenticate` function for `routeToRoom` and `routeToMatchmaker` that
 * accepts signed join tokens. The client connects with `?token=...`; plain
 * HTTP requests may send `Authorization: Bearer ...` instead.
 */
export function tokenAuth(
  options: TokenAuthOptions,
): (request: Request, scope: string) => Promise<Authenticated | Response> {
  const param = options.param ?? "token";
  return async (request, scope) => {
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];
    const token = new URL(request.url).searchParams.get(param) ?? bearer;
    if (!token) return new Response("Missing join token", { status: 401 });
    const verified = await verifyJoinToken(options.secret, token, scope);
    if (!verified) return new Response("Invalid or expired join token", { status: 401 });
    if (verified.name === undefined && verified.party === undefined) return verified.player;
    return {
      id: verified.player,
      ...(verified.name !== undefined ? { name: verified.name } : {}),
      ...(verified.party !== undefined ? { party: verified.party } : {}),
    };
  };
}

function keyFor(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    // Also catches a missing binding, which would otherwise sign with "undefined".
    throw new TypeError(`The join token secret must be a string of at least ${MIN_SECRET_LENGTH} characters`);
  }
  let key = keys.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    keys.set(secret, key);
  }
  return key;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
