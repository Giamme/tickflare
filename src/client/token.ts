/**
 * Where a client gets its join token from. Called before every connection
 * attempt with the id of the room being connected to, so a long session
 * outlives any one token and a token scoped to a room can follow a handover.
 */
export type TokenSource = (room: string) => string | Promise<string>;

/** The room a room URL points at: the last segment of its path. */
export function roomIn(url: string): string {
  return new URL(url).pathname.replace(/\/+$/, "").split("/").pop() ?? "";
}

/** `url` with a token just asked for as its `token` query parameter, replacing any it had. */
export async function withFreshToken(url: string, room: string, token: TokenSource): Promise<string> {
  const value = await token(room);
  if (typeof value !== "string" || value === "") {
    throw new TypeError("token() must return a non-empty string");
  }
  const next = new URL(url);
  next.searchParams.set("token", value);
  return next.toString();
}
