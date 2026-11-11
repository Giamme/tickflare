/** A frame from a client, after its shape has been checked. */
export type ClientFrame = { t: "cmd"; id: number; data: unknown } | { t: "leave"; id: number };

/** Close reasons are limited to 123 bytes by the WebSocket protocol. */
export const MAX_CLOSE_REASON = 120;

/** Checks the shape of a parsed client frame. `data` is passed on untouched: the room's `parseCommand` checks it. */
export function readFrame(value: unknown): ClientFrame | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const frame = value as { t?: unknown; id?: unknown; data?: unknown };
  if (!Number.isSafeInteger(frame.id)) return undefined;
  const id = frame.id as number;
  if (frame.t === "cmd") return { t: "cmd", id, data: frame.data };
  if (frame.t === "leave") return { t: "leave", id };
  return undefined;
}

/** Completes the upgrade, then closes straight away so the client learns why it was turned away. */
export function refuse(client: WebSocket, server: WebSocket, code: number, reason: string): Response {
  server.accept();
  server.close(code, reason.slice(0, MAX_CLOSE_REASON));
  return new Response(null, { status: 101, webSocket: client });
}
