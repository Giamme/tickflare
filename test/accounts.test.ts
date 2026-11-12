import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AccountClient, AccountRequestError } from "../src/client/accounts.js";
import { hashPassword, verifyPassword } from "../src/server/accounts.js";
import { createJoinToken } from "../src/server/tokens.js";
import { MATCHES_SCHEMA } from "../src/server/matches.js";
import { freshRoom, sleep, upgrade } from "./helpers.js";
import { TEST_SECRET, testAccounts } from "./worker.js";

const BASE = "https://tickflare.test";
const PASSWORD = "correct horse battery";
let names = 0;

/** A name no other test uses. */
function freshName(): string {
  return `p${Date.now().toString(36)}${names++}`;
}

function call(
  method: string,
  path: string,
  options: { body?: unknown; session?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (options.session) headers.Cookie = `tf_session=${options.session}`;
  return exports.default.fetch(`${BASE}/api/accounts${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function register(name = freshName(), extra: Record<string, unknown> = {}) {
  const response = await call("POST", "/register", { body: { name, password: PASSWORD, ...extra } });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { account: { id: string; name: string }; token: string };
  return { ...body.account, session: body.token, cookie: response.headers.get("Set-Cookie")! };
}

/** Opens a WebSocket and returns the welcome's `you` and the room's log. */
async function join(path: string, headers: Record<string, string> = {}) {
  const response = await upgrade(path, headers);
  if (response.status !== 101) return { status: response.status };
  const ws = response.webSocket!;
  const welcome = new Promise<{ you: string; state: { log: string[] } }>((resolve) => {
    ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true });
  });
  ws.accept();
  const message = await welcome;
  ws.close(1000, "test_done");
  return { status: 101, you: message.you, log: message.state.log };
}

describe("signing up and in", () => {
  it("creates an account, signs it in with an HttpOnly cookie, and never hands out the password hash", async () => {
    const name = freshName();
    const account = await register(name, { email: "ada@example.com" });

    expect(account.name).toBe(name);
    expect(account.cookie).toMatch(/^tf_session=[\w-]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/);

    const me = await call("GET", "/me", { session: account.session });
    expect(me.status).toBe(200);
    const body = await me.json();
    expect(body).toMatchObject({ id: account.id, name, email: "ada@example.com", data: {}, stats: {} });
    expect(JSON.stringify(body)).not.toContain("pbkdf2");

    // The same session works as a bearer token, for clients without cookies.
    const bearer = await exports.default.fetch(`${BASE}/api/accounts/me`, {
      headers: { Authorization: `Bearer ${account.session}` },
    });
    expect(bearer.status).toBe(200);
  });

  it("refuses names that are taken in any case or spelling, and names that break the rules", async () => {
    const name = freshName();
    await register(name);
    for (const taken of [name.toUpperCase(), `${name.slice(0, 2)}.${name.slice(2)}`]) {
      const response = await call("POST", "/register", { body: { name: taken, password: PASSWORD } });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: "name_taken" });
    }
    for (const bad of ["ab", " ", "-dash-first", "x".repeat(25), "nul\u0000name", "<script>"]) {
      const response = await call("POST", "/register", { body: { name: bad, password: PASSWORD } });
      expect(response.status, bad).toBe(400);
    }
  });

  it("refuses short passwords, malformed emails and bodies that are not JSON", async () => {
    expect((await call("POST", "/register", { body: { name: freshName(), password: "short" } })).status).toBe(400);
    const email = await call("POST", "/register", { body: { name: freshName(), password: PASSWORD, email: "nope" } });
    expect(await email.json()).toMatchObject({ error: "invalid_email" });
    const form = await exports.default.fetch(`${BASE}/api/accounts/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=a&password=b",
    });
    expect(form.status).toBe(415);
  });

  it("signs in with the right password only, and signs out", async () => {
    const { name } = await register();
    const wrong = await call("POST", "/login", { body: { name, password: "not the password" } });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ error: "invalid_credentials" });
    const nobody = await call("POST", "/login", { body: { name: freshName(), password: PASSWORD } });
    expect(nobody.status).toBe(401);

    // Names are matched the way they are compared for uniqueness.
    const login = await call("POST", "/login", { body: { name: name.toUpperCase(), password: PASSWORD } });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    expect((await call("GET", "/me", { session: token })).status).toBe(200);

    const logout = await call("POST", "/logout", { session: token });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await call("GET", "/me", { session: token })).status).toBe(401);
  });

  it("holds off a name after ten failed sign-ins, even with the right password", async () => {
    const { name } = await register();
    const from = { "CF-Connecting-IP": `198.51.100.${names % 250}` };
    for (let i = 0; i < 10; i++) {
      const response = await call("POST", "/login", { body: { name, password: `wrong ${i}` }, headers: from });
      expect(response.status).toBe(401);
    }
    const locked = await call("POST", "/login", { body: { name, password: PASSWORD }, headers: from });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toMatchObject({ error: "too_many_attempts" });
  });

  it("changes the password, signing out every other session", async () => {
    const account = await register();
    const other = (await (await call("POST", "/login", { body: { name: account.name, password: PASSWORD } })).json()) as {
      token: string;
    };

    const refused = await call("POST", "/password", { session: account.session, body: { current: "nope nope", next: "a new password" } });
    expect(refused.status).toBe(403);

    const changed = await call("POST", "/password", { session: account.session, body: { current: PASSWORD, next: "a new password" } });
    expect(changed.status).toBe(200);
    const { token } = (await changed.json()) as { token: string };

    expect((await call("GET", "/me", { session: account.session })).status).toBe(401);
    expect((await call("GET", "/me", { session: other.token })).status).toBe(401);
    expect((await call("GET", "/me", { session: token })).status).toBe(200);
    expect((await call("POST", "/login", { body: { name: account.name, password: PASSWORD } })).status).toBe(401);
    expect((await call("POST", "/login", { body: { name: account.name, password: "a new password" } })).status).toBe(200);
  });
});

describe("names and email addresses", () => {
  it("can be changed: a new name if it is free, an email address with the password", async () => {
    const account = await register();
    const other = await register();
    const taken = await call("POST", "/name", { session: account.session, body: { name: other.name.toUpperCase() } });
    expect(taken.status).toBe(409);

    const next = freshName();
    const renamed = await call("POST", "/name", { session: account.session, body: { name: next } });
    expect(await renamed.json()).toMatchObject({ id: account.id, name: next });
    expect((await call("POST", "/login", { body: { name: next, password: PASSWORD } })).status).toBe(200);
    expect((await call("POST", "/login", { body: { name: account.name, password: PASSWORD } })).status).toBe(401);
    // The old name is free again.
    await register(account.name);

    const noPassword = await call("POST", "/email", { session: account.session, body: { password: "nope nope", email: "a@b.co" } });
    expect(noPassword.status).toBe(403);
    const email = await call("POST", "/email", { session: account.session, body: { password: PASSWORD, email: "a@b.co" } });
    expect(await email.json()).toMatchObject({ email: "a@b.co" });
    const cleared = await call("POST", "/email", { session: account.session, body: { password: PASSWORD, email: null } });
    expect(await cleared.json()).toMatchObject({ email: null });
  });
});

describe("guests", () => {
  it("get an id and a token, renew it for the same id, and keep the id when they register", async () => {
    const guest = (await (await call("POST", "/guest")).json()) as { id: string; token: string };
    const renewed = (await (await call("POST", "/guest", { body: { token: guest.token } })).json()) as { id: string; token: string };
    expect(renewed.id).toBe(guest.id);

    const room = freshRoom();
    const asGuest = await join(`/named/${room}?token=${renewed.token}`);
    expect(asGuest).toMatchObject({ status: 101, you: guest.id });
    expect(asGuest.log).toContain(`join:${guest.id}:-`);

    const account = await register(freshName(), { guestToken: guest.token });
    expect(account.id).toBe(guest.id);

    // The guest token now speaks for an account, so it no longer opens anything, nor renews.
    expect((await join(`/named/${freshRoom()}?token=${renewed.token}`)).status).toBe(401);
    const again = (await (await call("POST", "/guest", { body: { token: guest.token } })).json()) as { id: string };
    expect(again.id).not.toBe(guest.id);
    // Nor can it be used to register a second account.
    const twice = await call("POST", "/register", { body: { name: freshName(), password: PASSWORD, guestToken: guest.token } });
    expect(twice.status).toBe(409);
  });

  it("are turned away from rooms that need an account", async () => {
    const guest = (await (await call("POST", "/guest")).json()) as { token: string };
    expect((await join(`/members/${freshRoom()}?token=${guest.token}`)).status).toBe(401);
    expect((await join(`/members/${freshRoom()}`)).status).toBe(401);
  });
});

describe("players in rooms", () => {
  it("are known by their account and name when they connect with the session cookie", async () => {
    const account = await register();
    const room = freshRoom();
    const joined = await join(`/named/${room}`, { Cookie: `tf_session=${account.session}` });
    expect(joined).toMatchObject({ status: 101, you: account.id });
    expect(joined.log).toContain(`join:${account.id}:${account.name}`);
    expect((await join(`/members/${room}`, { Cookie: `tf_session=${account.session}` })).status).toBe(101);
  });

  it("cannot be impersonated with a cookie sent by another site's page", async () => {
    const account = await register();
    const cookie = `tf_session=${account.session}`;
    expect((await join(`/named/${freshRoom()}`, { Cookie: cookie, Origin: "https://evil.test" })).status).toBe(401);
    expect((await join(`/named/${freshRoom()}`, { Cookie: cookie, Origin: "https://allowed.test" })).status).toBe(101);
    expect((await join(`/named/${freshRoom()}`, { Cookie: cookie, Origin: BASE })).status).toBe(101);
  });

  it("can carry their name in a join token scoped to a room", async () => {
    const account = await register();
    const room = freshRoom();
    const response = await call("POST", "/token", { session: account.session, body: { scope: room } });
    const { token } = (await response.json()) as { token: string };

    const joined = await join(`/named/${room}?token=${token}`);
    expect(joined.log).toContain(`join:${account.id}:${account.name}`);
    expect((await join(`/named/${freshRoom()}?token=${token}`)).status).toBe(401);
    // tokenAuth passes the name on as well.
    const viaTokenAuth = await join(`/tokens/${room}-t?token=${await createJoinToken(TEST_SECRET, { player: "ada", name: "Ada L." })}`);
    expect(viaTokenAuth.log).toContain("join:ada:Ada L.");
  });

  it("cannot pick their own name by sending the gateway's header", async () => {
    const guest = (await (await call("POST", "/guest")).json()) as { id: string; token: string };
    const response = await exports.default.fetch(`${BASE}/named/${freshRoom()}/whoami?token=${guest.token}`, {
      headers: { "x-tickflare-name": "Admin", "x-tickflare-player": "someone-else" },
    });
    expect(await response.json()).toEqual({ id: guest.id, name: null });
  });
});

describe("player data", () => {
  it("lets players write the keys the game allows, and keeps the rest for the server", async () => {
    const account = await register();
    const session = { session: account.session };

    expect((await call("PUT", "/data/avatar", { ...session, body: { value: { hat: "red" } } })).status).toBe(200);
    expect(await (await call("GET", "/data/avatar", session)).json()).toEqual({ key: "avatar", value: { hat: "red" } });
    expect((await call("PUT", "/data/settings", { ...session, body: { value: { volume: 3 } } })).status).toBe(200);

    const rating = await call("PUT", "/data/rating", { ...session, body: { value: 9000 } });
    expect(rating.status).toBe(403);
    expect((await call("PUT", "/data/anything", { ...session, body: { value: 1 } })).status).toBe(403);
    expect((await call("GET", "/data/missing", session)).status).toBe(404);
    expect((await call("GET", "/data/bad%20key", session)).status).toBe(400);
    expect((await call("GET", "/data/avatar")).status).toBe(401);

    expect((await call("DELETE", "/data/settings", session)).status).toBe(204);
    expect((await call("GET", "/data/settings", session)).status).toBe(404);
  });

  it("shows only public keys and stats on a profile", async () => {
    const accounts = testAccounts(env);
    const account = await register();
    await accounts.setData(account.id, "avatar", "fox");
    await accounts.setData(account.id, "settings", { secret: true });
    await accounts.setData(account.id, "rating", 1200);
    await accounts.addStats(account.id, { wins: 2 });

    const profile = await (await call("GET", `/players/${account.id}`)).json();
    expect(profile).toMatchObject({ id: account.id, name: account.name, data: { avatar: "fox", rating: 1200 }, stats: { wins: 2 } });
    expect(profile).not.toHaveProperty("email");
    expect(JSON.stringify(profile)).not.toContain("secret");
    expect((await call("GET", "/players/nobody")).status).toBe(404);
  });

  it("limits how much a player can store", async () => {
    const accounts = testAccounts(env);
    const account = await register();
    const big = await call("PUT", "/data/avatar", { session: account.session, body: { value: "x".repeat(2000) } });
    expect(big.status).toBe(413);

    for (const key of ["a", "b", "c", "d"]) await accounts.setData(account.id, key, 1);
    await expect(accounts.setData(account.id, "e", 1)).rejects.toMatchObject({ code: "too_many_keys" });
    // Changing a key that exists is always fine.
    await accounts.setData(account.id, "d", 2);
    expect(await accounts.getData(account.id, "d")).toBe(2);
  });
});

describe("stats and leaderboards", () => {
  it("add up, keep the best, rank players, and leave out guests", async () => {
    const accounts = testAccounts(env);
    const stat = `score_${Date.now()}`;
    const [a, b, c] = [await register(), await register(), await register()];

    await accounts.addStats(a.id, { [stat]: 10 });
    await accounts.addStats(a.id, { [stat]: 5 });
    await accounts.maxStats(b.id, { [stat]: 30 });
    await accounts.maxStats(b.id, { [stat]: 20 });
    await accounts.setStats(c.id, { [stat]: 15 });
    await accounts.addStats("guest-without-account", { [stat]: 999 });

    expect(await accounts.stats(a.id)).toEqual({ [stat]: 15 });
    const several = await accounts.statsOf([a.id, b.id, "nobody", a.id], [stat]);
    expect(Object.fromEntries(several)).toEqual({ [a.id]: { [stat]: 15 }, [b.id]: { [stat]: 30 } });
    const board = await (await call("GET", `/leaderboards/${stat}`)).json();
    expect(board).toEqual({
      stat,
      total: 3,
      entries: [
        { rank: 1, id: b.id, name: b.name, value: 30 },
        { rank: 2, id: a.id, name: a.name, value: 15 },
        { rank: 2, id: c.id, name: c.name, value: 15 },
      ],
    });
    const page = (await (await call("GET", `/leaderboards/${stat}?limit=1&offset=1`)).json()) as { entries: unknown[] };
    expect(page.entries).toHaveLength(1);
    expect(await accounts.rank(stat, b.id)).toEqual({ rank: 1, value: 30 });
    expect(await accounts.rank(stat, freshName())).toBeNull();
    await expect(accounts.addStats(a.id, { [stat]: Number.NaN })).rejects.toMatchObject({ code: "invalid_value" });

    // Awards count once per key, however often they are retried.
    const award = [{ player: a.id, add: { [stat]: 5 }, set: { [`${stat}_last`]: 1 } }, { player: c.id, max: { [stat]: 100 } }];
    expect(await accounts.awardStats(`match-${stat}`, award)).toBe(true);
    expect(await accounts.awardStats(`match-${stat}`, award)).toBe(false);
    expect(await accounts.stats(a.id)).toEqual({ [stat]: 20, [`${stat}_last`]: 1 });
    expect((await accounts.stats(c.id))[stat]).toBe(100);
  });
});

describe("a player's own records", () => {
  it("can be exported, and do not include the password", async () => {
    const accounts = testAccounts(env);
    const account = await register();
    await accounts.setData(account.id, "settings", { volume: 7 });
    await accounts.addStats(account.id, { wins: 1 });
    await env.DB.batch(MATCHES_SCHEMA.split(";").map((sql) => sql.trim()).filter(Boolean).map((sql) => env.DB.prepare(sql)));
    await env.DB.prepare("INSERT INTO tickflare_matches (id, room, ended_at, players, result) VALUES (?, ?, ?, ?, ?)")
      .bind(`m-${account.id}`, "r1", Date.now(), JSON.stringify([account.id, "someone"]), JSON.stringify({ winner: account.id }))
      .run();

    const response = await call("GET", "/export", { session: account.session });
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    const text = await response.text();
    expect(text).not.toContain("pbkdf2");
    expect(JSON.parse(text)).toMatchObject({
      account: { id: account.id, name: account.name },
      data: { settings: { volume: 7 } },
      stats: { wins: 1 },
      matches: [{ id: `m-${account.id}`, result: { winner: account.id } }],
    });
  });

  it("can be deleted with the password, freeing the name", async () => {
    const accounts = testAccounts(env);
    const account = await register();
    await accounts.setData(account.id, "settings", 1);
    await accounts.addStats(account.id, { wins: 1 });

    expect((await call("DELETE", "/me", { session: account.session, body: { password: "wrong one" } })).status).toBe(403);
    expect((await call("DELETE", "/me", { session: account.session, body: { password: PASSWORD } })).status).toBe(204);

    expect((await call("GET", "/me", { session: account.session })).status).toBe(401);
    expect(await accounts.profile(account.id)).toBeNull();
    expect(await accounts.stats(account.id)).toEqual({});
    expect(await accounts.getData(account.id, "settings")).toBeUndefined();
    await register(account.name);
  });
});

describe("other sites", () => {
  it("cannot sign in or change anything, unless allowed, and allowed ones get CORS headers", async () => {
    const { name, session } = await register();
    const evil = await call("POST", "/login", { body: { name, password: PASSWORD }, headers: { Origin: "https://evil.test" } });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const put = await call("PUT", "/data/avatar", { session, body: { value: 1 }, headers: { Origin: "https://evil.test" } });
    expect(put.status).toBe(403);

    const allowed = await call("POST", "/login", { body: { name, password: PASSWORD }, headers: { Origin: "https://allowed.test" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://allowed.test");
    expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    // Cross-site cookies need SameSite=None.
    expect(allowed.headers.get("Set-Cookie")).toContain("SameSite=None");

    const preflight = await call("OPTIONS", "/login", { headers: { Origin: "https://allowed.test" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");
  });
});

describe("accounts from another service", () => {
  it("sign in with their old password, which is then hashed again", async () => {
    const accounts = testAccounts(env);
    const id = `imported-${Date.now()}`;
    const name = freshName();
    await accounts.importAccount({ id, name, passwordHash: "plain:old password 1", createdAt: 1_600_000_000_000 });

    expect((await call("POST", "/login", { body: { name, password: "wrong password" } })).status).toBe(401);
    const login = await call("POST", "/login", { body: { name, password: "old password 1" } });
    expect(login.status).toBe(200);
    expect(await login.json()).toMatchObject({ account: { id, name, createdAt: 1_600_000_000_000 } });

    const row = await env.DB.prepare("SELECT password_hash FROM tickflare_accounts WHERE id = ?").bind(id).first<{ password_hash: string }>();
    expect(row?.password_hash).toMatch(/^pbkdf2\$sha256\$100000\$/);
    expect((await call("POST", "/login", { body: { name, password: "old password 1" } })).status).toBe(200);
  });
});

describe("password hashes", () => {
  it("check out for the right password only, and are salted", async () => {
    const hash = await hashPassword("hunter2hunter2", 1000);
    expect(await verifyPassword(hash, "hunter2hunter2")).toBe(true);
    expect(await verifyPassword(hash, "hunter2hunter3")).toBe(false);
    expect(await hashPassword("hunter2hunter2", 1000)).not.toBe(hash);
    expect(await verifyPassword("bcrypt$whatever", "hunter2hunter2")).toBe(false);
  });
});

describe("AccountClient", () => {
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => exports.default.fetch(input, init)) as typeof fetch;

  it("signs up a guest without losing their id, joins rooms, and keeps data", async () => {
    const stored = new Map<string, string>();
    const storage = {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => void stored.set(key, value),
      removeItem: (key: string) => void stored.delete(key),
    };
    const sessions: (string | null)[] = [];
    const client = new AccountClient({ baseUrl: BASE, fetch: fetcher, storage, onSession: (token) => sessions.push(token) });

    expect(await client.restore()).toBeNull();
    const guest = await client.guest();
    expect(client.playerId).toBe(guest.id);
    expect(await client.guest()).toEqual(guest);
    expect(stored.size).toBe(1);

    const room = freshRoom();
    expect((await join(`/named/${room}?token=${await client.tokenSource(room)}`)).you).toBe(guest.id);

    const name = freshName();
    const account = await client.register({ name, password: PASSWORD });
    expect(account.id).toBe(guest.id);
    expect(client.signedIn).toBe(true);
    expect(stored.size).toBe(0);
    expect(sessions).toHaveLength(1);

    const joined = await join(`/named/${room}?token=${await client.tokenSource(room)}`);
    expect(joined.log).toContain(`back:${guest.id}:${name}`);

    await client.setData("avatar", "owl");
    expect(await client.getData("avatar")).toBe("owl");
    expect(await client.getData("nothing")).toBeUndefined();
    await expect(client.setData("rating", 1)).rejects.toBeInstanceOf(AccountRequestError);
    expect((await client.profile(guest.id))?.data).toEqual({ avatar: "owl" });

    // A new client with the stored session is still signed in.
    const later = new AccountClient({ baseUrl: BASE, fetch: fetcher, storage, session: sessions[0] });
    expect((await later.restore())?.name).toBe(name);

    await client.logout();
    expect(sessions.at(-1)).toBeNull();
    expect(await later.restore()).toBeNull();
  });

  it("reports refusals with their code", async () => {
    const client = new AccountClient({ baseUrl: BASE, fetch: fetcher, storage: null });
    const error = await client.login(freshName(), "whatever whatever").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccountRequestError);
    expect(error).toMatchObject({ status: 401, code: "invalid_credentials" });
  });
});

describe("sessions", () => {
  it("are extended when used, at most once a day", async () => {
    const account = await register();
    const before = await env.DB.prepare("SELECT expires_at FROM tickflare_sessions WHERE account_id = ?")
      .bind(account.id)
      .first<{ expires_at: number }>();
    await env.DB.prepare("UPDATE tickflare_sessions SET expires_at = expires_at - ? WHERE account_id = ?")
      .bind(2 * 24 * 60 * 60 * 1000, account.id)
      .run();
    await sleep(5);
    expect((await call("GET", "/me", { session: account.session })).status).toBe(200);
    const after = await env.DB.prepare("SELECT expires_at FROM tickflare_sessions WHERE account_id = ?")
      .bind(account.id)
      .first<{ expires_at: number }>();
    expect(after!.expires_at).toBeGreaterThan(before!.expires_at);

    await env.DB.prepare("UPDATE tickflare_sessions SET expires_at = ? WHERE account_id = ?").bind(Date.now() - 1, account.id).run();
    expect((await call("GET", "/me", { session: account.session })).status).toBe(401);
  });
});
