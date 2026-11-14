import type { TokenSource } from "./token.js";

/*
 * The client side of `Accounts`: sign up, sign in, a guest identity before
 * that, the player's own data, profiles and leaderboards.
 */

/** Where the accounts API is and how the session travels. Every option has a default. */
export interface AccountClientOptions {
  /** Where the Worker is, e.g. "https://game.example.com". Defaults to the page's own origin. */
  baseUrl?: string;
  /** Where the accounts API is served. Default "/api/accounts". */
  prefix?: string;
  /**
   * How the session travels. "cookie" (the default in browsers): an HttpOnly
   * cookie the page's scripts never see. "bearer" (the default elsewhere):
   * the client keeps the session token and sends it with every request; pass
   * `session` to restore one and `onSession` to keep it.
   */
  mode?: "cookie" | "bearer";
  /** A session token to start with, in bearer mode. */
  session?: string | null;
  /** Called when the session token changes, in bearer mode: store it to stay signed in. */
  onSession?(token: string | null): void;
  /** Where to keep the guest identity between visits. Defaults to `localStorage` when there is one. */
  storage?: KeyValueStore | null;
  /** The fetch to use. Defaults to the global one. */
  fetch?: typeof fetch;
}

/** The signed-in player's own account, as `GET /me` returns it. */
export interface Account {
  /** The player id. A guest who registered keeps theirs. */
  id: string;
  /** The account name. */
  name: string;
  /** The email address, if one was given. */
  email: string | null;
  /** When the account was made, in epoch milliseconds. */
  createdAt: number;
  /** Whether the account has a recovery code. */
  recoveryCode: boolean;
  /** Every data key the player has, private ones included. */
  data: Record<string, unknown>;
  /** Every stat the player has. */
  stats: Record<string, number>;
}

/** What anyone may see of a player. */
export interface Profile {
  /** The player id. */
  id: string;
  /** The account name. */
  name: string;
  /** When the account was made, in epoch milliseconds. */
  createdAt: number;
  /** The data keys the game made public. */
  data: Record<string, unknown>;
  /** Every stat the player has. */
  stats: Record<string, number>;
}

/** One line of a leaderboard. */
export interface LeaderboardLine {
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
export interface Leaderboard {
  /** The stat it ranks. */
  stat: string;
  /** This page's lines. */
  entries: LeaderboardLine[];
  /** Players with a value for this stat, in total. */
  total: number;
}

/** A guest identity: a player id with a join token, before or instead of an account. */
export interface Guest {
  /** The guest's player id. */
  id: string;
  /** A join token for `id`. */
  token: string;
  /** When the token stops working, in epoch milliseconds. */
  expiresAt: number;
  /** When the client renews it for the same id, in epoch milliseconds. */
  renewAt: number;
}

/** A request the accounts API refused. `code` is machine-readable, e.g. "name_taken" or "invalid_credentials". */
export class AccountRequestError extends Error {
  /** The HTTP status, e.g. 409. */
  readonly status: number;
  /** Machine-readable, e.g. `name_taken`. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "AccountRequestError";
    this.status = status;
    this.code = code;
  }
}

/** The part of `localStorage` the client uses. */
export interface KeyValueStore {
  /** The value under `key`, or null. */
  getItem(key: string): string | null;
  /** Stores `value` under `key`. */
  setItem(key: string, value: string): void;
  /** Removes `key`. */
  removeItem(key: string): void;
}

const GUEST_KEY = "tickflare.guest";
/** What a browser has, seen from code that is not typed for one. */
const browser = globalThis as { document?: unknown; location?: { origin: string }; localStorage?: KeyValueStore };

/**
 * The client side of `Accounts`: a guest identity until the player signs up,
 * sign-up and sign-in, the player's own data, profiles and leaderboards.
 *
 *     const accounts = new AccountClient();
 *     await accounts.restore();
 *     const room = new RoomClient(url, { token: accounts.tokenSource });
 */
export class AccountClient {
  #account: Account | null = null;

  readonly #base: string;
  readonly #mode: "cookie" | "bearer";
  readonly #fetch: typeof fetch;
  readonly #storage: AccountClientOptions["storage"];
  readonly #onSession: AccountClientOptions["onSession"];
  #session: string | null;
  #guest: Guest | null = null;
  #listeners = new Set<(account: Account | null) => void>();

  constructor(options: AccountClientOptions = {}) {
    const inBrowser = browser.document !== undefined;
    const origin = options.baseUrl ?? browser.location?.origin ?? "";
    this.#base = `${origin.replace(/\/+$/, "")}${(options.prefix ?? "/api/accounts").replace(/\/+$/, "")}`;
    this.#mode = options.mode ?? (inBrowser ? "cookie" : "bearer");
    this.#session = options.session ?? null;
    this.#onSession = options.onSession;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#storage = options.storage !== undefined ? options.storage : (browser.localStorage ?? null);
  }

  /** The signed-in account, once `restore`, `login` or `register` has found one. */
  get account(): Account | null {
    return this.#account;
  }

  /** Whether someone is signed in. */
  get signedIn(): boolean {
    return this.#account !== null;
  }

  /** The player id to use: the account's, else the guest's, else undefined. */
  get playerId(): string | undefined {
    return this.#account?.id ?? this.#guest?.id ?? this.#storedGuest()?.id;
  }

  /** Calls `listener` whenever the signed-in account changes. Returns a function that stops it. */
  onChange(listener: (account: Account | null) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Finds out whether a session is still good. Call once at startup. */
  async restore(): Promise<Account | null> {
    if (this.#mode === "bearer" && !this.#session) return this.#setAccount(null);
    try {
      return this.#setAccount(await this.#request<Account>("GET", "/me"));
    } catch (error) {
      if (error instanceof AccountRequestError && error.status === 401) {
        this.#setSession(null);
        return this.#setAccount(null);
      }
      throw error;
    }
  }

  /** Creates an account and signs in. A guest who registers keeps their player id. */
  async register(input: { name: string; password: string; email?: string }): Promise<Account> {
    const guest = this.#guest ?? this.#storedGuest();
    const body = guest && guest.expiresAt > Date.now() ? { ...input, guestToken: guest.token } : input;
    const result = await this.#request<{ account: Account; token: string }>("POST", "/register", body);
    this.#forgetGuest();
    this.#setSession(result.token);
    this.#setAccount(result.account);
    return result.account;
  }

  /** Signs in. Rejects with `AccountRequestError` (`invalid_credentials`, `too_many_attempts`) if it cannot. */
  async login(name: string, password: string): Promise<Account> {
    const result = await this.#request<{ account: Account; token: string }>("POST", "/login", { name, password });
    this.#setSession(result.token);
    this.#setAccount(result.account);
    return result.account;
  }

  /** Ends the session, on the server and here. */
  async logout(): Promise<void> {
    try {
      await this.#request("POST", "/logout");
    } finally {
      this.#setSession(null);
      this.#setAccount(null);
    }
  }

  /** Changes the password. Every other session of the account is signed out. */
  async changePassword(current: string, next: string): Promise<void> {
    const result = await this.#request<{ account: Account; token: string }>("POST", "/password", { current, next });
    this.#setSession(result.token);
    this.#setAccount(result.account);
  }

  /**
   * Makes a recovery code and returns it: show it to the player once, to
   * keep somewhere safe. It sets a new password with `recover`, with no
   * email involved, and replaces the code the account had. Needs the password.
   */
  async createRecoveryCode(password: string): Promise<string> {
    const result = await this.#request<{ code: string }>("POST", "/recovery-code", { password });
    if (this.#account) this.#setAccount({ ...this.#account, recoveryCode: true });
    return result.code;
  }

  /**
   * Sets a new password with a recovery code, and signs in. The code is used
   * up. Rejects with `AccountRequestError` (`invalid_code`, `too_many_attempts`).
   */
  async recover(name: string, code: string, password: string): Promise<Account> {
    const result = await this.#request<{ account: Account; token: string }>("POST", "/recover", { name, code, password });
    this.#setSession(result.token);
    this.#setAccount(result.account);
    return result.account;
  }

  /**
   * Asks for a password reset link to be sent to the account with this name,
   * or to every account with this email address. It resolves whether or not
   * there is such an account, so as not to tell. Rejects with `not_enabled`
   * if the game does not send email.
   */
  async forgotPassword(who: { name: string } | { email: string }): Promise<void> {
    await this.#request("POST", "/forgot", who);
  }

  /** Sets a new password with the token from a reset link, and signs in. Rejects with `invalid_token`. */
  async resetPassword(token: string, password: string): Promise<Account> {
    const result = await this.#request<{ account: Account; token: string }>("POST", "/reset", { token, password });
    this.#setSession(result.token);
    this.#setAccount(result.account);
    return result.account;
  }

  /** Takes another name. */
  async rename(name: string): Promise<Account> {
    const account = await this.#request<Account>("POST", "/name", { name });
    this.#account = account;
    return account;
  }

  /** Sets the email address, or removes it with null. Needs the password. */
  async setEmail(password: string, email: string | null): Promise<Account> {
    const account = await this.#request<Account>("POST", "/email", { password, email });
    this.#account = account;
    return account;
  }

  /** Deletes the account and everything stored with it. */
  async deleteAccount(password: string): Promise<void> {
    await this.#request("DELETE", "/me", { password });
    this.#setSession(null);
    this.#setAccount(null);
  }

  /** Everything the server keeps about the signed-in player. */
  async exportData(): Promise<Record<string, unknown>> {
    return this.#request("GET", "/export");
  }

  /**
   * A guest identity, made on first use and kept in `storage`. Its token is
   * renewed, for the same player id, once it is half way to expiring; a
   * guest who stays away until it has expired starts over as a new player.
   */
  async guest(): Promise<Guest> {
    const known = this.#guest ?? this.#storedGuest();
    if (known && known.renewAt > Date.now()) return (this.#guest = known);
    const guest = await this.#request<Guest>("POST", "/guest", known ? { token: known.token } : undefined);
    this.#guest = guest;
    try {
      this.#storage?.setItem(GUEST_KEY, JSON.stringify(guest));
    } catch {
      // Storage full or blocked: the guest lasts for this visit.
    }
    return guest;
  }

  /** A short-lived join token for a room or queue, for the signed-in player. */
  async joinToken(scope?: string): Promise<string> {
    const result = await this.#request<{ token: string }>("POST", "/token", scope === undefined ? {} : { scope });
    return result.token;
  }

  /**
   * For `RoomClient`'s `token` option: a join token for the signed-in player,
   * or the guest's token for anyone else.
   */
  readonly tokenSource: TokenSource = async (room) => {
    if (this.#account) return this.joinToken(room);
    return (await this.guest()).token;
  };

  /** The signed-in player's value under `key`, or undefined. */
  async getData<T = unknown>(key: string): Promise<T | undefined> {
    try {
      return (await this.#request<{ value: T }>("GET", `/data/${encodeURIComponent(key)}`)).value;
    } catch (error) {
      if (error instanceof AccountRequestError && error.status === 404) return undefined;
      throw error;
    }
  }

  /** Stores a value under a key the game lets players write. */
  async setData(key: string, value: unknown): Promise<void> {
    await this.#request("PUT", `/data/${encodeURIComponent(key)}`, { value });
    if (this.#account) this.#account = { ...this.#account, data: { ...this.#account.data, [key]: value } };
  }

  /** Removes a value under a key the game lets players write. */
  async deleteData(key: string): Promise<void> {
    await this.#request("DELETE", `/data/${encodeURIComponent(key)}`);
    if (this.#account) {
      const { [key]: _removed, ...data } = this.#account.data;
      this.#account = { ...this.#account, data };
    }
  }

  /** A player's public profile, or null if there is no such account. */
  async profile(playerId: string): Promise<Profile | null> {
    try {
      return await this.#request<Profile>("GET", `/players/${encodeURIComponent(playerId)}`);
    } catch (error) {
      if (error instanceof AccountRequestError && error.status === 404) return null;
      throw error;
    }
  }

  /** A page of the leaderboard for `stat`, highest first. */
  async leaderboard(stat: string, page: { limit?: number; offset?: number } = {}): Promise<Leaderboard> {
    const query = new URLSearchParams();
    if (page.limit !== undefined) query.set("limit", String(page.limit));
    if (page.offset !== undefined) query.set("offset", String(page.offset));
    const suffix = query.size > 0 ? `?${query}` : "";
    return this.#request("GET", `/leaderboards/${encodeURIComponent(stat)}${suffix}`);
  }

  async #request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.#mode === "bearer" && this.#session) headers.Authorization = `Bearer ${this.#session}`;
    const init: RequestInit & { credentials?: "include" } = {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    };
    // So the cookie also travels when the API is on another origin. Not set otherwise:
    // runtimes other than browsers may not know the option.
    if (this.#mode === "cookie") init.credentials = "include";
    const response = await this.#fetch(`${this.#base}${path}`, init);
    if (response.status === 204) return undefined as T;
    const payload = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    if (!response.ok) {
      throw new AccountRequestError(response.status, payload?.error ?? "request_failed", payload?.message ?? response.statusText);
    }
    return payload as T;
  }

  #setSession(token: string | null): void {
    if (this.#mode !== "bearer" || this.#session === token) return;
    this.#session = token;
    this.#onSession?.(token);
  }

  #setAccount(account: Account | null): Account | null {
    const changed = this.#account?.id !== account?.id;
    this.#account = account;
    if (changed) for (const listener of this.#listeners) listener(account);
    return account;
  }

  #storedGuest(): Guest | null {
    try {
      const raw = this.#storage?.getItem(GUEST_KEY);
      const guest = raw ? (JSON.parse(raw) as Guest) : null;
      return guest && typeof guest.token === "string" && guest.expiresAt > Date.now() ? guest : null;
    } catch {
      return null;
    }
  }

  #forgetGuest(): void {
    this.#guest = null;
    try {
      this.#storage?.removeItem(GUEST_KEY);
    } catch {
      // Nothing to forget.
    }
  }
}
