// In your own project: import { recentMatches, recordMatches, routeToMatchmaker, ... } from "tickflare";
import {
  recentMatches,
  recordMatches,
  routeToMatchmaker,
  routeToRoom,
  tokenAuth,
  type MatchResult,
} from "../../../src/server/index.js";
import { guestRoute } from "../../shared/src/guest.js";
import { Lobby, RankedTicTacToe, type Env } from "./game.js";

export { Lobby, RankedTicTacToe };

export default {
  async fetch(request, env): Promise<Response> {
    const authenticate = tokenAuth({ secret: env.JOIN_SECRET });
    const response =
      (await guestRoute(request, env.JOIN_SECRET)) ??
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate })) ??
      (await routeToMatchmaker(request, { matchmakers: env.LOBBY, authenticate }));
    if (response) return response;

    if (new URL(request.url).pathname === "/api/matches") {
      return Response.json(await recentMatches(env.DB, 10));
    }
    return new Response("Not found", { status: 404 });
  },

  // Finished matches arrive here from the rooms' queue and are stored in D1.
  async queue(batch, env): Promise<void> {
    await recordMatches(batch, env.DB);
  },
} satisfies ExportedHandler<Env, MatchResult>;
