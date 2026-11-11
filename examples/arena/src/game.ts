// In your own project: import { Room, cellOf, reject, shardFor, type Player } from "tickflare";
import { Room, cellOf, reject, shardFor, type Player } from "../../../src/server/index.js";

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

/** What a dot takes along when it walks into the next arena. */
interface Luggage {
  score: number;
  hue: number;
  y: number;
  /** The side of the new arena the dot comes in from. */
  enters: "west" | "east";
}

interface Env {
  ROOMS: DurableObjectNamespace<Arena>;
}

/**
 * One arena of an endless row of them. Rooms are named like `lobby_3_0`:
 * walk a dot into the east or west wall and it is handed to the arena next
 * door, score and colour included.
 */
export class Arena extends Room<ArenaState, ArenaCommand, Env> {
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
    const clamp = (n: number) => Math.round(Math.min(SIZE, Math.max(0, n)) * 10) / 10;
    // A click close to the east or west wall means "go through it".
    const x = clamp(input.x as number);
    return { type: "move", x: x > SIZE - 8 ? SIZE : x < 8 ? 0 : x, y: clamp(input.y as number) };
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

    // A dot standing against the east or west wall walks on into the next arena.
    for (const [playerId, dot] of Object.entries(dots)) {
      const step = dot.x >= SIZE ? 1 : dot.x <= 0 ? -1 : 0;
      const next = step === 0 ? undefined : this.#neighbour(step);
      if (!next) continue;
      const luggage: Luggage = { score: dot.score, hue: dot.hue, y: dot.y, enters: step === 1 ? "west" : "east" };
      delete dots[playerId];
      this.clearTimer(`away:${playerId}`);
      this.movePlayer(playerId, next, luggage);
    }
  }

  protected override async handOver(roomId: string, playerId: string, carry: unknown): Promise<void> {
    const rooms = this.env.ROOMS;
    await rooms.get(rooms.idFromName(roomId)).arrive(roomId, playerId, carry);
  }

  protected override onArrive(player: Player, carry: unknown): void {
    const { score, hue, y, enters } = carry as Luggage;
    const x = enters === "west" ? 1 : SIZE - 1;
    // Head a little way in, so the dot does not walk straight back out.
    this.state.dots[player.id] = { x, y, tx: enters === "west" ? 60 : SIZE - 60, ty: y, score, hue };
  }

  /** The id of the arena `step` cells to the east, if this room is part of a row. */
  #neighbour(step: number): string | undefined {
    const world = this.roomId?.replace(/_-?\d+_-?\d+$/, "");
    const cell = this.roomId && world ? cellOf(this.roomId, world) : undefined;
    if (!cell || !world) return undefined;
    return shardFor((cell.cx + step) * SIZE, cell.cy * SIZE, SIZE, world);
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
