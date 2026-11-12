import { LockstepRoom, reject } from "tickflare";

export interface Order {
  x: number;
  y: number;
}

export class Skirmish extends LockstepRoom<Order> {
  protected override tickRate = 10; // turns a second
  // The room has no timer. A player's client asks for each turn, and the room sleeps in between.
  protected override turnClock = "players" as const;

  protected parseInput(raw: unknown): Order {
    const order = raw as Partial<Order> | null;
    const onTheMap = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 1000;
    if (!onTheMap(order?.x) || !onTheMap(order?.y)) return reject("invalid_order");
    return { x: order.x, y: order.y };
  }
}
