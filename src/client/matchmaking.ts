import { PING, type MatchFound } from "../protocol.js";

export interface FindMatchOptions {
  /** Abort to stop waiting. The promise then rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * Wait in a matchmaking queue. Resolves with the room to connect to and the
 * players in it once the matchmaker has put a match together.
 *
 *     const { room } = await findMatch("wss://my-game.example/matchmaking/ranked");
 *     const client = new RoomClient(`wss://my-game.example/rooms/${room}`);
 */
export function findMatch(url: string | URL, options: FindMatchOptions = {}): Promise<MatchFound> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) return reject(signal.reason);

    const socket = new WebSocket(String(url));
    let found: MatchFound | undefined;
    const ping = setInterval(() => {
      if (socket.readyState === 1) socket.send(PING);
    }, 25_000);
    const abort = () => socket.close(1000, "cancelled");
    signal?.addEventListener("abort", abort);

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || !event.data.startsWith("{")) return;
      const message = JSON.parse(event.data) as MatchFound;
      if (message.t === "match") found = message;
    });
    socket.addEventListener("close", (event) => {
      clearInterval(ping);
      signal?.removeEventListener("abort", abort);
      if (found) resolve(found);
      else if (signal?.aborted) reject(signal.reason);
      else reject(new Error(`Matchmaking ended without a match (${event.code} ${event.reason})`));
    });
  });
}
