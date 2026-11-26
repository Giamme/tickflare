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

  it("has its connections compressed when the client offers it", async () => {
    // Cloudflare's runtime does this, not Tickflare, and browsers offer it with every WebSocket.
    // The bandwidth figures in the guide count on it: if a runtime stops, this says so.
    const offered = await upgrade(`/rooms/${freshRoom()}?player=p1`, { "Sec-WebSocket-Extensions": "permessage-deflate; client_max_window_bits" });
    expect(offered.status).toBe(101);
    expect(offered.headers.get("Sec-WebSocket-Extensions")).toMatch(/^permessage-deflate/);
    offered.webSocket!.accept();
    offered.webSocket!.close(1000, "done");

    const plain = await upgrade(`/rooms/${freshRoom()}?player=p1`);
    expect(plain.headers.get("Sec-WebSocket-Extensions")).toBeNull();
    plain.webSocket!.accept();
    plain.webSocket!.close(1000, "done");
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

  it("takes an id with a name, and refuses names that are not text or too long", async () => {
    const route = (identity: unknown) =>
      routeToRoom(new Request(`https://tickflare.test/named/${freshRoom()}`, { headers: { Upgrade: "websocket" } }), {
        rooms: env.NAMES,
        prefix: "/named",
        authenticate: () => identity as string,
      });
    expect((await route({ id: "ada", name: "Ada Lovelace ✨" }))!.status).toBe(101);
    expect((await route({ id: "ada" }))!.status).toBe(101);
    expect((await route({ name: "no id" }))!.status).toBe(401);
    expect((await route({ id: "ada", name: 7 }))!.status).toBe(400);
    expect((await route({ id: "ada", name: "x".repeat(65) }))!.status).toBe(400);
    expect((await route({ id: "ada", name: "line\nbreak" }))!.status).toBe(400);
    expect((await route({ id: "__proto__", name: "x" }))!.status).toBe(400);
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

  it("names someone who asks to watch under a header of their own, and nobody else", async () => {
    // What the gateway hands the room, for a namespace that keeps it.
    const forwarded = async (url: string, headers: Record<string, string> = {}) => {
      let seen: Request | undefined;
      const rooms = {
        idFromName: (name: string) => name as unknown as DurableObjectId,
        get: () => ({
          fetch: async (request: Request) => {
            seen = request;
            return new Response("ok");
          },
        }),
      };
      await routeToRoom(new Request(url, { headers: { Upgrade: "websocket", ...headers } }), {
        rooms,
        authenticate: (request) => new URL(request.url).searchParams.get("player")!,
      });
      return seen!.headers;
    };

    // A room that runs code from before there were spectators reads the player's header, and
    // seats whoever it names. It must not find one on a request to watch.
    const watching = await forwarded("https://tickflare.test/rooms/abc?player=s1&spectate=1", {
      "x-tickflare-spectator": "admin",
      "x-tickflare-player": "admin",
    });
    expect(watching.get("x-tickflare-spectator")).toBe("s1");
    expect(watching.get("x-tickflare-player")).toBeNull();

    const playing = await forwarded("https://tickflare.test/rooms/abc?player=p1", { "x-tickflare-spectator": "admin" });
    expect(playing.get("x-tickflare-player")).toBe("p1");
    expect(playing.get("x-tickflare-spectator")).toBeNull();
  });
});
