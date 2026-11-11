import { applyPatch, diff } from "../patch.js";

export interface SeatedSocket {
  ws: WebSocket;
  /** The player the socket belongs to. */
  id: string;
}

/**
 * Sends each socket what changed in its view since the last tick.
 *
 * It remembers, per socket, a copy of what that socket holds. A socket it
 * knows nothing about gets its whole view; the others get a patch, or
 * nothing if their view did not change.
 */
export class DeltaSender {
  /** What each socket was last sent. Snapshots are never mutated, so sockets may share one. */
  #baselines = new Map<WebSocket, unknown>();
  /** The `seq` of the last send. */
  #sentSeq = -1;

  /** Record exactly what a socket has just been sent in full, as a copy the simulation cannot touch. */
  remember(ws: WebSocket, snapshot: unknown): void {
    this.#baselines.set(ws, snapshot);
  }

  /** Forget what the sockets hold: the next send gives each its whole view. */
  reset(): void {
    this.#baselines.clear();
  }

  /**
   * @param state  the room's state, which is what everyone sees when `viewOf` is undefined
   * @param viewOf what one player sees, when the room has a custom view
   */
  send(
    sockets: SeatedSocket[],
    seq: number,
    tick: number,
    state: unknown,
    viewOf: ((playerId: string) => unknown) | undefined,
  ): void {
    if (!viewOf && seq === this.#sentSeq && sockets.every(({ ws }) => this.#baselines.has(ws))) {
      return;
    }

    const baselines = new Map<WebSocket, unknown>();
    // Without a custom view, sockets that were last sent the same snapshot share one diff,
    // and everyone ends the tick on the same snapshot.
    const shared = new Map<unknown, { frame?: string; next: unknown }>();
    let common: { next: unknown } | undefined;

    for (const { ws, id } of sockets) {
      try {
        const base = this.#baselines.get(ws);
        let update = viewOf || base === undefined ? undefined : shared.get(base);
        if (!update) {
          update = frameFor(base, viewOf ? viewOf(id) : state, seq, tick);
          if (!viewOf) {
            if (common) update.next = common.next;
            else common = update;
            if (base !== undefined) shared.set(base, update);
          }
        }
        if (update.frame) ws.send(update.frame);
        baselines.set(ws, update.next);
      } catch (err) {
        // A view() that threw must not starve the other players.
        console.error(`[tickflare] could not send the tick to ${id}:`, err);
      }
    }
    this.#baselines = baselines;
    this.#sentSeq = seq;
  }
}

/** The frame that brings a socket from `base` to `live`, and the snapshot it will then hold. */
function frameFor(base: unknown, live: unknown, seq: number, tick: number): { frame?: string; next: unknown } {
  const head = `"seq":${seq},"tick":${tick}`;
  if (base !== undefined) {
    const patch = diff(base, live);
    if (patch === undefined) return { next: base };
    if (patch !== null) {
      const json = JSON.stringify(patch);
      return { frame: `{"t":"patch",${head},"p":${json}}`, next: applyPatch(base, JSON.parse(json)) };
    }
  }
  const json = JSON.stringify(live) ?? "null";
  return { frame: `{"t":"state",${head},"state":${json}}`, next: JSON.parse(json) };
}
