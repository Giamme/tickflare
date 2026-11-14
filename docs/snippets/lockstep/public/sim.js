// The game. Every player's browser runs this over the same turns, so it must
// come out the same everywhere: whole numbers only, and all chance from the seed.
import { seededRandom } from "./tickflare-client.js";

const SPEED = 16; // per turn
const RANGE = 170;
const bases = [{ x: 150, y: 500 }, { x: 850, y: 500 }];
const formation = [[0, 0], [-60, -60], [60, -60], [-60, 60], [60, 60]];

export function create(seed) {
  const units = bases.flatMap((base, side) =>
    formation.map(([dx, dy], slot) => ({ side, slot, x: base.x + dx, y: base.y + dy, hp: 5, wait: 0, down: 0 })),
  );
  return { units, sides: {}, target: bases.map((base) => ({ ...base })), kills: [0, 0], random: seededRandom(seed) };
}

export function step(sim, entries) {
  for (const { player, input, event } of entries) {
    // Joining is an entry in a turn, so every simulation seats the player at the same moment.
    if (event === "join" && Object.keys(sim.sides).length < 2) sim.sides[player] = Object.keys(sim.sides).length;
    if (input && player in sim.sides) sim.target[sim.sides[player]] = input;
  }

  for (const unit of sim.units) {
    if (unit.down > 0) {
      if (--unit.down === 0) Object.assign(unit, bases[unit.side], { hp: 5 });
      continue;
    }

    const dx = sim.target[unit.side].x + formation[unit.slot][0] - unit.x;
    const dy = sim.target[unit.side].y + formation[unit.slot][1] - unit.y;
    const distance = Math.floor(Math.sqrt(dx * dx + dy * dy));
    unit.x += distance <= SPEED ? dx : Math.trunc((dx * SPEED) / distance);
    unit.y += distance <= SPEED ? dy : Math.trunc((dy * SPEED) / distance);

    if (unit.wait > 0) {
      unit.wait -= 1;
      continue;
    }
    let nearest;
    let best = RANGE * RANGE;
    for (const enemy of sim.units) {
      const d = (enemy.x - unit.x) ** 2 + (enemy.y - unit.y) ** 2;
      if (enemy.side !== unit.side && enemy.down === 0 && d < best) [nearest, best] = [enemy, d];
    }
    if (!nearest) continue;
    unit.wait = 4;
    if (sim.random() < 0.6 && --nearest.hp === 0) {
      nearest.down = 35; // back at its base in 3.5 seconds
      sim.kills[unit.side] += 1;
    }
  }
}

// The simulation as JSON and back. Players' clients hash what `save` returns,
// so the room can tell when two of them disagree, and the room keeps a
// snapshot a minute: a player who reloads starts from it, not from turn 1.
export const save = (sim) => ({ ...sim, random: sim.random.state });
export const load = (saved) => ({ ...saved, random: seededRandom(saved.random) });
