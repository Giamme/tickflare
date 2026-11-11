// In your own project: import { Room, reject, type Player } from "tickflare";
import { Room, reject, type Player } from "../../../src/server/index.js";

/** The arena is a square this many units wide. */
const SIZE = 480;
/** Units a dot travels per second. */
const SPEED = 160;
/** How close a dot must be to eat a pellet. */
const REACH = 14;
const PELLETS = 12;
/** How long a disconnected player's dot stays in the arena. */
const AWAY_MS = 15_000;

interface Dot {
  x: number;
  y: number;
  /** Where the dot is heading. */
  tx: number;
  ty: number;
  score: number;
  hue: number;
}

// Dots and pellets are keyed by id, not kept in arrays, so a tick sends only
// the ones that moved.
export interface ArenaState {
  dots: Record<string, Dot>;
  pellets: Record<string, { x: number; y: number }>;
  nextPellet: number;
}

export type ArenaCommand = { type: "move"; x: number; y: number };

export class Arena extends Room<ArenaState, ArenaCommand> {
  protected override tickRate = 20;
  protected override maxPlayers = 16;

  protected initialState(): ArenaState {
    return { dots: {}, pellets: {}, nextPellet: 0 };
  }

  protected parseCommand(raw: unknown): ArenaCommand {
    const input = raw as { type?: unknown; x?: unknown; y?: unknown } | null;
    if (input?.type !== "move" || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      return reject("invalid_command");
    }
    const clamp = (n: number) => Math.min(SIZE, Math.max(0, n));
    return { type: "move", x: clamp(input.x as number), y: clamp(input.y as number) };
  }

  protected override onJoin(player: Player): void {
    const x = spot();
    const y = spot();
    this.state.dots[player.id] = { x, y, tx: x, ty: y, score: 0, hue: Math.floor(Math.random() * 360) };
  }

  protected onCommand(player: Player, command: ArenaCommand): void {
    const dot = this.state.dots[player.id];
    if (!dot) reject("not_seated");
    dot.tx = command.x;
    dot.ty = command.y;
  }

  protected override onTick(dt: number): void {
    const { dots, pellets } = this.state;

    for (const dot of Object.values(dots)) {
      const dx = dot.tx - dot.x;
      const dy = dot.ty - dot.y;
      const distance = Math.hypot(dx, dy);
      const step = SPEED * dt;
      if (distance <= step) {
        dot.x = dot.tx;
        dot.y = dot.ty;
      } else {
        // One decimal is plenty on screen and keeps the patches short.
        dot.x = Math.round((dot.x + (dx / distance) * step) * 10) / 10;
        dot.y = Math.round((dot.y + (dy / distance) * step) * 10) / 10;
      }
    }

    for (const [id, pellet] of Object.entries(pellets)) {
      const eater = Object.values(dots).find(
        (dot) => Math.hypot(dot.x - pellet.x, dot.y - pellet.y) < REACH,
      );
      if (eater) {
        eater.score += 1;
        delete pellets[id];
      }
    }
    while (Object.keys(pellets).length < PELLETS) {
      pellets[`p${this.state.nextPellet++}`] = { x: spot(), y: spot() };
    }
  }

  protected override onDisconnect(player: Player): void {
    this.setTimer(`away:${player.id}`, AWAY_MS);
  }

  protected override onReconnect(player: Player): void {
    this.clearTimer(`away:${player.id}`);
  }

  protected override onLeave(player: Player): void {
    delete this.state.dots[player.id];
  }

  protected override onTimer(name: string): void {
    if (!name.startsWith("away:")) return;
    const playerId = name.slice("away:".length);
    delete this.state.dots[playerId];
    this.removePlayer(playerId, "away");
  }
}

/** A random coordinate, away from the walls. */
function spot(): number {
  return Math.round(20 + Math.random() * (SIZE - 40));
}
