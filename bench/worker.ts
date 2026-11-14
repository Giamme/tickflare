/**
 * A Worker for measuring Tickflare on Cloudflare's own network. It is not an
 * example of a game: its one room holds things that all move on every tick,
 * which is the most a room can be asked to send.
 *
 * `.github/workflows/measure.yml` deploys it, runs `load.mjs` against it and
 * deletes it again. Every request needs the key the workflow made for that
 * run, so nobody else can use it meanwhile.
 */
import { Room, reject, routeToRoom, type Player } from "../src/server/index.js";

interface Unit {
  x: number;
  y: number;
  hp: number;
}
interface Thing extends Unit {
  vx: number;
  vy: number;
}
interface State {
  /** Units that all move every tick, in a list: what a player sees of them is `sight`. */
  units: Unit[];
  /** Units that walk as units in a game do, keyed by id: every player sees all of them. */
  things: Record<string, Thing>;
  moves: number;
}
type Command =
  | { type: "setup"; units: number; rate: number; sight: number; walkers?: "int" | "dec1" | "float" }
  | { type: "move" }
  | { type: "noop" };

interface Env {
  ROOMS: DurableObjectNamespace;
  IDLE: DurableObjectNamespace;
  BENCH_KEY: string;
}

export class Bench extends Room<State, Command, Env> {
  protected override tickRate = 10;
  protected override maxCommandsPerSecond = 1_000_000;
  #sight = 0;
  #round: (n: number) => number = (n) => n;
  /** How many times this room has been started: once, unless Cloudflare took it out of memory. */
  #starts: number;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS bench_starts (id INTEGER PRIMARY KEY, n INTEGER NOT NULL)");
    ctx.storage.sql.exec("INSERT INTO bench_starts (id, n) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET n = n + 1");
    this.#starts = ctx.storage.sql.exec<{ n: number }>("SELECT n FROM bench_starts WHERE id = 1").one().n;
  }

  /** How the room is, for the load script to ask once its players have gone. */
  protected override onHttp(): Response {
    const states = [0, 0, 0, 0];
    for (const ws of this.ctx.getWebSockets()) states[ws.readyState] = (states[ws.readyState] ?? 0) + 1;
    return Response.json({
      tick: this.tick,
      starts: this.#starts,
      connected: this.players.filter((player) => player.connected).length,
      seats: this.players.length,
      // Sockets by state: connecting, open, closing, closed.
      sockets: states,
      rate: this.tickRate,
      sight: this.#sight,
    });
  }

  protected initialState(): State {
    return { units: [], things: {}, moves: 0 };
  }

  protected parseCommand(raw: unknown): Command {
    return raw as Command;
  }

  protected override shouldTick(): boolean {
    return this.state.units.length > 0 || Object.keys(this.state.things).length > 0;
  }

  protected onCommand(_player: Player, command: Command): void {
    if (command.type === "setup") {
      this.tickRate = command.rate;
      this.#sight = command.sight;
      if (command.walkers) {
        const walkers = command.walkers;
        this.#round = walkers === "int" ? Math.round : walkers === "dec1" ? (n) => Math.round(n * 10) / 10 : (n) => n;
        for (let i = 0; i < command.units; i++) {
          this.state.things[`u${i}`] = {
            x: this.#round(Math.random() * 1000),
            y: this.#round(Math.random() * 1000),
            hp: 100,
            vx: 0,
            vy: 0,
          };
        }
        return;
      }
      this.state.units = Array.from({ length: command.units }, (_, i) => ({ x: (i * 37) % 1000, y: (i * 91) % 1000, hp: 100 }));
    } else if (command.type === "move") {
      this.state.moves += 1;
    } else if (command.type !== "noop") {
      reject("bad");
    }
  }

  protected override onTick(): void {
    // Things walk in straight lines and turn now and then, as units in a game do.
    for (const thing of Object.values(this.state.things)) {
      if (thing.vx === 0 || Math.random() < 0.05) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 2 + Math.random() * 6;
        thing.vx = Math.cos(angle) * speed;
        thing.vy = Math.sin(angle) * speed;
      }
      thing.x = this.#round(Math.min(1000, Math.max(0, thing.x + thing.vx)));
      thing.y = this.#round(Math.min(1000, Math.max(0, thing.y + thing.vy)));
      if (Math.random() < 0.01) thing.hp = Math.max(0, thing.hp - 5);
    }
    for (const unit of this.state.units) {
      unit.x = (unit.x + 3) % 1000;
      unit.y = (unit.y + 1) % 1000;
    }
  }

  protected override view(player: Player): unknown {
    if (Object.keys(this.state.things).length > 0) {
      // What a client is sent: where things are, not how fast they go.
      const seen: Record<string, Unit> = {};
      for (const [id, { x, y, hp }] of Object.entries(this.state.things)) seen[id] = { x, y, hp };
      return { things: seen, moves: this.state.moves };
    }
    if (this.#sight === 0) return { units: this.state.units, moves: this.state.moves };
    // Each player sees what is within `sight` of a point of their own.
    const n = Number(player.id.slice(1)) || 0;
    const cx = (n * 173) % 1000;
    const cy = (n * 61) % 1000;
    const sight = this.#sight;
    return {
      units: this.state.units.filter((unit) => Math.abs(unit.x - cx) < sight && Math.abs(unit.y - cy) < sight),
      moves: this.state.moves,
    };
  }
}

/** The same room under another name, so that what it is billed for can be told apart: nothing happens in these. */
export class Idle extends Bench {}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");
    if (!env.BENCH_KEY || key !== env.BENCH_KEY) return new Response("Not found", { status: 404 });
    const authenticate = (): string | Response => url.searchParams.get("player") ?? new Response("Who?", { status: 401 });
    if (url.pathname === "/health") return new Response("ok");
    return (
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate })) ??
      (await routeToRoom(request, { rooms: env.IDLE, prefix: "/idle", authenticate })) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
