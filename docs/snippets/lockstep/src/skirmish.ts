import { LockstepRoom, reject } from "tickflare";

/** "Send my squad to this point." */
export interface Order {
  x: number;
  y: number;
}

// The whole room. It never runs the game: ten times a second it closes a turn
// holding the orders that arrived, records it, and sends every player the same turns.
export class Skirmish extends LockstepRoom<Order> {
  protected override tickRate = 10; // turns a second
  protected override maxPlayers = 2;

  // Every player's simulation will be fed what this returns, so refuse anything odd.
  protected parseInput(raw: unknown): Order {
    const order = raw as Partial<Order> | null;
    const onTheMap = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1000;
    if (!onTheMap(order?.x) || !onTheMap(order?.y)) return reject("invalid_order");
    return { x: order.x, y: order.y };
  }
}
