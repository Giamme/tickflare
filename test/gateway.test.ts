import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { routeToRoom } from "../src/server/gateway.js";
import { connect, freshRoom, upgrade } from "./helpers.js";

describe("routeToRoom", () => {
  it("returns null for URLs outside the prefix, so the Worker can route them", async () => {
    expect((await upgrade("/somewhere-else")).status).toBe(404);
    expect((await upgrade("/rooms")).status).toBe(404);
  });

  it("refuses room ids that are not plain slugs", async () => {
    expect((await upgrade("/rooms/a/b?player=p1")).status).toBe(400);
    expect((await upgrade("/rooms/has%20space?player=p1")).status).toBe(400);
    expect((await upgrade(`/rooms/${"x".repeat(65)}?player=p1`)).status).toBe(400);
  });

  it("refuses plain HTTP requests", async () => {
    const response = await exports.default.fetch("https://tickflare.test/rooms/abc?player=p1");
    expect(response.status).toBe(426);
  });

  it("passes on the Response when authenticate refuses", async () => {
    const response = await upgrade("/rooms/abc");
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Who are you?");
  });

  it("refuses the caller when authenticate returns nothing at all", async () => {
    const request = new Request(`https://tickflare.test/rooms/${freshRoom()}`, { headers: { Upgrade: "websocket" } });
    for (const nothing of [undefined, null, 7]) {
      const response = await routeToRoom(request, {
        rooms: env.ROOMS,
        authenticate: () => nothing as unknown as string,
      });
      expect(response!.status).toBe(401);
    }
  });

  it("refuses a player id that would damage a game's state as a key", async () => {
    expect((await upgrade(`/rooms/${freshRoom()}?player=__proto__`)).status).toBe(400);
  });

  it("refuses player ids that cannot travel in a header", async () => {
    expect((await upgrade("/rooms/abc?player=two%20words")).status).toBe(400);
    expect((await upgrade(`/rooms/abc?player=${"x".repeat(129)}`)).status).toBe(400);
  });

  it("forwards authenticated HTTP requests below a room to its onHttp hook", async () => {
    const get = (path: string) => exports.default.fetch(`https://tickflare.test${path}`);
    // The fixture room does not override onHttp, so it answers 404 itself.
    expect((await get("/rooms/abc/anything?player=p1")).status).toBe(404);
    expect((await get("/rooms/abc/anything")).status).toBe(401);
    // A WebSocket upgrade is only accepted on the room URL itself.
    expect((await upgrade("/rooms/abc/anything?player=p1")).status).toBe(400);
  });

  it("ignores an identity header sent by the client", async () => {
    const p1 = await connect(freshRoom(), "p1", { "x-tickflare-player": "admin" });
    expect((await p1.next("welcome")).you).toBe("p1");
  });
});
