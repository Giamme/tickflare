import { Accounts, routeToRoom } from "tickflare";
export { Skirmish } from "./skirmish";

interface Env {
  ROOMS: DurableObjectNamespace;
  DB: D1Database;
  JOIN_SECRET: string;
}

export default {
  async fetch(request, env): Promise<Response> {
    const accounts = new Accounts(env.DB, { secret: env.JOIN_SECRET });
    return (
      // Guest identities, sign-up and sign-in, under /api/accounts.
      (await accounts.route(request)) ??
      // WebSockets on /rooms/<room id>, let in only with a valid identity.
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate: accounts.authenticate })) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
