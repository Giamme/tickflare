/**
 * The Worker the engine clients are tested against: two rooms from Tickflare's
 * own tests, one that changes its state in every way a patch can describe and
 * one that ticks. Players say who they are with `?player=`.
 *
 *   npx wrangler dev --config clients/test-server/wrangler.jsonc --port 8787
 */
import { routeToRoom } from "../../src/server/index.js";

export { ShapesRoom, TickRoom } from "../../test/worker.js";

interface Env {
  SHAPES: DurableObjectNamespace;
  TICKS: DurableObjectNamespace;
}

function whoIs(request: Request): string | Response {
  return new URL(request.url).searchParams.get("player") ?? new Response("Who are you?", { status: 401 });
}

export default {
  async fetch(request, env): Promise<Response> {
    return (
      (await routeToRoom(request, { rooms: env.SHAPES, prefix: "/shapes", authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.TICKS, prefix: "/ticks", authenticate: whoIs })) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
