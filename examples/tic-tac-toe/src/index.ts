// In your own project: import { routeToRoom } from "tickflare";
import { routeToRoom } from "../../../src/server/index.js";
import { TicTacToe } from "./game.js";

export { TicTacToe };

interface Env {
  ROOMS: DurableObjectNamespace<TicTacToe>;
}

export default {
  async fetch(request, env): Promise<Response> {
    const response = await routeToRoom(request, {
      rooms: env.ROOMS,
      authenticate: insecureDevIdentity,
    });
    // Everything that is not a room URL: static assets are served before the
    // Worker runs, so reaching this line means the path does not exist.
    return response ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * DEVELOPMENT ONLY. Believes whatever `?player=` the client sends, so anyone
 * can play as anyone. Replace it with a real check (session cookie, signed
 * token) before putting a game in front of players.
 */
function insecureDevIdentity(request: Request): string | Response {
  const player = new URL(request.url).searchParams.get("player");
  return player ?? new Response("Missing ?player=", { status: 401 });
}
