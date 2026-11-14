/**
 * The simulation the lockstep demo runs on each screen: two squads that walk
 * where they are sent and shoot what comes near. Whole numbers only, and all
 * chance from the seed, so every copy that is fed the same turns stays
 * identical. The room never runs this.
 */
import type { Who } from "./shared";

export interface Order {
  x: number;
  y: number;
}

export interface Entry {
  player: Who;
  input?: Order;
  event?: "disconnect" | "reconnect";
}

export interface Unit {
  id: number;
  side: Who;
  slot: number;
  x: number;
  y: number;
  hp: number;
  /** Turns until it may shoot again. */
  wait: number;
  /** Turns until it is back at its base. 0 while it is on the field. */
  down: number;
}

export interface Sim {
  units: Unit[];
  target: Record<Who, Order>;
  away: Record<Who, boolean>;
  kills: Record<Who, number>;
  /** Shots fired in the last turn, for drawing. */
  shots: [from: number, to: number][];
  random: Random;
}

/** A seeded generator, and the one number that says where it stands. */
type Random = (() => number) & { readonly state: number };

export const WORLD = 1000;
export const HP = 5;
const SPEED = 16;
const RANGE = 170;
const RELOAD = 4;
const RESPAWN = 35;
const base: Record<Who, Order> = { ada: { x: 150, y: 500 }, grace: { x: 850, y: 500 } };
const formation = [
  [0, 0],
  [-60, -60],
  [60, -60],
  [-60, 60],
  [60, 60],
] as const;

/** mulberry32, as `seededRandom` in Tickflare: the same numbers for the same seed, on every machine. */
function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return Object.defineProperty(next, "state", { get: () => a }) as Random;
}

/** The simulation as text, for a snapshot: the generator is saved as the number it stands at. */
export function save(sim: Sim): string {
  return JSON.stringify({ ...sim, random: sim.random.state });
}

/** The simulation `save` was given. */
export function load(saved: string): Sim {
  const sim = JSON.parse(saved) as Omit<Sim, "random"> & { random: number };
  return { ...sim, random: seededRandom(sim.random) };
}

export function create(seed: number): Sim {
  const units: Unit[] = [];
  for (const side of ["ada", "grace"] as const) {
    formation.forEach(([dx, dy], slot) => {
      units.push({ id: units.length, side, slot, x: base[side].x + dx, y: base[side].y + dy, hp: HP, wait: 0, down: 0 });
    });
  }
  return {
    units,
    target: { ada: { ...base.ada }, grace: { ...base.grace } },
    away: { ada: false, grace: false },
    kills: { ada: 0, grace: 0 },
    shots: [],
    random: seededRandom(seed),
  };
}

export function step(sim: Sim, entries: Entry[]): void {
  for (const { player, input, event } of entries) {
    if (input) sim.target[player] = input;
    if (event) sim.away[player] = event === "disconnect";
  }

  sim.shots = [];
  for (const unit of sim.units) {
    if (unit.down > 0) {
      unit.down -= 1;
      if (unit.down === 0) Object.assign(unit, { x: base[unit.side].x, y: base[unit.side].y, hp: HP });
      continue;
    }

    // A squad whose player dropped holds its ground.
    if (!sim.away[unit.side]) {
      const [fx, fy] = formation[unit.slot]!;
      const dx = sim.target[unit.side].x + fx - unit.x;
      const dy = sim.target[unit.side].y + fy - unit.y;
      const distance = Math.floor(Math.sqrt(dx * dx + dy * dy));
      if (distance <= SPEED) {
        unit.x += dx;
        unit.y += dy;
      } else {
        unit.x += Math.trunc((dx * SPEED) / distance);
        unit.y += Math.trunc((dy * SPEED) / distance);
      }
    }

    if (unit.wait > 0) {
      unit.wait -= 1;
      continue;
    }
    let nearest: Unit | undefined;
    let best = RANGE * RANGE;
    for (const enemy of sim.units) {
      if (enemy.side === unit.side || enemy.down > 0) continue;
      const d = (enemy.x - unit.x) ** 2 + (enemy.y - unit.y) ** 2;
      if (d < best) {
        best = d;
        nearest = enemy;
      }
    }
    if (!nearest) continue;
    unit.wait = RELOAD;
    sim.shots.push([unit.id, nearest.id]);
    if (sim.random() < 0.6) {
      nearest.hp -= 1;
      if (nearest.hp === 0) {
        nearest.down = RESPAWN;
        sim.kills[unit.side] += 1;
      }
    }
  }
}

/** A fingerprint of the simulation. Two screens in step print the same one. */
export function hash(sim: Sim): string {
  let h = 2166136261;
  for (const unit of sim.units) {
    for (const n of [unit.x, unit.y, unit.hp, unit.down]) h = Math.imul(h ^ n, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 4);
}
