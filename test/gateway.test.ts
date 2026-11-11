import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
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

  it("refuses player ids that cannot travel in a header", async () => {
    expect((await upgrade("/rooms/abc?player=two%20words")).status).toBe(400);
    expect((await upgrade(`/rooms/abc?player=${"x".repeat(129)}`)).status).toBe(400);
  });

  it("ignores an identity header sent by the client", async () => {
    const p1 = await connect(freshRoom(), "p1", { "x-tickflare-player": "admin" });
    expect((await p1.next("welcome")).you).toBe("p1");
  });
});
