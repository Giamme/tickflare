<script setup lang="ts">
/**
 * A model of a lockstep room, run in the page. The room never runs the game:
 * ten times a second it closes a turn holding whatever orders arrived, and
 * sends both screens the same turns. Each screen runs its own copy of the
 * skirmish over them, and reports a hash so the room can tell they agree.
 * Every few seconds one screen also sends the room its simulation, which the
 * room keeps as a snapshot once the hashes agree: a screen that comes back
 * starts from it. Nothing here talks to a server.
 */
import { reactive, ref } from "vue";
import { disc, fit, useLoop } from "./demo/loop";
import { hue, names, other, who, type Who } from "./demo/shared";
import { HP, WORLD, create, hash, load, save, step, type Entry, type Order, type Sim } from "./demo/skirmish";
import { createWires } from "./demo/wires";

const TURN_MS = 100;
const HASH_EVERY = 20;
/** A real room takes a snapshot a minute. Here it is every six seconds, so that there is one to see. */
const SNAPSHOT_EVERY = 60;
/** The two players are not equally far from the room. */
const lag: Record<Who, number> = { ada: 180, grace: 340 };
const SEED = 20261112;

// ---- The room: it orders inputs into turns, and nothing else --------------------------------

let pending: Entry[] = [];
/** Every turn in which something happened. Empty turns are not kept. */
const recording = new Map<number, Entry[]>();
const hashes = new Map<number, Partial<Record<Who, string>>>();
/** A simulation one screen saved, and the hash it reported with it. */
interface Snapshot {
  turn: number;
  hash: string;
  data: string;
}
/** The snapshot the room has, and one that waits for the other screen to report the same hash. */
let snapshot: Snapshot | undefined;
let offered: (Snapshot & { by: Who }) | undefined;
const joined: Record<Who, boolean> = { ada: true, grace: true };

function describe(entry: Entry): string {
  const name = names[entry.player];
  if (entry.input) return `${name}: go to ${Math.round(entry.input.x / 10)}, ${Math.round(entry.input.y / 10)}`;
  return entry.event === "disconnect" ? `${name} dropped` : `${name} is back`;
}

/** The room's tick: whatever arrived since the last turn becomes this one. */
function closeTurn(): void {
  ui.turn += 1;
  const turn = ui.turn;
  const entries = pending;
  pending = [];
  if (entries.length > 0) {
    recording.set(turn, entries);
    for (const entry of entries) ui.log.push({ key: `${turn}-${ui.log.length}-${entry.player}`, turn, player: entry.player, text: describe(entry) });
    while (ui.log.length > 6) ui.log.shift();
  }
  for (const player of who) {
    if (joined[player]) wires.send(clock, player, false, entries.length > 0 ? "full" : "turn", "", () => receive(player, turn, entries), lag[player]);
  }
}

function roomHash(player: Who, turn: number, value: string, data?: string): void {
  if (!joined[player]) return;
  const reported = { ...hashes.get(turn), [player]: value };
  hashes.set(turn, reported);
  hashes.delete(turn - 5 * HASH_EVERY);
  // A snapshot is kept when the other screen reported the same hash for its turn. The room cannot
  // check one itself: it has no simulation. A screen on its own is not taken at its word.
  if (data !== undefined) offered = { turn, hash: value, data, by: player };
  if (offered?.turn === turn && joined[other(offered.by)] && reported[other(offered.by)] === offered.hash) {
    snapshot = offered;
    offered = undefined;
    ui.snapshot = turn;
  }
  // Shown once there is something to compare, or nobody else to wait for.
  const compared = Boolean(reported.ada && reported.grace) || !joined[other(player)];
  if (compared && turn >= ui.check.turn) ui.check = { turn, ...reported };
}

// ---- The screens: each runs the whole game from the turns it is sent ------------------------

interface Client {
  sim: Sim;
  turn: number;
  /** False while the recording is being replayed after (re)connecting. */
  ready: boolean;
  /** Live turns that arrived before the recording did. */
  buffer: Map<number, Entry[]>;
  /** Where the units stood a turn ago, and when this turn was applied: for gliding between them. */
  before: Order[];
  at: number;
  click: (Order & { until: number }) | null;
  orderAt: number;
  handsOffUntil: number;
}

const places = (sim: Sim): Order[] => sim.units.map(({ x, y }) => ({ x, y }));
const fresh = (orderAt: number): Client => {
  const sim = create(SEED);
  return { sim, turn: 0, ready: true, buffer: new Map(), before: places(sim), at: 0, click: null, orderAt, handsOffUntil: 0 };
};
const clients: Record<Who, Client> = { ada: fresh(700), grace: fresh(1900) };

function receive(player: Who, turn: number, entries: Entry[]): void {
  const client = clients[player];
  if (!client.ready) client.buffer.set(turn, entries);
  else if (turn === client.turn + 1) apply(player, entries, turn, true);
}

function apply(player: Who, entries: Entry[], turn: number, live: boolean): void {
  const client = clients[player];
  client.before = places(client.sim);
  step(client.sim, entries);
  client.turn = turn;
  client.at = clock;
  ui.at[player] = turn;
  if (live && turn % HASH_EVERY === 0) {
    const value = hash(client.sim);
    // One screen sends the snapshots: the first of those connected.
    const data = turn % SNAPSHOT_EVERY === 0 && who.find((each) => joined[each]) === player ? save(client.sim) : undefined;
    wires.send(clock, player, true, "ack", data === undefined ? "hash" : "snapshot", () => roomHash(player, turn, value, data), lag[player]);
  }
}

/**
 * After (re)connecting: start from the room's snapshot and run the turns
 * since, or the whole recording if there is no snapshot yet. Then carry on
 * with the live turns.
 */
function catchUp(player: Who, upTo: number, from: Snapshot | undefined): void {
  const client = clients[player];
  // A snapshot is another screen's work: it is used only if it hashes to what both reported.
  const loaded = from && load(from.data);
  const trusted = loaded !== undefined && hash(loaded) === from!.hash;
  client.sim = trusted ? loaded : create(SEED);
  for (let turn = trusted ? from!.turn + 1 : 1; turn <= upTo; turn++) step(client.sim, recording.get(turn) ?? []);
  client.turn = upTo;
  for (let turn = upTo + 1; client.buffer.has(turn); turn++) apply(player, client.buffer.get(turn)!, turn, false);
  client.buffer.clear();
  client.before = places(client.sim);
  client.ready = true;
  ui.at[player] = client.turn;
}

function order(player: Who, to: Order): void {
  const input = { x: Math.round(Math.max(80, Math.min(WORLD - 80, to.x))), y: Math.round(Math.max(80, Math.min(WORLD - 80, to.y))) };
  wires.send(clock, player, true, "cmd", "input", () => joined[player] && pending.push({ player, input }), lag[player]);
}

/** Until the visitor takes a side, each player sends their squad somewhere every few seconds. */
function think(player: Who): void {
  const client = clients[player];
  if (clock < client.orderAt || !ui.connected[player] || !client.ready) return;
  client.orderAt = clock + 2600 + Math.random() * 2600;
  if (clock < client.handsOffUntil) return;
  const enemies = client.sim.units.filter((unit) => unit.side !== player && unit.down === 0);
  const chase = enemies.length > 0 && Math.random() < 0.6;
  const middle = chase
    ? { x: enemies.reduce((sum, unit) => sum + unit.x, 0) / enemies.length, y: enemies.reduce((sum, unit) => sum + unit.y, 0) / enemies.length }
    : { x: WORLD / 2, y: WORLD / 2 };
  const spread = chase ? 160 : 640;
  order(player, { x: middle.x + (Math.random() - 0.5) * spread, y: middle.y + (Math.random() - 0.5) * spread });
}

// ---- What the visitor can do ----------------------------------------------------------------

let clock = 0;

const ui = reactive({
  turn: 0,
  connected: { ada: true, grace: true } as Record<Who, boolean>,
  at: { ada: 0, grace: 0 } as Record<Who, number>,
  log: [] as { key: string; turn: number; player: Who; text: string }[],
  /** The turn of the snapshot the room has. 0 before the first. */
  snapshot: 0,
  check: { turn: 0 } as { turn: number } & Partial<Record<Who, string>>,
});
const narration = ref("Click a screen to send its squad somewhere.");
const root = ref<HTMLElement | null>(null);
const canvases: Partial<Record<Who, HTMLCanvasElement>> = {};

function send(player: Who, to: Order): void {
  if (!ui.connected[player]) return;
  const client = clients[player];
  client.click = { ...to, until: clock + 900 };
  client.handsOffUntil = clock + 9000;
  order(player, to);
  narration.value = `${names[player]} sent an order. The room puts it in the next turn, and both screens act on it in that turn.`;
  if (!playing.value) play();
}

function onClick(player: Who, event: MouseEvent): void {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  send(player, { x: ((event.clientX - box.left) / box.width) * WORLD, y: ((event.clientY - box.top) / box.height) * WORLD });
}

function onKey(player: Who, event: KeyboardEvent): void {
  const move: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const direction = move[event.key];
  if (!direction) return;
  event.preventDefault();
  const target = clients[player].sim.target[player];
  send(player, { x: target.x + direction[0] * 160, y: target.y + direction[1] * 160 });
}

function toggleTab(player: Who): void {
  const client = clients[player];
  if (ui.connected[player]) {
    ui.connected[player] = false;
    joined[player] = false;
    wires.drop(player);
    client.ready = false;
    client.buffer.clear();
    pending.push({ player, event: "disconnect" });
    narration.value = `${names[player]} closed the tab. That is an entry in a turn too, so every simulation sees her drop at the same moment.`;
  } else {
    ui.connected[player] = true;
    joined[player] = true;
    pending.push({ player, event: "reconnect" });
    const upTo = ui.turn;
    const from = snapshot;
    wires.send(clock, player, false, "welcome", from ? "snapshot" : "replay", () => catchUp(player, upTo, from), 520);
    client.handsOffUntil = 0;
    client.orderAt = clock + 2200;
    narration.value = from
      ? `${names[player]} is back. Her screen starts from the snapshot of turn ${from.turn}, runs the ${upTo - from.turn} turns since, and lands where everyone else is.`
      : `${names[player]} is back. There is no snapshot yet, so her screen runs the recording from the first turn and lands where everyone else is.`;
  }
  if (!playing.value) draw();
}

function verdict(): [string, string] {
  const { turn, ada, grace } = ui.check;
  if (!turn) return [`Screens report a hash every ${HASH_EVERY} turns`, ""];
  if (ada && grace) return [`Turn ${turn}: ${ada} and ${grace}`, ada === grace ? "The screens are in step" : "The screens disagree"];
  const one = ada ? "ada" : "grace";
  return [`Turn ${turn}: ${names[one]} reports ${ui.check[one]}`, ui.connected[other(one)] ? `Waiting for ${names[other(one)]}` : "Nobody to compare with"];
}

// ---- Drawing --------------------------------------------------------------------------------

let display = "sans-serif";

function drawScreen(player: Who): void {
  const canvas = canvases[player];
  const ctx = canvas && fit(canvas);
  if (!canvas || !ctx) return;
  const k = canvas.width / WORLD;
  const client = clients[player];

  ctx.fillStyle = "#0b101c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!ui.connected[player]) return;

  // No fog here: in lockstep every screen holds the whole game.
  ctx.fillStyle = "#18213a";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "rgba(255,255,255,.05)";
  ctx.lineWidth = 1;
  for (let line = 125; line < WORLD; line += 125) {
    ctx.beginPath();
    ctx.moveTo(line * k, 0);
    ctx.lineTo(line * k, canvas.height);
    ctx.moveTo(0, line * k);
    ctx.lineTo(canvas.width, line * k);
    ctx.stroke();
  }
  if (!client.ready) return;

  const { sim } = client;
  const t = Math.min(1, (clock - client.at) / TURN_MS);
  const where = sim.units.map((unit, index) => {
    const from = client.before[index]!;
    // A unit that just came back at its base appears there; it does not fly home.
    const jumped = Math.abs(unit.x - from.x) + Math.abs(unit.y - from.y) > 200;
    return jumped ? unit : { x: from.x + (unit.x - from.x) * t, y: from.y + (unit.y - from.y) * t };
  });

  const goal = sim.target[player];
  ctx.strokeStyle = hue[player] + "aa";
  ctx.lineWidth = Math.max(1.5, k * 5);
  ctx.beginPath();
  ctx.moveTo((goal.x - 18) * k, (goal.y - 18) * k);
  ctx.lineTo((goal.x + 18) * k, (goal.y + 18) * k);
  ctx.moveTo((goal.x + 18) * k, (goal.y - 18) * k);
  ctx.lineTo((goal.x - 18) * k, (goal.y + 18) * k);
  ctx.stroke();

  ctx.strokeStyle = `rgba(255,255,255,${(0.75 * (1 - t)).toFixed(2)})`;
  ctx.lineWidth = Math.max(1, k * 4);
  for (const [from, to] of sim.shots) {
    ctx.beginPath();
    ctx.moveTo(where[from]!.x * k, where[from]!.y * k);
    ctx.lineTo(where[to]!.x * k, where[to]!.y * k);
    ctx.stroke();
  }

  sim.units.forEach((unit, index) => {
    if (unit.down > 0) return;
    disc(ctx, k, where[index]!, 27);
    if (sim.away[unit.side]) {
      // Their player dropped: the squad holds, drawn hollow.
      ctx.strokeStyle = hue[unit.side];
      ctx.lineWidth = Math.max(1.5, k * 7);
      ctx.stroke();
      return;
    }
    ctx.globalAlpha = 0.4 + (0.6 * unit.hp) / HP;
    ctx.fillStyle = hue[unit.side];
    ctx.fill();
    ctx.globalAlpha = 1;
    if (unit.side === player) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(1, k * 5);
      ctx.stroke();
    }
  });

  // The score lives on the screens: the room never learns it.
  ctx.font = `700 ${Math.round(k * 68)}px ${display}`;
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillStyle = hue.ada;
  ctx.fillText(String(sim.kills.ada), k * 36, k * 30);
  ctx.textAlign = "right";
  ctx.fillStyle = hue.grace;
  ctx.fillText(String(sim.kills.grace), canvas.width - k * 36, k * 30);

  const click = client.click;
  if (click && click.until > clock) {
    const left = (click.until - clock) / 900;
    ctx.strokeStyle = `rgba(255,255,255,${left.toFixed(2)})`;
    ctx.lineWidth = Math.max(1.5, k * 5);
    disc(ctx, k, click, 20 + (1 - left) * 40);
    ctx.stroke();
  }
}

function draw(): void {
  for (const player of who) drawScreen(player);
}

// ---- The loop -------------------------------------------------------------------------------

let owed = 0;

function advance(ms: number): void {
  clock += ms;
  owed += ms;
  while (owed >= TURN_MS) {
    owed -= TURN_MS;
    closeTurn();
  }
  for (const player of who) think(player);
  wires.move(clock);
}

function setup(): void {
  display = getComputedStyle(document.documentElement).getPropertyValue("--tf-display") || display;
}

const { playing, vertical, waiting, play, pause } = useLoop(root, { setup, advance, draw });
const wires = createWires(vertical, lag.ada);
</script>

<template>
  <figure ref="root" class="tf-demo" :class="{ vertical }">
    <div class="stage">
      <template v-for="(p, index) in who" :key="p">
        <div class="panel screen" :class="p">
          <div class="bar">
            <span class="title"><i :style="{ background: hue[p] }" /><span>{{ names[p] }}<span class="more">'s screen</span></span></span>
            <button type="button" class="tab" :aria-label="`${ui.connected[p] ? 'Close' : 'Open'} ${names[p]}'s tab`" @click="toggleTab(p)">
              {{ ui.connected[p] ? "Close" : "Open" }}<span class="more"> tab</span>
            </button>
          </div>
          <div class="glass">
            <canvas
              :ref="(el) => el && (canvases[p] = el as HTMLCanvasElement)"
              tabindex="0"
              :aria-label="`${names[p]}'s screen. Click, or use the arrow keys, to send ${names[p]}'s squad somewhere.`"
              @click="onClick(p, $event)"
              @keydown="onKey(p, $event)"
            />
            <p v-if="!ui.connected[p]" class="closed">Tab closed</p>
          </div>
          <p class="foot hint">
            <template v-if="ui.connected[p]">Click to send {{ names[p] }}'s squad<br /><span class="turn">at turn {{ ui.at[p] }}</span></template>
            <template v-else>The room keeps the seat</template>
          </p>
        </div>

        <div :ref="(el) => el && (wires.hosts[p] = el as HTMLElement)" class="wire" :class="[p, { cut: !ui.connected[p] }]" aria-hidden="true" />

        <div v-if="index === 0" class="panel room">
          <div class="bar">
            <span class="title">Room <span class="muted">skirmish</span></span>
            <span class="count">turn {{ ui.turn }}</span>
          </div>
          <div class="glass">
            <div class="recording">
              <p class="head">The recording</p>
              <ol v-if="ui.log.length" aria-label="The latest turns in which something happened">
                <li v-for="line in ui.log" :key="line.key">
                  <span class="n">{{ line.turn }}</span><i :style="{ background: hue[line.player] }" /><span>{{ line.text }}</span>
                </li>
              </ol>
              <p v-else class="none">No orders yet. Empty turns are not kept.</p>
              <p class="kept">{{ ui.snapshot ? `Snapshot of turn ${ui.snapshot}` : "No snapshot yet" }}</p>
              <div class="beat" aria-hidden="true"><i v-for="n in 10" :key="n" :class="{ on: ui.turn % 10 === n - 1 }" /></div>
            </div>
          </div>
          <p class="foot hint check" :class="{ apart: ui.check.ada && ui.check.grace && ui.check.ada !== ui.check.grace }">
            {{ verdict()[0] }}<br /><strong>{{ verdict()[1] }}</strong>
          </p>
        </div>
      </template>
    </div>
    <figcaption>
      <p class="narration" aria-live="polite">{{ waiting ? "Press Play, or click a screen to send its squad somewhere." : narration }}</p>
      <p class="caption">
        <button type="button" class="playpause" @click="playing ? pause(true) : play()">{{ playing ? "Pause" : "Play" }}</button>
        <span class="long">A skirmish that runs twice in your browser, once on each screen, and never in the room. The room cuts
        time into ten turns a second and sends both screens the same ones: </span><span class="key dot turn" /> turns out, <span class="key pill">input</span> orders in<span class="more">, <span class="key pill ack">hash</span> to check that the screens agree</span>.
      </p>
    </figcaption>
  </figure>
</template>

<style scoped>
.recording {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 7% 8% 6%;
  font-size: clamp(11px, 1.05vw, 12.5px);
  line-height: 1.35;
  color: var(--tf-ink);
}

.head {
  margin: 0 0 6px;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 700;
  font-size: 13px;
}

ol {
  flex: 1;
  min-height: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

li {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2.5px 0;
  white-space: nowrap;
}

.n {
  min-width: 2.6em;
  color: var(--tf-slate);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

li i {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.none {
  flex: 1;
  margin: 0;
  color: var(--tf-slate);
}

/* What a screen that comes back starts from. */
.kept {
  margin: 6px 0 0;
  color: var(--tf-slate);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

/* One mark for each turn of the second, lit as the room closes it. */
.beat {
  display: grid;
  grid-template-columns: repeat(10, 1fr);
  gap: 3px;
  margin-top: 8px;
}

.beat i {
  height: 4px;
  border-radius: 2px;
  background: var(--tf-line);
}

.beat i.on {
  background: var(--tf-ink);
}

.turn {
  font-variant-numeric: tabular-nums;
}

.check strong {
  font-weight: 600;
  color: var(--tf-ink);
}

.check.apart strong {
  color: var(--tf-flare-text);
}

@media (max-width: 760px) {
  .recording {
    font-size: 11.5px;
  }
}
</style>
