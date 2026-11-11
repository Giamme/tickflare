// In your own project: import { createJoinToken } from "tickflare";
import { createJoinToken } from "../../../src/server/index.js";

const DAY = 24 * 60 * 60;

/**
 * `POST /api/guest`: makes up a player and signs a join token for them.
 *
 * This is where a real game plugs in its accounts: check the session or the
 * login, then sign a token for that user's id. The examples have no login, so
 * everyone gets a fresh guest. What matters is that the id comes from the
 * server: a player cannot pick someone else's.
 *
 * Returns `null` for any other URL so the Worker can try its other routes.
 */
export async function guestRoute(request: Request, secret: string): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/api/guest") return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const player = crypto.randomUUID();
  const token = await createJoinToken(secret, { player, expiresIn: DAY });
  return Response.json({ player, token, expiresAt: Date.now() + DAY * 1000 });
}
