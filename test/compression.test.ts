import { describe, expect, it } from "vitest";
import { freshRoom, upgrade } from "./helpers.js";

/** What the room answered an upgrade with, as to compression. The socket is closed again. */
async function answered(prefix: string, offer?: string): Promise<string | null> {
  const response = await upgrade(`${prefix}/${freshRoom()}?player=p1`, offer === undefined ? {} : { "Sec-WebSocket-Extensions": offer });
  expect(response.status).toBe(101);
  const ws = response.webSocket!;
  ws.accept();
  ws.close(1000, "test_done");
  return response.headers.get("Sec-WebSocket-Extensions");
}

describe("compression", () => {
  it("names a 4 KB window to a client that offers compression, in a room set to fast", async () => {
    expect(await answered("/zones", "permessage-deflate; client_max_window_bits")).toBe("permessage-deflate; server_max_window_bits=12");
    expect(await answered("/zones", "x-webkit-deflate-frame, permessage-deflate")).toBe("permessage-deflate; server_max_window_bits=12");
  });

  it("leaves the answer to the runtime otherwise", async () => {
    // A client that offers nothing, or a window or reset of its own, and a room left at the default.
    expect(await answered("/zones")).toBeNull();
    expect(await answered("/zones", "permessage-deflate; server_max_window_bits=10") ?? "").not.toContain("=12");
    expect(await answered("/zones", "permessage-deflate; server_no_context_takeover") ?? "").not.toContain("=12");
    expect(await answered("/ticks", "permessage-deflate; client_max_window_bits") ?? "").not.toContain("server_max_window_bits");
  });
});
