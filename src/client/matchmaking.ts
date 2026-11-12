import { PING, type MatchFound } from "../protocol.js";
import { roomIn, withFreshToken, type TokenSource } from "./token.js";

/** How long to wait and how to authenticate. Both are optional. */
export interface FindMatchOptions {
  /** Abort to stop waiting. The promise then rejects with the signal's reason. */
  signal?: AbortSignal;
  /**
   * Supplies the join token, as `RoomClientOptions.token` does for rooms. It
   * is called with the queue's name, and what it returns is sent as the
   * `token` query parameter.
   */
  token?: TokenSource;
}

/**
 * Wait in a matchmaking queue. Resolves with the room to connect to and the
 * players in it once the matchmaker has put a match together.
 *
 *     const { room } = await findMatch("wss://my-game.example/matchmaking/ranked");
 *     const client = new RoomClient(`wss://my-game.example/rooms/${room}`);
 */
export async function findMatch(url: string | URL, options: FindMatchOptions = {}): Promise<MatchFound> {
  const { signal, token } = options;
  signal?.throwIfAborted();
  let target = String(url);
  if (token) target = await withFreshToken(target, roomIn(target), token);
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target);
    let found: MatchFound | undefined;
    let settled = false;
    const ping = setInterval(() => {
      if (socket.readyState === 1) socket.send(PING);
    }, 25_000);
    const abort = () => socket.close(1000, "cancelled");
    signal?.addEventListener("abort", abort);

    const finish = (code: number, reason: string) => {
      if (settled) return;
      settled = true;
      clearInterval(ping);
      signal?.removeEventListener("abort", abort);
      if (found) resolve(found);
      else if (signal?.aborted) reject(signal.reason);
      else reject(new Error(`Matchmaking ended without a match (${code} ${reason})`));
    };

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || !event.data.startsWith("{")) return;
      const message = JSON.parse(event.data) as MatchFound;
      if (message.t === "match") found = message;
    });
    socket.addEventListener("close", (event) => finish(event.code, event.reason));
    // A socket turned away before it opened may never report a close (Node's does not).
    socket.addEventListener("error", () => {
      if (socket.readyState === 0) finish(1006, "");
    });
  });
}
