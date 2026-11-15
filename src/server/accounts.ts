import { createJoinToken, verifyJoinToken, type Party } from "./tokens.js";

/*
 * Player accounts and player data, in D1.
 *
 * What a game backend service such as Talo does for accounts, cut down to
 * what most games need: name and password accounts, sessions, guests that
 * can register without losing their progress, ways back into an account
 * whose password was forgotten, per-player data, server-side stats and
 * leaderboards, public profiles, and the means to export or delete
 * everything about a player.
 *
 * Everything lives in tables prefixed `tickflare_` in one D1 database, so
 * `wrangler d1 execute` and `wrangler d1 export` work on it like on any other.
 */

/** Who may read or write one key of a player's data. */
export interface DataPolicy {
  /** "owner": only the player (and the server). "public": anyone, on the player's profile. Default "owner". */
  read?: "owner" | "public";
  /** "owner": the player may set it from the client. "server": only server code may. Default "server". */
  write?: "owner" | "server";
}

/** How `Accounts` behaves. Only `secret` is required. */
export interface AccountsOptions {
  /** Signs guest and join tokens. The same secret `tokenAuth` uses. At least 16 characters. */
  secret: string;
  /** Where the HTTP API is served. Default "/api/accounts". */
  prefix?: string;
  /** The session cookie's name. Default "tf_session". */
  cookie?: string;
  /**
   * The session cookie's SameSite. "Lax" (the default) keeps players signed in
   * when they follow a link to your game; "Strict" does not send the cookie on
   * that first page load. A cookie set for an allowed origin of its own is
   * "None" either way, or it could not be used there.
   */
  sameSite?: "Lax" | "Strict";
  /** How long a session lasts since it was last used, in milliseconds. Default 30 days. */
  sessionTtlMs?: number;
  /** How long a guest token lasts, in seconds. A guest renews it, keeping their id, before then. Default 30 days. */
  guestTtlSeconds?: number;
  /** How long a join token from `/token` lasts, in seconds. Default ten minutes. */
  joinTokenTtlSeconds?: number;
  /**
   * Browser origins, besides the API's own, that may make signed-in requests
   * with the session cookie: where your game's pages are served from if that
   * is another origin. Anything else is refused, which is what stops another
   * site from acting as a signed-in player.
   */
  allowedOrigins?: string[];
  /** Policies per data key. Keys not listed are private and server-written. */
  data?: Record<string, DataPolicy>;
  /** The largest value one data key may hold, in bytes of JSON. Default 64 KiB. */
  maxDataBytes?: number;
  /** How many data keys one player may have. Default 100. */
  maxDataKeys?: number;
  /**
   * Your own rules for account names, in place of the default (3 to 24
   * letters, digits, spaces, dots, dashes and underscores). Return the name
   * as it should be stored, or null to refuse it. Uniqueness is checked after,
   * ignoring case, spaces, dots, dashes and underscores.
   */
  normalizeName?(name: string): string | null;
  /**
   * Checks a password against a hash this module did not make, so accounts
   * imported from another service keep working. On success the password is
   * hashed again the usual way. Return false for hashes you do not recognise.
   */
  verifyImportedPassword?(hash: string, password: string): boolean | Promise<boolean>;
  /**
   * Sends a player the link to set a new password: Tickflare makes the
   * token, and sending the email is yours to do, with whichever mail service
   * you use. Setting this turns `POST /forgot` on. Put `reset.token` in a
   * link to a page of yours that asks for a new password and sends both to
   * `POST /reset`.
   */
  sendPasswordReset?(reset: PasswordReset, request: Request): void | Promise<void>;
  /** How long a password reset token lasts, in seconds. Default one hour. */
  passwordResetTtlSeconds?: number;
}

/** What `sendPasswordReset` is given: whom to write to, and the token that lets them set a new password. */
export interface PasswordReset {
  /** The player id. */
  id: string;
  /** The account name, to remind the player of it. */
  name: string;
  /** The account's email address. */
  email: string;
  /** Lets its holder set a new password, once. Only its hash is stored. */
  token: string;
  /** When the token stops working, in epoch milliseconds. */
  expiresAt: number;
}

/** Who is behind a request. */
export interface Identity {
  /** The player id: the account's, or the guest's. */
  id: string;
  /** The account name, or undefined for a guest without an account. */
  name?: string;
  /** True for a guest without an account. */
  guest: boolean;
  /** The party the player queues with, if their join token carried one. See `JoinTokenClaims.party`. */
  party?: Party;
}

/** What anyone may see of a player. */
export interface PublicProfile {
  /** The player id. */
  id: string;
  /** The account name. */
  name: string;
  /** When the account was made, in epoch milliseconds. */
  createdAt: number;
  /** The data keys whose policy is `read: "public"`. */
  data: Record<string, unknown>;
  /** Every stat the player has. */
  stats: Record<string, number>;
}

/** What a player sees of their own account. */
export interface OwnAccount {
  /** The player id. */
  id: string;
  /** The account name. */
  name: string;
  /** The email address, if one was given. */
  email: string | null;
  /** When the account was made, in epoch milliseconds. */
  createdAt: number;
  /** Whether the account has a recovery code. The code itself is shown once, when it is made. */
  recoveryCode: boolean;
  /** Every data key the player has, private ones included. */
  data: Record<string, unknown>;
  /** Every stat the player has. */
  stats: Record<string, number>;
}

/** One line of a leaderboard. */
export interface LeaderboardEntry {
  /** 1 for the highest value. Players with the same value share a rank. */
  rank: number;
  /** The player id. */
  id: string;
  /** The account name. */
  name: string;
  /** The player's value of the stat. */
  value: number;
}

/** A page of a leaderboard, highest value first. */
export interface LeaderboardPage {
  /** The stat it ranks. */
  stat: string;
  /** This page's lines. */
  entries: LeaderboardEntry[];
  /** Players with a value for this stat, in total. */
  total: number;
}

/** An account taken over from another service. See `Accounts.importAccount`. */
export interface ImportedAccount {
  /** The player id to keep, so references to it elsewhere stay valid. */
  id: string;
  /** The account name. It must follow the name rules and be free. */
  name: string;
  /** The email address, if there is one. */
  email?: string | null;
  /** A hash `verifyImportedPassword` understands. */
  passwordHash: string;
  /** When the account was made, in epoch milliseconds. Defaults to now. */
  createdAt?: number;
}

/** The tables, in case you prefer to apply them as a migration. `Accounts` creates them on first use. */
export const ACCOUNTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tickflare_accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickflare_sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tickflare_sessions_account ON tickflare_sessions (account_id);
CREATE TABLE IF NOT EXISTS tickflare_player_data (
  player TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player, key)
);
CREATE TABLE IF NOT EXISTS tickflare_player_stats (
  player TEXT NOT NULL,
  stat TEXT NOT NULL,
  value REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (player, stat)
);
CREATE INDEX IF NOT EXISTS tickflare_player_stats_board ON tickflare_player_stats (stat, value DESC);
CREATE TABLE IF NOT EXISTS tickflare_stat_awards (
  key TEXT PRIMARY KEY,
  awarded_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickflare_sign_in_failures (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tickflare_recovery (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS tickflare_recovery_account ON tickflare_recovery (account_id);
`;

const DAY_MS = 24 * 60 * 60 * 1000;
const PBKDF2_ITERATIONS = 100_000; // The most the Workers runtime allows.
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 256;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{1,22}[\p{L}\p{N}]$/u;
const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const STAT_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
/** Sign-in failures allowed per name, and per address, within one window. */
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_NAME = 10;
const MAX_FAILURES_PER_ADDRESS = 50;
/** Password reset emails one account, or one email address, can be sent within one window. */
const MAX_RESET_REQUESTS = 3;
/** Accounts with the same email address that one request for a reset writes to. */
const MAX_RESETS_PER_EMAIL = 5;
/** Recovery codes are written in these: no I, L, O or U, which read as other characters. */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** A session is extended at most once per this interval, so using it does not mean a write every time. */
const SESSION_REFRESH_MS = DAY_MS;

const encoder = new TextEncoder();
const ready = new WeakSet<D1Database>();

/** Raised for requests that cannot be done. `status` is the HTTP status the API answers with. */
export class AccountError extends Error {
  /** The HTTP status the API answers with, e.g. 409. */
  readonly status: number;
  /** Machine-readable, e.g. `name_taken` or `invalid_credentials`. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * A small player backend on D1: accounts with a name and a password,
 * sessions, guests who can sign up without losing what they earned,
 * per-player data, stats and leaderboards, public profiles, and a player's
 * right to download or delete everything about them.
 *
 * Make one per request; it holds no state of its own beyond its options.
 *
 *     const accounts = new Accounts(env.DB, { secret: env.JOIN_SECRET });
 *     return (await accounts.route(request)) ?? new Response("Not found", { status: 404 });
 */
export class Accounts {
  readonly #db: D1Database;
  readonly #secret: string;
  readonly #prefix: string;
  readonly #cookie: string;
  readonly #sameSite: "Lax" | "Strict";
  readonly #sessionTtl: number;
  readonly #guestTtl: number;
  readonly #joinTtl: number;
  readonly #origins: Set<string>;
  readonly #policies: Record<string, DataPolicy>;
  readonly #maxDataBytes: number;
  readonly #maxDataKeys: number;
  readonly #verifyImported: AccountsOptions["verifyImportedPassword"];
  readonly #sendReset: AccountsOptions["sendPasswordReset"];
  readonly #resetTtl: number;
  readonly #normalizeName: (name: string) => string;

  constructor(db: D1Database, options: AccountsOptions) {
    if (typeof options.secret !== "string" || options.secret.length < 16) {
      throw new TypeError("Accounts needs a secret of at least 16 characters");
    }
    this.#db = db;
    this.#secret = options.secret;
    this.#prefix = (options.prefix ?? "/api/accounts").replace(/\/+$/, "");
    this.#cookie = options.cookie ?? "tf_session";
    this.#sameSite = options.sameSite ?? "Lax";
    this.#sessionTtl = options.sessionTtlMs ?? 30 * DAY_MS;
    this.#guestTtl = options.guestTtlSeconds ?? 30 * 24 * 60 * 60;
    this.#joinTtl = options.joinTokenTtlSeconds ?? 10 * 60;
    this.#origins = new Set(options.allowedOrigins ?? []);
    this.#policies = options.data ?? {};
    this.#maxDataBytes = options.maxDataBytes ?? 64 * 1024;
    this.#maxDataKeys = options.maxDataKeys ?? 100;
    this.#verifyImported = options.verifyImportedPassword;
    this.#sendReset = options.sendPasswordReset;
    this.#resetTtl = options.passwordResetTtlSeconds ?? 60 * 60;
    const custom = options.normalizeName;
    this.#normalizeName = custom
      ? name => {
          const normalized = typeof name === "string" ? custom(name) : null;
          if (typeof normalized !== "string" || normalized.length === 0 || nameKey(normalized).length === 0) {
            throw new AccountError(400, "invalid_name", "That name is not allowed.");
          }
          return normalized;
        }
      : normalizeName;
  }

  /** Creates the tables if they are not there yet. Called for you before the first query. */
  async migrate(): Promise<void> {
    if (ready.has(this.#db)) return;
    const statements = ACCOUNTS_SCHEMA.split(";")
      .map((sql) => sql.trim())
      .filter(Boolean)
      .map((sql) => this.#db.prepare(sql));
    await this.#db.batch(statements);
    ready.add(this.#db);
  }

  // --- Identity ------------------------------------------------------------------

  /**
   * Who is making this request: the account its session cookie or bearer
   * session token belongs to, else the player a join token (`?token=` or
   * bearer) speaks for, else nobody. `scope` is checked against scoped join
   * tokens, as `tokenAuth` does.
   */
  async identify(request: Request, scope?: string): Promise<Identity | null> {
    // A cookie rides along with requests other sites' pages make, WebSocket
    // connections included, so it only counts from pages allowed to use it.
    const session = this.#originAllowed(request) ? this.#sessionToken(request) : bearerSession(request);
    if (session) {
      const account = await this.#accountForSession(session);
      if (account) return { id: account.id, name: account.name, guest: false };
    }
    const token = new URL(request.url).searchParams.get("token") ?? bearer(request);
    if (token && token.startsWith("v1.")) {
      const verified = await verifyJoinToken(this.#secret, token, scope);
      if (!verified) return null;
      const party = verified.party ? { party: verified.party } : {};
      if (verified.name !== undefined) return { id: verified.player, name: verified.name, guest: false, ...party };
      // A guest who has since registered signs in as the account: their old guest token no longer works.
      if (await this.#hasAccount(verified.player)) return null;
      return { id: verified.player, guest: true, ...party };
    }
    return null;
  }

  /**
   * For `routeToRoom` and `routeToMatchmaker`: lets in signed-in players and
   * holders of a join token, guests included, and answers 401 otherwise. The
   * room learns the player's name too.
   */
  readonly authenticate = async (request: Request, scope: string): Promise<Identity | Response> => {
    const identity = await this.identify(request, scope);
    return identity ?? new Response("Not authenticated", { status: 401 });
  };

  /** Like `authenticate`, for places that need an account: guests get 401 too. */
  readonly requireAccount = async (request: Request, scope: string): Promise<Identity | Response> => {
    const identity = await this.identify(request, scope);
    if (!identity || identity.guest) return new Response("Sign in to play here", { status: 401 });
    return identity;
  };

  // --- The HTTP API ----------------------------------------------------------------

  /**
   * Answers requests to the accounts API, under `prefix`; null for any other
   * URL so your Worker can try its other routes.
   *
   *     POST   /guest            a guest player and a join token for them
   *     POST   /register         { name, password, email?, guestToken? }
   *     POST   /login            { name, password }
   *     POST   /logout
   *     GET    /me               your account, data and stats
   *     DELETE /me               { password }: delete your account and everything in it
   *     POST   /password         { current, next }: change it and sign out everywhere else
   *     POST   /recovery-code    { password }: a code that sets a new password once, shown this one time
   *     POST   /recover          { name, code, password }: set a new password with that code, and sign in
   *     POST   /forgot           { name } or { email }: send a reset link, if `sendPasswordReset` is set
   *     POST   /reset            { token, password }: set a new password with the link's token, and sign in
   *     POST   /name             { name }: take another name
   *     POST   /email            { password, email }: set or (with null) remove the email address
   *     GET    /export           everything stored about you, as a JSON download
   *     POST   /token            { scope? }: a short-lived join token for a room or queue
   *     GET    /data/:key        PUT /data/:key { value }   DELETE /data/:key
   *     GET    /players/:id      a public profile
   *     GET    /leaderboards/:stat?limit=&offset=
   *
   * Pass the Worker's `ctx` as well if you reset passwords by email: the
   * email is then sent after the answer, which takes as long whether or not
   * there was an account to write to.
   */
  async route(request: Request, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname !== this.#prefix && !url.pathname.startsWith(`${this.#prefix}/`)) return null;
    const path = url.pathname.slice(this.#prefix.length) || "/";
    const cors = this.#corsHeaders(request);
    if (request.method === "OPTIONS" && cors) {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Max-Age": "86400",
        },
      });
    }
    let response: Response;
    try {
      await this.migrate();
      response = await this.#dispatch(request, url, path, ctx);
    } catch (error) {
      if (error instanceof AccountError) {
        response = json({ error: error.code, message: error.message }, error.status);
      } else {
        console.error("[tickflare] accounts request failed:", error);
        response = json({ error: "internal_error", message: "Something went wrong." }, 500);
      }
    }
    if (cors) for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  }

  async #dispatch(
    request: Request,
    url: URL,
    path: string,
    ctx: Pick<ExecutionContext, "waitUntil"> | undefined,
  ): Promise<Response> {
    const method = request.method;
    let segments: string[];
    try {
      segments = path.split("/").filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new AccountError(400, "invalid_request", "Malformed URL.");
    }

    if (path === "/guest" && method === "POST") {
      let id: string = crypto.randomUUID();
      if (request.headers.get("Content-Type")?.includes("application/json")) {
        // Renewing: the same guest, with a fresh token, as long as the old one is still good.
        const body = await readJson(request);
        const old = typeof body.token === "string" ? await verifyJoinToken(this.#secret, body.token) : null;
        if (old && old.name === undefined && old.scope === undefined && !(await this.#hasAccount(old.player))) id = old.player;
      }
      const token = await createJoinToken(this.#secret, { player: id, expiresIn: this.#guestTtl });
      const now = Date.now();
      return json({ id, token, expiresAt: now + this.#guestTtl * 1000, renewAt: now + (this.#guestTtl * 1000) / 2 });
    }
    if (path === "/register" && method === "POST") {
      this.#checkOrigin(request);
      const body = await readJson(request);
      let id: string | undefined;
      if (typeof body.guestToken === "string") {
        const guest = await verifyJoinToken(this.#secret, body.guestToken);
        // A guest who registers keeps their id, and with it what they earned as a guest.
        if (guest && guest.name === undefined) id = guest.player;
      }
      const account = await this.register({
        id,
        name: stringField(body, "name"),
        password: stringField(body, "password"),
        email: typeof body.email === "string" ? body.email : null,
      });
      return this.#signedIn(request, account.id, 201);
    }
    if (path === "/login" && method === "POST") {
      this.#checkOrigin(request);
      const body = await readJson(request);
      const account = await this.signIn(stringField(body, "name"), stringField(body, "password"), address(request));
      return this.#signedIn(request, account.id, 200);
    }
    if (path === "/logout" && method === "POST") {
      this.#checkOrigin(request);
      const token = this.#sessionToken(request);
      if (token) await this.#db.prepare("DELETE FROM tickflare_sessions WHERE token_hash = ?").bind(await sha256(token)).run();
      return new Response(null, { status: 204, headers: { "Set-Cookie": this.#clearCookie(request) } });
    }
    if (path === "/me" && method === "GET") {
      const account = await this.#requireAccount(request);
      return json(await this.ownAccount(account.id));
    }
    if (path === "/me" && method === "DELETE") {
      this.#checkOrigin(request);
      const account = await this.#requireAccount(request);
      const body = await readJson(request);
      await this.#checkPassword(account.id, stringField(body, "password"));
      await this.deleteAccount(account.id);
      return new Response(null, { status: 204, headers: { "Set-Cookie": this.#clearCookie(request) } });
    }
    if (path === "/password" && method === "POST") {
      this.#checkOrigin(request);
      const account = await this.#requireAccount(request);
      const body = await readJson(request);
      await this.#checkPassword(account.id, stringField(body, "current"));
      await this.setPassword(account.id, stringField(body, "next"));
      // Every session ends, this one included; it is replaced with a fresh one.
      return this.#signedIn(request, account.id, 200);
    }
    if (path === "/recovery-code" && method === "POST") {
      this.#checkOrigin(request);
      const account = await this.#requireAccount(request);
      const body = await readJson(request);
      await this.#checkPassword(account.id, stringField(body, "password"));
      return json({ code: await this.createRecoveryCode(account.id) }, 201, { "Cache-Control": "no-store" });
    }
    if (path === "/recover" && method === "POST") {
      this.#checkOrigin(request);
      const body = await readJson(request);
      const account = await this.recoverWithCode(
        stringField(body, "name"),
        stringField(body, "code"),
        stringField(body, "password"),
        address(request),
      );
      return this.#signedIn(request, account.id, 200);
    }
    if (path === "/forgot" && method === "POST") {
      this.#checkOrigin(request);
      const send = this.#sendReset;
      if (!send) throw new AccountError(404, "not_enabled", "This game does not reset passwords by email.");
      const body = await readJson(request);
      const who =
        typeof body.email === "string" && body.email.trim() !== ""
          ? { email: body.email.trim() }
          : { name: stringField(body, "name") };
      // Every request counts, whether or not there is such an account: nobody's inbox is filled this way.
      const keys = [`forgot:${who.email?.toLowerCase() ?? nameKey(who.name!.trim())}`, `forgot-address:${address(request)}`];
      await this.#checkThrottle(keys);
      await this.#recordFailure(keys);
      const work = (async () => {
        for (const reset of await this.startPasswordReset(who)) await send(reset, request);
      })().catch((error) => console.error("[tickflare] could not send a password reset:", error));
      // The answer is the same, and with `ctx` as quick, whether or not anything was sent.
      if (ctx) ctx.waitUntil(work);
      else await work;
      return new Response(null, { status: 204 });
    }
    if (path === "/reset" && method === "POST") {
      this.#checkOrigin(request);
      const body = await readJson(request);
      const account = await this.resetPassword(stringField(body, "token"), stringField(body, "password"));
      return this.#signedIn(request, account.id, 200);
    }
    if (path === "/name" && method === "POST") {
      this.#checkOrigin(request);
      const account = await this.#requireAccount(request);
      const body = await readJson(request);
      await this.rename(account.id, stringField(body, "name"));
      return json(await this.ownAccount(account.id));
    }
    if (path === "/email" && method === "POST") {
      this.#checkOrigin(request);
      const account = await this.#requireAccount(request);
      const body = await readJson(request);
      await this.#checkPassword(account.id, stringField(body, "password"));
      await this.setEmail(account.id, typeof body.email === "string" ? body.email : null);
      return json(await this.ownAccount(account.id));
    }
    if (path === "/export" && method === "GET") {
      const account = await this.#requireAccount(request);
      return new Response(JSON.stringify(await this.exportAccount(account.id), null, 2), {
        headers: {
          "Content-Type": "application/json",
          "Content-Disposition": `attachment; filename="account-${account.id}.json"`,
          "Cache-Control": "no-store",
        },
      });
    }
    if (path === "/token" && method === "POST") {
      this.#checkOrigin(request);
      const account = await this.#requireAccount(request);
      const body = request.headers.get("Content-Type")?.includes("json") ? await readJson(request) : {};
      const scope = typeof body.scope === "string" ? body.scope : undefined;
      const token = await createJoinToken(this.#secret, {
        player: account.id,
        name: account.name,
        scope,
        expiresIn: this.#joinTtl,
      });
      return json({ token, expiresAt: Date.now() + this.#joinTtl * 1000 });
    }
    if (segments[0] === "data" && segments.length === 2) {
      const key = segments[1]!;
      const account = await this.#requireAccount(request);
      if (method === "GET") {
        const value = await this.getData(account.id, key);
        return value === undefined ? json({ error: "not_found", message: "No such key." }, 404) : json({ key, value });
      }
      this.#checkOrigin(request);
      if (this.#policy(key).write !== "owner") throw new AccountError(403, "read_only", `"${key}" can only be set by the game.`);
      if (method === "PUT") {
        const body = await readJson(request);
        if (!("value" in body)) throw new AccountError(400, "invalid_request", "Send { value }.");
        await this.setData(account.id, key, body.value);
        return json({ key, value: body.value });
      }
      if (method === "DELETE") {
        await this.deleteData(account.id, key);
        return new Response(null, { status: 204 });
      }
    }
    if (segments[0] === "players" && segments.length === 2 && method === "GET") {
      const profile = await this.profile(segments[1]!);
      return profile ? json(profile) : json({ error: "not_found", message: "No such player." }, 404);
    }
    if (segments[0] === "leaderboards" && segments.length === 2 && method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      const offset = Number(url.searchParams.get("offset") ?? 0);
      return json(await this.leaderboard(segments[1]!, { limit, offset }), 200, { "Cache-Control": "public, max-age=10" });
    }
    return json({ error: "not_found", message: "No such accounts endpoint." }, 404);
  }

  // --- Accounts ---------------------------------------------------------------------

  /** Creates an account. `id` lets a guest keep theirs; it is made up otherwise. */
  async register(input: { name: string; password: string; email?: string | null; id?: string }): Promise<Identity> {
    await this.migrate();
    const name = this.#normalizeName(input.name);
    checkPassword(input.password);
    const email = normalizeEmail(input.email ?? null);
    const id = input.id ?? crypto.randomUUID();
    const now = Date.now();
    const hash = await hashPassword(input.password);
    try {
      await this.#db
        .prepare(
          "INSERT INTO tickflare_accounts (id, name, name_key, email, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id, name, nameKey(name), email, hash, now, now)
        .run();
    } catch (error) {
      if (String(error).includes("UNIQUE") && String(error).includes("name_key")) {
        throw new AccountError(409, "name_taken", "That name is taken.");
      }
      if (String(error).includes("UNIQUE")) throw new AccountError(409, "account_exists", "This player already has an account.");
      throw error;
    }
    return { id, name, guest: false };
  }

  /** Brings in an account from another service. Its password works through `verifyImportedPassword`. */
  async importAccount(account: ImportedAccount): Promise<void> {
    await this.migrate();
    const name = this.#normalizeName(account.name);
    const createdAt = account.createdAt ?? Date.now();
    await this.#db
      .prepare(
        "INSERT INTO tickflare_accounts (id, name, name_key, email, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(account.id, name, nameKey(name), normalizeEmail(account.email ?? null), account.passwordHash, createdAt, createdAt)
      .run();
  }

  /** Checks a name and password. Repeated failures for one name or one address are refused for a while. */
  async signIn(name: string, password: string, from = "unknown"): Promise<Identity> {
    await this.migrate();
    const keys = [`name:${nameKey(name.trim())}`, `address:${from}`];
    await this.#checkThrottle(keys);
    const row = await this.#db
      .prepare("SELECT id, name, password_hash FROM tickflare_accounts WHERE name_key = ?")
      .bind(nameKey(name.trim()))
      .first<{ id: string; name: string; password_hash: string }>();
    const valid = row ? await this.#verify(row.id, row.password_hash, password) : await hashPassword(password).then(() => false);
    if (!row || !valid) {
      await this.#recordFailure(keys);
      throw new AccountError(401, "invalid_credentials", "Wrong name or password.");
    }
    await this.#db.prepare("DELETE FROM tickflare_sign_in_failures WHERE key = ?").bind(keys[0]).run();
    return { id: row.id, name: row.name, guest: false };
  }

  /** Gives an account another name, if nobody has it. Sessions and join tokens issued later carry the new one. */
  async rename(accountId: string, name: string): Promise<Identity> {
    await this.migrate();
    const normalized = this.#normalizeName(name);
    try {
      const result = await this.#db
        .prepare("UPDATE tickflare_accounts SET name = ?, name_key = ? WHERE id = ?")
        .bind(normalized, nameKey(normalized), accountId)
        .run();
      if (result.meta.changes === 0) throw new AccountError(404, "not_found", "No such account.");
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new AccountError(409, "name_taken", "That name is taken.");
      throw error;
    }
    return { id: accountId, name: normalized, guest: false };
  }

  /** Sets the email address, or removes it with null. */
  async setEmail(accountId: string, email: string | null): Promise<void> {
    await this.migrate();
    await this.#db
      .prepare("UPDATE tickflare_accounts SET email = ? WHERE id = ?")
      .bind(normalizeEmail(email), accountId)
      .run();
  }

  /**
   * Sets a new password, ends every session of the account, and makes any
   * password reset token it was sent useless. Its recovery code stays.
   */
  async setPassword(accountId: string, password: string): Promise<void> {
    checkPassword(password);
    await this.migrate();
    const now = Date.now();
    await this.#db.batch([
      this.#db
        .prepare("UPDATE tickflare_accounts SET password_hash = ?, password_changed_at = ? WHERE id = ?")
        .bind(await hashPassword(password), now, accountId),
      this.#db.prepare("DELETE FROM tickflare_sessions WHERE account_id = ?").bind(accountId),
      this.#db.prepare("DELETE FROM tickflare_recovery WHERE account_id = ? AND kind = 'reset'").bind(accountId),
    ]);
  }

  // --- Recovery ---------------------------------------------------------------------

  /**
   * Makes a recovery code for an account and returns it: twenty letters and
   * digits the player keeps somewhere safe, which set a new password once,
   * with no email involved. It replaces the code the account had, if any.
   * Only its hash is stored, so this is the one time it can be shown.
   */
  async createRecoveryCode(accountId: string): Promise<string> {
    await this.migrate();
    if (!(await this.#hasAccount(accountId))) throw new AccountError(404, "not_found", "No such account.");
    const code = recoveryCode();
    await this.#db.batch([
      this.#db.prepare("DELETE FROM tickflare_recovery WHERE account_id = ? AND kind = 'code'").bind(accountId),
      this.#db
        .prepare("INSERT INTO tickflare_recovery (token_hash, account_id, kind, created_at, expires_at) VALUES (?, ?, 'code', ?, NULL)")
        .bind(await sha256(codeKey(code)), accountId, Date.now()),
    ]);
    return code;
  }

  /**
   * Sets a new password for the account called `name`, given its recovery
   * code, and ends its sessions. The code is used up: make another once
   * signed in. Wrong guesses are counted as wrong passwords are.
   */
  async recoverWithCode(name: string, code: string, password: string, from = "unknown"): Promise<Identity> {
    await this.migrate();
    checkPassword(password);
    const keys = [`recover:${nameKey(name.trim())}`, `address:${from}`];
    await this.#checkThrottle(keys);
    const account = await this.#db
      .prepare("SELECT id, name FROM tickflare_accounts WHERE name_key = ?")
      .bind(nameKey(name.trim()))
      .first<{ id: string; name: string }>();
    // Deleting it is what uses it: of two requests with the same code, one finds it gone.
    const used = account
      ? await this.#db
          .prepare("DELETE FROM tickflare_recovery WHERE token_hash = ? AND account_id = ? AND kind = 'code'")
          .bind(await sha256(codeKey(code)), account.id)
          .run()
      : null;
    if (!account || !used || used.meta.changes === 0) {
      await this.#recordFailure(keys);
      throw new AccountError(401, "invalid_code", "Wrong name or recovery code.");
    }
    await this.setPassword(account.id, password);
    await this.#db.prepare("DELETE FROM tickflare_sign_in_failures WHERE key = ?").bind(keys[0]).run();
    return { id: account.id, name: account.name, guest: false };
  }

  /**
   * Makes a password reset token for the account with this name, or for
   * each account with this email address, and returns what to send to whom.
   * Empty if there is no such account or it has no email address. A token
   * replaces the one the account was sent before. `POST /forgot` calls this
   * and hands each result to `sendPasswordReset`.
   */
  async startPasswordReset(who: { name?: string; email?: string }): Promise<PasswordReset[]> {
    await this.migrate();
    const found =
      who.email !== undefined
        ? await this.#db
            .prepare(`SELECT id, name, email FROM tickflare_accounts WHERE lower(email) = lower(?) ORDER BY created_at LIMIT ${MAX_RESETS_PER_EMAIL}`)
            .bind(who.email.trim())
            .all<{ id: string; name: string; email: string | null }>()
        : await this.#db
            .prepare("SELECT id, name, email FROM tickflare_accounts WHERE name_key = ?")
            .bind(nameKey((who.name ?? "").trim()))
            .all<{ id: string; name: string; email: string | null }>();
    const now = Date.now();
    const expiresAt = now + this.#resetTtl * 1000;
    const resets: PasswordReset[] = [];
    const statements = [this.#db.prepare("DELETE FROM tickflare_recovery WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now)];
    for (const account of found.results) {
      if (!account.email) continue;
      const token = randomToken();
      resets.push({ id: account.id, name: account.name, email: account.email, token, expiresAt });
      statements.push(
        this.#db.prepare("DELETE FROM tickflare_recovery WHERE account_id = ? AND kind = 'reset'").bind(account.id),
        this.#db
          .prepare("INSERT INTO tickflare_recovery (token_hash, account_id, kind, created_at, expires_at) VALUES (?, ?, 'reset', ?, ?)")
          .bind(await sha256(token), account.id, now, expiresAt),
      );
    }
    await this.#db.batch(statements);
    return resets;
  }

  /** Sets a new password with a token from `startPasswordReset`, once, and ends the account's sessions. */
  async resetPassword(token: string, password: string): Promise<Identity> {
    await this.migrate();
    checkPassword(password);
    const hash = await sha256(token);
    const row = await this.#db
      .prepare(
        `SELECT a.id AS id, a.name AS name FROM tickflare_recovery r JOIN tickflare_accounts a ON a.id = r.account_id
         WHERE r.token_hash = ? AND r.kind = 'reset' AND r.expires_at > ?`,
      )
      .bind(hash, Date.now())
      .first<{ id: string; name: string }>();
    const used = row
      ? await this.#db.prepare("DELETE FROM tickflare_recovery WHERE token_hash = ? AND kind = 'reset'").bind(hash).run()
      : null;
    if (!row || !used || used.meta.changes === 0) {
      throw new AccountError(400, "invalid_token", "That link no longer works. Ask for a new one.");
    }
    await this.setPassword(row.id, password);
    return { id: row.id, name: row.name, guest: false };
  }

  /** Starts a session for an account and returns its token. Usually done for you by `/login`. */
  async createSession(accountId: string): Promise<string> {
    await this.migrate();
    const token = randomToken();
    const now = Date.now();
    await this.#db
      .prepare("INSERT INTO tickflare_sessions (token_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), accountId, now, now + this.#sessionTtl)
      .run();
    return token;
  }

  /** Deletes an account, its sessions, data and stats. Match records keep the id, but it no longer resolves to a name. */
  async deleteAccount(accountId: string): Promise<void> {
    await this.migrate();
    await this.#db.batch([
      this.#db.prepare("DELETE FROM tickflare_sessions WHERE account_id = ?").bind(accountId),
      this.#db.prepare("DELETE FROM tickflare_recovery WHERE account_id = ?").bind(accountId),
      this.#db.prepare("DELETE FROM tickflare_player_data WHERE player = ?").bind(accountId),
      this.#db.prepare("DELETE FROM tickflare_player_stats WHERE player = ?").bind(accountId),
      this.#db.prepare("DELETE FROM tickflare_accounts WHERE id = ?").bind(accountId),
    ]);
  }

  /** Everything stored about a player, for them to download. */
  async exportAccount(accountId: string): Promise<Record<string, unknown>> {
    await this.migrate();
    const account = await this.#db
      .prepare("SELECT id, name, email, created_at, password_changed_at FROM tickflare_accounts WHERE id = ?")
      .bind(accountId)
      .first<{ id: string; name: string; email: string | null; created_at: number; password_changed_at: number }>();
    if (!account) throw new AccountError(404, "not_found", "No such account.");
    const sessions = await this.#db
      .prepare("SELECT created_at, expires_at FROM tickflare_sessions WHERE account_id = ? ORDER BY created_at")
      .bind(accountId)
      .all<{ created_at: number; expires_at: number }>();
    let matches: unknown[] = [];
    try {
      const rows = await this.#db
        .prepare(
          "SELECT id, room, ended_at, players, result FROM tickflare_matches WHERE EXISTS (SELECT 1 FROM json_each(players) WHERE value = ?) ORDER BY ended_at",
        )
        .bind(accountId)
        .all<{ id: string; room: string | null; ended_at: number; players: string; result: string }>();
      matches = rows.results.map((row) => ({
        id: row.id,
        room: row.room,
        endedAt: row.ended_at,
        players: JSON.parse(row.players),
        result: JSON.parse(row.result),
      }));
    } catch {
      // No match history in this database.
    }
    return {
      exportedAt: new Date().toISOString(),
      account: {
        id: account.id,
        name: account.name,
        email: account.email,
        createdAt: account.created_at,
        passwordChangedAt: account.password_changed_at,
        recoveryCode: await this.#hasRecoveryCode(accountId),
      },
      sessions: sessions.results.map((session) => ({ createdAt: session.created_at, expiresAt: session.expires_at })),
      data: await this.#allData(accountId),
      stats: await this.stats(accountId),
      matches,
    };
  }

  // --- Profiles -----------------------------------------------------------------------

  /** The account as its owner sees it. */
  async ownAccount(accountId: string): Promise<OwnAccount> {
    await this.migrate();
    const account = await this.#db
      .prepare("SELECT id, name, email, created_at FROM tickflare_accounts WHERE id = ?")
      .bind(accountId)
      .first<{ id: string; name: string; email: string | null; created_at: number }>();
    if (!account) throw new AccountError(404, "not_found", "No such account.");
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      createdAt: account.created_at,
      recoveryCode: await this.#hasRecoveryCode(accountId),
      data: await this.#allData(accountId),
      stats: await this.stats(accountId),
    };
  }

  async #hasRecoveryCode(accountId: string): Promise<boolean> {
    const row = await this.#db
      .prepare("SELECT 1 FROM tickflare_recovery WHERE account_id = ? AND kind = 'code'")
      .bind(accountId)
      .first();
    return row !== null;
  }

  /** A player's public profile, or null if there is no account with that id. */
  async profile(playerId: string): Promise<PublicProfile | null> {
    await this.migrate();
    const account = await this.#db
      .prepare("SELECT id, name, created_at FROM tickflare_accounts WHERE id = ?")
      .bind(playerId)
      .first<{ id: string; name: string; created_at: number }>();
    if (!account) return null;
    const data = await this.#allData(playerId);
    const visible: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) if (this.#policy(key).read === "public") visible[key] = value;
    return { id: account.id, name: account.name, createdAt: account.created_at, data: visible, stats: await this.stats(playerId) };
  }

  /** Account names by player id. Guests and deleted accounts are left out. */
  async names(playerIds: readonly string[]): Promise<Map<string, string>> {
    await this.migrate();
    const names = new Map<string, string>();
    // D1 binds at most 100 parameters per statement.
    for (let start = 0; start < playerIds.length; start += 100) {
      const chunk = playerIds.slice(start, start + 100);
      const rows = await this.#db
        .prepare(`SELECT id, name FROM tickflare_accounts WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
        .all<{ id: string; name: string }>();
      for (const row of rows.results) names.set(row.id, row.name);
    }
    return names;
  }

  // --- Player data ----------------------------------------------------------------------

  /** The value a player has under `key`, or undefined. Server code reads every key, whatever its policy. */
  async getData(playerId: string, key: string): Promise<unknown> {
    checkKey(key);
    await this.migrate();
    const row = await this.#db
      .prepare("SELECT value FROM tickflare_player_data WHERE player = ? AND key = ?")
      .bind(playerId, key)
      .first<{ value: string }>();
    return row ? JSON.parse(row.value) : undefined;
  }

  /** Stores a JSON value for a player. Server code may set any key; clients only those with `write: "owner"`. */
  async setData(playerId: string, key: string, value: unknown): Promise<void> {
    checkKey(key);
    await this.migrate();
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new AccountError(400, "invalid_value", "The value must be JSON.");
    if (encoder.encode(encoded).length > this.#maxDataBytes) {
      throw new AccountError(413, "value_too_large", `A value can be at most ${this.#maxDataBytes} bytes.`);
    }
    const now = Date.now();
    // Inserting is refused once the player has as many keys as allowed; updating an existing one never is.
    const result = await this.#db
      .prepare(
        `INSERT INTO tickflare_player_data (player, key, value, updated_at)
         SELECT ?1, ?2, ?3, ?4
         WHERE EXISTS (SELECT 1 FROM tickflare_player_data WHERE player = ?1 AND key = ?2)
            OR (SELECT COUNT(*) FROM tickflare_player_data WHERE player = ?1) < ?5
         ON CONFLICT (player, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .bind(playerId, key, encoded, now, this.#maxDataKeys)
      .run();
    if (result.meta.changes === 0) {
      throw new AccountError(409, "too_many_keys", `A player can have at most ${this.#maxDataKeys} data keys.`);
    }
  }

  /** Removes a player's value under `key`. Does nothing if there is none. */
  async deleteData(playerId: string, key: string): Promise<void> {
    checkKey(key);
    await this.migrate();
    await this.#db.prepare("DELETE FROM tickflare_player_data WHERE player = ? AND key = ?").bind(playerId, key).run();
  }

  async #allData(playerId: string): Promise<Record<string, unknown>> {
    const rows = await this.#db
      .prepare("SELECT key, value FROM tickflare_player_data WHERE player = ? ORDER BY key")
      .bind(playerId)
      .all<{ key: string; value: string }>();
    return Object.fromEntries(rows.results.map((row) => [row.key, JSON.parse(row.value)]));
  }

  // --- Stats and leaderboards ----------------------------------------------------------------

  /** Adds to a player's stats: `{ wins: 1, kills: 7 }`. Server only: clients cannot write stats. */
  async addStats(playerId: string, increments: Record<string, number>): Promise<void> {
    await this.#writeStats(playerId, increments, "value + excluded.value");
  }

  /** Sets stats to these values. */
  async setStats(playerId: string, values: Record<string, number>): Promise<void> {
    await this.#writeStats(playerId, values, "excluded.value");
  }

  /** Keeps the higher of the stored and the given value: best scores, longest streaks. */
  async maxStats(playerId: string, values: Record<string, number>): Promise<void> {
    await this.#writeStats(playerId, values, "MAX(value, excluded.value)");
  }

  /**
   * Writes several players' stats in one go, once per `key`: a match id, say.
   * Calling it again with the same key changes nothing and returns false, so
   * code that retries after a failure cannot count a result twice. Either all
   * of it is written or none of it.
   */
  async awardStats(
    key: string,
    awards: readonly { player: string; add?: Record<string, number>; set?: Record<string, number>; max?: Record<string, number> }[],
  ): Promise<boolean> {
    await this.migrate();
    if (typeof key !== "string" || key.length === 0 || key.length > 256) throw new AccountError(400, "invalid_key", "An award needs a key.");
    const now = Date.now();
    const statements = [this.#db.prepare("INSERT INTO tickflare_stat_awards (key, awarded_at) VALUES (?, ?)").bind(key, now)];
    for (const award of awards) {
      for (const [values, update] of [
        [award.add, "value + excluded.value"],
        [award.set, "excluded.value"],
        [award.max, "MAX(value, excluded.value)"],
      ] as const) {
        for (const [stat, value] of Object.entries(values ?? {})) statements.push(this.#statStatement(award.player, stat, value, update, now));
      }
    }
    try {
      await this.#db.batch(statements);
      return true;
    } catch (error) {
      if (String(error).includes("UNIQUE") && String(error).includes("tickflare_stat_awards")) return false;
      throw error;
    }
  }

  /** Every stat a player has. */
  async stats(playerId: string): Promise<Record<string, number>> {
    await this.migrate();
    const rows = await this.#db
      .prepare("SELECT stat, value FROM tickflare_player_stats WHERE player = ? ORDER BY stat")
      .bind(playerId)
      .all<{ stat: string; value: number }>();
    return Object.fromEntries(rows.results.map((row) => [row.stat, row.value]));
  }

  /** Several players' stats at once, by player id. `stats` limits it to those stats. Players without any are left out. */
  async statsOf(playerIds: readonly string[], stats?: readonly string[]): Promise<Map<string, Record<string, number>>> {
    await this.migrate();
    stats?.forEach(checkStat);
    const result = new Map<string, Record<string, number>>();
    const unique = [...new Set(playerIds)];
    // D1 binds at most 100 parameters per statement.
    const room = 100 - (stats?.length ?? 0);
    for (let start = 0; start < unique.length; start += room) {
      const chunk = unique.slice(start, start + room);
      const filter = stats ? ` AND stat IN (${stats.map(() => "?").join(",")})` : "";
      const rows = await this.#db
        .prepare(`SELECT player, stat, value FROM tickflare_player_stats WHERE player IN (${chunk.map(() => "?").join(",")})${filter}`)
        .bind(...chunk, ...(stats ?? []))
        .all<{ player: string; stat: string; value: number }>();
      for (const row of rows.results) {
        let entry = result.get(row.player);
        if (!entry) result.set(row.player, (entry = {}));
        entry[row.stat] = row.value;
      }
    }
    return result;
  }

  /** The players with the highest value of a stat. Players without an account are not listed. */
  async leaderboard(stat: string, page: { limit?: number; offset?: number } = {}): Promise<LeaderboardPage> {
    checkStat(stat);
    await this.migrate();
    const limit = clamp(page.limit ?? 20, 1, 100);
    const offset = clamp(page.offset ?? 0, 0, 1_000_000);
    const [rows, total] = await this.#db.batch([
      this.#db
        .prepare(
          `SELECT s.player AS id, a.name AS name, s.value AS value,
                  (SELECT COUNT(*) FROM tickflare_player_stats o JOIN tickflare_accounts oa ON oa.id = o.player
                   WHERE o.stat = s.stat AND o.value > s.value) + 1 AS rank
           FROM tickflare_player_stats s JOIN tickflare_accounts a ON a.id = s.player
           WHERE s.stat = ? ORDER BY s.value DESC, a.name_key LIMIT ? OFFSET ?`,
        )
        .bind(stat, limit, offset),
      this.#db
        .prepare("SELECT COUNT(*) AS total FROM tickflare_player_stats s JOIN tickflare_accounts a ON a.id = s.player WHERE s.stat = ?")
        .bind(stat),
    ]);
    return {
      stat,
      entries: (rows!.results as unknown as LeaderboardEntry[]).map((entry) => ({ ...entry })),
      total: (total!.results[0] as { total: number } | undefined)?.total ?? 0,
    };
  }

  /** A player's place on a leaderboard, or null if they have no value for that stat. */
  async rank(stat: string, playerId: string): Promise<Pick<LeaderboardEntry, "rank" | "value"> | null> {
    checkStat(stat);
    await this.migrate();
    const row = await this.#db
      .prepare(
        `SELECT s.value AS value,
                (SELECT COUNT(*) FROM tickflare_player_stats o JOIN tickflare_accounts oa ON oa.id = o.player
                 WHERE o.stat = s.stat AND o.value > s.value) + 1 AS rank
         FROM tickflare_player_stats s WHERE s.stat = ? AND s.player = ?`,
      )
      .bind(stat, playerId)
      .first<{ value: number; rank: number }>();
    return row ? { rank: row.rank, value: row.value } : null;
  }

  async #writeStats(playerId: string, values: Record<string, number>, update: string): Promise<void> {
    await this.migrate();
    const now = Date.now();
    const statements = Object.entries(values).map(([stat, value]) => this.#statStatement(playerId, stat, value, update, now));
    if (statements.length > 0) await this.#db.batch(statements);
  }

  #statStatement(playerId: string, stat: string, value: number, update: string, now: number): D1PreparedStatement {
    checkStat(stat);
    if (!Number.isFinite(value)) throw new AccountError(400, "invalid_value", `${stat} must be a finite number.`);
    return this.#db
      .prepare(
        `INSERT INTO tickflare_player_stats (player, stat, value, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (player, stat) DO UPDATE SET value = ${update}, updated_at = excluded.updated_at`,
      )
      .bind(playerId, stat, value, now);
  }

  // --- Internals ---------------------------------------------------------------------------

  #policy(key: string): Required<DataPolicy> {
    const policy = this.#policies[key] ?? {};
    return { read: policy.read ?? "owner", write: policy.write ?? "server" };
  }

  #sessionToken(request: Request): string | null {
    return cookieValue(request.headers.get("Cookie"), this.#cookie) ?? bearerSession(request);
  }

  async #accountForSession(token: string): Promise<{ id: string; name: string } | null> {
    await this.migrate();
    const hash = await sha256(token);
    const now = Date.now();
    const row = await this.#db
      .prepare(
        `SELECT a.id AS id, a.name AS name, s.expires_at AS expires_at
         FROM tickflare_sessions s JOIN tickflare_accounts a ON a.id = s.account_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .bind(hash, now)
      .first<{ id: string; name: string; expires_at: number }>();
    if (!row) return null;
    // Sliding expiry, written at most once a day.
    if (row.expires_at - now < this.#sessionTtl - SESSION_REFRESH_MS) {
      await this.#db.prepare("UPDATE tickflare_sessions SET expires_at = ? WHERE token_hash = ?").bind(now + this.#sessionTtl, hash).run();
    }
    return { id: row.id, name: row.name };
  }

  async #requireAccount(request: Request): Promise<{ id: string; name: string }> {
    const token = this.#sessionToken(request);
    const account = token ? await this.#accountForSession(token) : null;
    if (!account) throw new AccountError(401, "not_signed_in", "Sign in first.");
    return account;
  }

  async #signedIn(request: Request, accountId: string, status: number): Promise<Response> {
    const token = await this.createSession(accountId);
    const account = await this.ownAccount(accountId);
    return json({ account, token }, status, { "Set-Cookie": this.#setCookie(request, token) });
  }

  async #checkPassword(accountId: string, password: string): Promise<void> {
    const row = await this.#db
      .prepare("SELECT password_hash FROM tickflare_accounts WHERE id = ?")
      .bind(accountId)
      .first<{ password_hash: string }>();
    if (!row || !(await this.#verify(accountId, row.password_hash, password))) {
      throw new AccountError(403, "wrong_password", "That password is not right.");
    }
  }

  /** Verifies a password, and upgrades a hash imported from elsewhere once it has been checked. */
  async #verify(accountId: string, hash: string, password: string): Promise<boolean> {
    if (hash.startsWith("pbkdf2$")) return verifyPassword(hash, password);
    if (!this.#verifyImported || !(await this.#verifyImported(hash, password))) return false;
    await this.#db
      .prepare("UPDATE tickflare_accounts SET password_hash = ? WHERE id = ?")
      .bind(await hashPassword(password), accountId)
      .run();
    return true;
  }

  async #checkThrottle(keys: string[]): Promise<void> {
    const rows = await this.#db
      .prepare(`SELECT key, failures, window_start FROM tickflare_sign_in_failures WHERE key IN (${keys.map(() => "?").join(",")})`)
      .bind(...keys)
      .all<{ key: string; failures: number; window_start: number }>();
    const now = Date.now();
    for (const row of rows.results) {
      if (now - row.window_start >= FAILURE_WINDOW_MS) continue;
      const limit = row.key.startsWith("forgot:")
        ? MAX_RESET_REQUESTS
        : row.key.startsWith("address:") || row.key.startsWith("forgot-address:")
          ? MAX_FAILURES_PER_ADDRESS
          : MAX_FAILURES_PER_NAME;
      if (row.failures >= limit) {
        throw new AccountError(429, "too_many_attempts", "Too many attempts. Try again in a few minutes.");
      }
    }
  }

  async #recordFailure(keys: string[]): Promise<void> {
    const now = Date.now();
    await this.#db.batch(
      keys.map((key) =>
        this.#db
          .prepare(
            `INSERT INTO tickflare_sign_in_failures (key, failures, window_start) VALUES (?1, 1, ?2)
             ON CONFLICT (key) DO UPDATE SET
               failures = CASE WHEN ?2 - window_start >= ?3 THEN 1 ELSE failures + 1 END,
               window_start = CASE WHEN ?2 - window_start >= ?3 THEN ?2 ELSE window_start END`,
          )
          .bind(key, now, FAILURE_WINDOW_MS),
      ),
    );
  }

  /** Whether the request comes from no page at all, a page on the API's own origin, or an allowed one. */
  #originAllowed(request: Request): boolean {
    const origin = request.headers.get("Origin");
    // Requests without an Origin header do not come from another site's page.
    if (!origin) return true;
    return origin === new URL(request.url).origin || this.#origins.has(origin);
  }

  /** Refuses writes from other sites' pages, which would otherwise carry the player's cookie. */
  #checkOrigin(request: Request): void {
    if (!this.#originAllowed(request)) {
      throw new AccountError(403, "origin_not_allowed", "This page is not allowed to use the account service.");
    }
  }

  /** CORS headers for an allowed origin other than the API's own, or null. */
  #corsHeaders(request: Request): Record<string, string> | null {
    const origin = request.headers.get("Origin");
    if (!origin || !this.#origins.has(origin)) return null;
    return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
  }

  async #hasAccount(playerId: string): Promise<boolean> {
    await this.migrate();
    return (await this.#db.prepare("SELECT 1 FROM tickflare_accounts WHERE id = ?").bind(playerId).first()) !== null;
  }

  #setCookie(request: Request, token: string): string {
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    // A page on an allowed origin of its own can only use the cookie if it is sent cross-site.
    const origin = request.headers.get("Origin");
    const crossSite = secure && origin !== null && this.#origins.has(origin) ? "None" : this.#sameSite;
    return `${this.#cookie}=${token}; Path=/; HttpOnly; SameSite=${crossSite}; Max-Age=${Math.floor(this.#sessionTtl / 1000)}${secure}`;
  }

  #clearCookie(request: Request): string {
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return `${this.#cookie}=; Path=/; HttpOnly; SameSite=${this.#sameSite}; Max-Age=0${secure}`;
  }
}

// --- Passwords -----------------------------------------------------------------------------------

/** A PBKDF2-SHA256 hash, as `pbkdf2$sha256$<iterations>$<salt>$<hash>` in base64url. */
export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2$sha256$${iterations}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

/** Whether `password` matches a hash made by `hashPassword`, in constant time. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const [scheme, digest, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || digest !== "sha256" || !iterations || !salt || !hash) return false;
  const expected = fromBase64Url(hash);
  const actual = await pbkdf2(password, fromBase64Url(salt), Number(iterations));
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual[index]! ^ expected[index]!;
  return difference === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

// --- Small helpers -----------------------------------------------------------------------------------

function normalizeName(input: string): string {
  const name = input.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!NAME_PATTERN.test(name)) {
    throw new AccountError(
      400,
      "invalid_name",
      "A name is 3 to 24 letters, digits, spaces, dots, dashes or underscores, starting and ending with a letter or digit.",
    );
  }
  return name;
}

/** What makes two names the same name: case and look-alike forms do not count. */
function nameKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[\s_.-]+/g, "");
}

function normalizeEmail(input: string | null): string | null {
  if (input === null || input.trim() === "") return null;
  const email = input.trim();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AccountError(400, "invalid_email", "That email address does not look right.");
  }
  return email;
}

function checkPassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new AccountError(400, "weak_password", `A password is at least ${MIN_PASSWORD} characters.`);
  }
}

function checkKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new AccountError(400, "invalid_key", "Keys are 1 to 64 letters, digits, dots, dashes or underscores.");
}

function checkStat(stat: string): void {
  if (!STAT_PATTERN.test(stat)) throw new AccountError(400, "invalid_stat", "Stats are 1 to 64 letters, digits, dots, dashes or underscores.");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.includes("application/json")) {
    throw new AccountError(415, "json_required", "Send JSON with Content-Type: application/json.");
  }
  try {
    const body = (await request.json()) as unknown;
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    throw new AccountError(400, "invalid_request", "The body is not a JSON object.");
  }
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw new AccountError(400, "invalid_request", `Send "${field}" as a string.`);
  return value;
}

function bearer(request: Request): string | null {
  return request.headers.get("Authorization")?.match(/^Bearer (\S+)$/)?.[1] ?? null;
}

/** A session token sent as a bearer token. Join tokens are signed ("v1.…"); session tokens are opaque. */
function bearerSession(request: Request): string | null {
  const token = bearer(request);
  return token && !token.startsWith("v1.") ? token : null;
}

function address(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;
}

/** A recovery code: twenty characters, a hundred bits, in four groups to read and type. */
function recoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const letters = Array.from(bytes, (byte) => CODE_ALPHABET[byte & 31]).join("");
  return letters.match(/.{5}/g)!.join("-");
}

/** A recovery code as it is hashed: however it was typed, with the characters people mistake put right. */
function codeKey(code: string): string {
  return code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function randomToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
