import { Room, reject, type Player } from "tickflare";

interface Point {
  x: number;
  y: number;
}
interface Unit {
  from: Point;
  to: Point;
  leftAt: number;
  arrivesAt: number;
}
interface State {
  units: Record<string, Unit>;
}
export type Command = { type: "march"; x: number; y: number };

const SPEED = 40; // units a second

/** Where a unit is at `now`. Screens run the same sum on every frame to draw the walk. */
export function positionAt(unit: Unit, now: number): Point {
  const whole = unit.arrivesAt - unit.leftAt;
  const t = whole <= 0 ? 1 : Math.min(1, Math.max(0, (now - unit.leftAt) / whole));
  return { x: unit.from.x + (unit.to.x - unit.from.x) * t, y: unit.from.y + (unit.to.y - unit.from.y) * t };
}

// No tickRate. The room is awake for an order and for an arrival, and asleep while units walk.
export class March extends Room<State, Command> {
  protected initialState(): State {
    return { units: {} };
  }

  protected parseCommand(raw: unknown): Command {
    const c = raw as Partial<Command> | null;
    if (c?.type !== "march" || !Number.isFinite(c.x) || !Number.isFinite(c.y)) return reject("invalid_command");
    return { type: "march", x: c.x!, y: c.y! };
  }

  protected override onJoin(player: Player): void {
    const here = { x: 50, y: 50 };
    this.state.units[player.id] = { from: here, to: here, leftAt: 0, arrivesAt: 0 };
  }

  protected onCommand(player: Player, command: Command): void {
    const unit = this.state.units[player.id];
    if (!unit) return reject("not_playing");
    const now = Date.now();
    const from = positionAt(unit, now);
    const to = { x: command.x, y: command.y };
    const ms = (Math.hypot(to.x - from.x, to.y - from.y) / SPEED) * 1000;
    // Not "the unit is here" twenty times a second. "It left here then, and gets there at this time", once.
    this.state.units[player.id] = { from, to, leftAt: now, arrivesAt: now + ms };
    // Sleep until there is something to decide.
    this.setTimer(`arrive:${player.id}`, ms);
  }

  protected override onTimer(name: string): void {
    if (!name.startsWith("arrive:")) return;
    const unit = this.state.units[name.slice("arrive:".length)];
    if (!unit) return;
    // The unit is there. What arriving means in your game happens here: a capture, a fight, a score.
    unit.from = unit.to;
  }
}
