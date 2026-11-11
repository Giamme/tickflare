import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createJoinToken, tokenAuth, verifyJoinToken } from "../src/server/tokens.js";
import { freshRoom, upgrade } from "./helpers.js";
import { TEST_SECRET } from "./worker.js";

const SECRET = "a-secret-of-sufficient-length";

describe("join tokens", () => {
  it("say who the player is and when they expire", async () => {
    const token = await createJoinToken(SECRET, { player: "ada" });
    const verified = await verifyJoinToken(SECRET, token);

    expect(verified?.player).toBe("ada");
    expect(verified?.expiresAt).toBeGreaterThan(Date.now() / 1000 + 3500);
    expect(verified?.expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + 3600);
  });

  it("are refused when altered, signed with another secret, or malformed", async () => {
    const token = await createJoinToken(SECRET, { player: "ada" });
    const [version, , signature] = token.split(".");
    const forged = btoa(JSON.stringify({ p: "grace", e: 9_999_999_999 })).replace(/=+$/, "");

    expect(await verifyJoinToken(SECRET, `${version}.${forged}.${signature}`)).toBeNull();
    expect(await verifyJoinToken("another-secret-of-enough-length", token)).toBeNull();
    expect(await verifyJoinToken(SECRET, token.replace("v1.", "v2."))).toBeNull();
    expect(await verifyJoinToken(SECRET, `${token}x`)).toBeNull();
    expect(await verifyJoinToken(SECRET, "not a token")).toBeNull();
    expect(await verifyJoinToken(SECRET, "")).toBeNull();
  });

  it("are refused once expired", async () => {
    const token = await createJoinToken(SECRET, { player: "ada", expiresIn: -1 });
    expect(await verifyJoinToken(SECRET, token)).toBeNull();
  });

  it("can be limited to one room or queue", async () => {
    const scoped = await createJoinToken(SECRET, { player: "ada", scope: "room-a" });
    const open = await createJoinToken(SECRET, { player: "ada" });

    expect(await verifyJoinToken(SECRET, scoped, "room-a")).toMatchObject({ player: "ada", scope: "room-a" });
    expect(await verifyJoinToken(SECRET, scoped, "room-b")).toBeNull();
    expect(await verifyJoinToken(SECRET, scoped)).toBeNull();
    expect(await verifyJoinToken(SECRET, open, "room-b")).toMatchObject({ player: "ada" });
  });

  it("refuse to work with a missing or short secret", async () => {
    await expect(createJoinToken("short", { player: "ada" })).rejects.toThrow(TypeError);
    await expect(createJoinToken(undefined as unknown as string, { player: "ada" })).rejects.toThrow(TypeError);
    await expect(verifyJoinToken("", "v1.x.y")).rejects.toThrow(TypeError);
  });
});

describe("tokenAuth", () => {
  it("lets a player with a valid token into a room, as the player the token names", async () => {
    const room = freshRoom();
    const token = await createJoinToken(TEST_SECRET, { player: "ada" });
    // A player id sent alongside the token is ignored.
    const response = await upgrade(`/secure/${room}?token=${token}&player=grace`);
    expect(response.status).toBe(101);

    const ws = response.webSocket!;
    const welcome = new Promise<{ you: string }>((resolve) => {
      ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)), { once: true });
    });
    ws.accept();
    expect((await welcome).you).toBe("ada");
    ws.close(1000, "test_done");
  });

  it("turns away missing, invalid and wrongly scoped tokens", async () => {
    const room = freshRoom();
    const elsewhere = await createJoinToken(TEST_SECRET, { player: "ada", scope: "another-room" });
    const forged = await createJoinToken("someone-elses-secret-0123", { player: "ada" });

    expect((await upgrade(`/secure/${room}`)).status).toBe(401);
    expect((await upgrade(`/secure/${room}?player=ada`)).status).toBe(401);
    expect((await upgrade(`/secure/${room}?token=${forged}`)).status).toBe(401);
    expect((await upgrade(`/secure/${room}?token=${elsewhere}`)).status).toBe(401);
    const here = await createJoinToken(TEST_SECRET, { player: "ada", scope: room });
    expect((await upgrade(`/secure/${room}?token=${here}`)).status).toBe(101);
  });

  it("accepts a bearer token on plain HTTP requests", async () => {
    const token = await createJoinToken(TEST_SECRET, { player: "ada" });
    const get = (headers?: Record<string, string>) =>
      exports.default.fetch("https://tickflare.test/secure/abc/anything", { headers });

    expect((await get()).status).toBe(401);
    // Authenticated, so it reaches the room, whose default onHttp answers 404.
    expect((await get({ Authorization: `Bearer ${token}` })).status).toBe(404);
  });

  it("reads the token from the parameter it was told to", async () => {
    const authenticate = tokenAuth({ secret: SECRET, param: "ticket" });
    const token = await createJoinToken(SECRET, { player: "ada" });

    expect(await authenticate(new Request(`https://x.test/rooms/a?ticket=${token}`), "a")).toBe("ada");
    const refused = await authenticate(new Request(`https://x.test/rooms/a?token=${token}`), "a");
    expect(refused).toBeInstanceOf(Response);
  });
});
