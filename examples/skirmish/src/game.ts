// In your own project: import { LockstepRoom, reject } from "tickflare";
import { LockstepRoom, reject } from "../../../src/server/index.js";

const SIZE = 480;

/** "Send my squad to this point." The room only checks and orders it; the clients simulate. */
export type Order = { type: "move"; x: number; y: number };

export class Skirmish extends LockstepRoom<Order> {
  protected override tickRate = 10;
  protected override maxPlayers = 4;

  protected parseInput(raw: unknown): Order {
    const input = raw as { type?: unknown; x?: unknown; y?: unknown } | null;
    if (input?.type !== "move" || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      return reject("invalid_order");
    }
    // Whole numbers only: every client must compute with exactly the same values.
    const whole = (n: number) => Math.min(SIZE, Math.max(0, Math.round(n)));
    return { type: "move", x: whole(input.x as number), y: whole(input.y as number) };
  }
}
