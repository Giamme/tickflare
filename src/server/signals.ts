/** A message from one room to another. */
export interface Signal {
  to: string;
  data: unknown;
  /** Skip rooms that last reported nobody connected. */
  onlyIfWatched: boolean;
}

/** How long a room that reported nobody connected, or could not be reached, is left alone. */
const BACK_OFF_MS = 2000;

/**
 * Sends committed signals to other rooms. Best effort: each goes out once
 * and is not retried.
 */
export class SignalSender {
  #waiting: Signal[] = [];
  /** Rooms to leave alone, and until when. */
  #unwatched = new Map<string, number>();

  get pending(): boolean {
    return this.#waiting.length > 0;
  }

  add(signals: Signal[]): void {
    this.#waiting.push(...signals);
  }

  /** Sends everything waiting. `relay` delivers one signal and resolves to whether anyone is connected there. */
  async send(relay: (to: string, data: unknown) => Promise<boolean>): Promise<void> {
    const now = Date.now();
    await Promise.all(
      this.#waiting.splice(0).map(async ({ to, data, onlyIfWatched }) => {
        if (onlyIfWatched && (this.#unwatched.get(to) ?? 0) > now) return;
        try {
          if (await relay(to, data)) this.#unwatched.delete(to);
          else this.#unwatched.set(to, now + BACK_OFF_MS);
        } catch (err) {
          // Not retried by design. Back off so a broken neighbour is not hammered at tick rate.
          this.#unwatched.set(to, now + BACK_OFF_MS);
          console.error(`[tickflare] could not signal ${to}:`, err);
        }
      }),
    );
  }
}
