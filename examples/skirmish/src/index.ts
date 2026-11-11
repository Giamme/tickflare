// In your own project: import { routeToRoom, tokenAuth } from "tickflare";
import { routeToRoom, tokenAuth } from "../../../src/server/index.js";
import { guestRoute } from "../../shared/src/guest.js";
import { Skirmish } from "./game.js";

export { Skirmish };

interface Env {
  ROOMS: DurableObjectNamespace<Skirmish>;
  /** Signs join tokens. A secret in production: `wrangler secret put JOIN_SECRET`. */
  JOIN_SECRET: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const response =
      // Hands out a guest identity as a signed token...
      (await guestRoute(request, env.JOIN_SECRET)) ??
      // ...which is the only thing a room accepts as proof of who is connecting.
      (await routeToRoom(request, {
        rooms: env.ROOMS,
        authenticate: tokenAuth({ secret: env.JOIN_SECRET }),
      }));
    // Everything else: static assets are served before the Worker runs, so
    // reaching this line means the path does not exist.
    return response ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
