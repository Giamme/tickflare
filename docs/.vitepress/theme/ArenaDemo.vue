<script setup lang="ts">
/**
 * A model of a small state-sync room, run in the page: an arena with two
 * players, the room between them, and the frames on the wires. The room
 * simulates at ten ticks a second and sends each screen only what its player
 * can see. Nothing here talks to a server.
 */
import { reactive, ref } from "vue";
import { disc, fit, useLoop } from "./demo/loop";
import { hue, names, who, type Who } from "./demo/shared";
import { createWires } from "./demo/wires";

interface Point {
  x: number;
  y: number;
}
interface View {
  me: Point;
  others: Record<string, Point>;
  pellets: Record<string, Point>;
  score: number;
}

const WORLD = 100;
const SIGHT = 30;
const SPEED = 26; // units a second
const TICK_MS = 100;
const LAG_MS = 260;
const PELLETS = 8;

// ---- The room: the only place the game runs -------------------------------------------------

const dots: Record<Who, Point & { tx: number; ty: number; score: number }> = {
  ada: { x: 24, y: 62, tx: 24, ty: 62, score: 0 },
  grace: { x: 78, y: 36, tx: 78, ty: 36, score: 0 },
};
let pellets: Record<string, Point> = {};
let pelletId = 0;
const joined: Record<Who, boolean> = { ada: true, grace: true };

function scatter(): void {
  pellets[`p${pelletId++}`] = { x: 8 + Math.random() * (WORLD - 16), y: 8 + Math.random() * (WORLD - 16) };
}

const near = (a: Point, b: Point, radius: number) => Math.hypot(a.x - b.x, a.y - b.y) <= radius;
const round = (n: number) => Math.round(n * 10) / 10;

/** What `player` is allowed to see: this is the room's `view()`. */
function viewFor(player: Who): View {
  const me = dots[player];
  const others: Record<string, Point> = {};
  for (const other of who) {
    if (other !== player && near(me, dots[other], SIGHT)) others[other] = { x: dots[other].x, y: dots[other].y };
  }
  const seen: Record<string, Point> = {};
  for (const [id, pellet] of Object.entries(pellets)) if (near(me, pellet, SIGHT)) seen[id] = pellet;
  return { me: { x: me.x, y: me.y }, others, pellets: seen, score: me.score };
}

function roomTick(): void {
  ui.tick += 1;
  for (const player of who) {
    const dot = dots[player];
    const dx = dot.tx - dot.x;
    const dy = dot.ty - dot.y;
    const distance = Math.hypot(dx, dy);
    const step = Math.min(distance, (SPEED * TICK_MS) / 1000);
    if (step > 0) {
      dot.x = round(dot.x + (dx / distance) * step);
      dot.y = round(dot.y + (dy / distance) * step);
    }
    for (const [id, pellet] of Object.entries(pellets)) {
      if (!near(dot, pellet, 4)) continue;
      delete pellets[id];
      dot.score += 1;
      ui.scores[player] = dot.score;
      scatter();
    }
  }
  for (const player of who) {
    if (!joined[player]) continue;
    const view = viewFor(player);
    wires.send(clock, player, false, "patch", "", () => receive(player, view));
  }
}

// ---- The screens: they draw what they were sent, nothing more -------------------------------

const screens: Record<Who, { prev: View; next: View; at: number; click: (Point & { until: number }) | null; steeredUntil: number; thinkAt: number }> = {
  ada: { prev: viewFor("ada"), next: viewFor("ada"), at: 0, click: null, steeredUntil: 0, thinkAt: 300 },
  grace: { prev: viewFor("grace"), next: viewFor("grace"), at: 0, click: null, steeredUntil: 0, thinkAt: 800 },
};

function receive(player: Who, view: View): void {
  const screen = screens[player];
  screen.prev = shown(player);
  screen.next = view;
  screen.at = clock;
}

/** The view a screen is drawing right now: gliding from the last patch to the newest. */
function shown(player: Who): View {
  const { prev, next, at } = screens[player];
  const t = Math.min(1, (clock - at) / TICK_MS);
  const glide = (from: Point | undefined, to: Point): Point =>
    from ? { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t } : to;
  const others: Record<string, Point> = {};
  for (const [id, to] of Object.entries(next.others)) others[id] = glide(prev.others[id], to);
  return { me: glide(prev.me, next.me), others, pellets: next.pellets, score: next.score };
}

/** Until the visitor steers, each player chases the nearest pellet they can see. */
function think(player: Who): void {
  const screen = screens[player];
  if (clock < screen.thinkAt || !ui.connected[player]) return;
  screen.thinkAt = clock + 700 + Math.random() * 600;
  if (clock < screen.steeredUntil) return;
  const { me, pellets: seen } = screen.next;
  let target: Point | undefined;
  for (const pellet of Object.values(seen)) {
    if (!target || Math.hypot(pellet.x - me.x, pellet.y - me.y) < Math.hypot(target.x - me.x, target.y - me.y)) target = pellet;
  }
  target ??= { x: 12 + Math.random() * (WORLD - 24), y: 12 + Math.random() * (WORLD - 24) };
  command(player, target);
}

function command(player: Who, target: Point): void {
  const to = { x: Math.max(3, Math.min(WORLD - 3, target.x)), y: Math.max(3, Math.min(WORLD - 3, target.y)) };
  wires.send(clock, player, true, "cmd", "cmd", () => {
    if (!joined[player]) return;
    dots[player].tx = to.x;
    dots[player].ty = to.y;
  });
}

// ---- What the visitor can do ----------------------------------------------------------------

let clock = 0;

const ui = reactive({
  tick: 0,
  connected: { ada: true, grace: true } as Record<Who, boolean>,
  scores: { ada: 0, grace: 0 } as Record<Who, number>,
});
const narration = ref("Click a screen to steer its player.");
const root = ref<HTMLElement | null>(null);
const canvases: Partial<Record<Who | "room", HTMLCanvasElement>> = {};

function steer(player: Who, target: Point): void {
  if (!ui.connected[player]) return;
  const screen = screens[player];
  screen.click = { ...target, until: clock + 900 };
  screen.steeredUntil = clock + 8000;
  command(player, target);
  narration.value = `${names[player]} sent a move. The room moves her dot and tells both screens.`;
  if (!playing.value) play();
}

function onClick(player: Who, event: MouseEvent): void {
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  steer(player, { x: ((event.clientX - box.left) / box.width) * WORLD, y: ((event.clientY - box.top) / box.height) * WORLD });
}

function onKey(player: Who, event: KeyboardEvent): void {
  const step: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const direction = step[event.key];
  if (!direction) return;
  event.preventDefault();
  const me = screens[player].next.me;
  steer(player, { x: me.x + direction[0] * 22, y: me.y + direction[1] * 22 });
}

function toggleTab(player: Who): void {
  if (ui.connected[player]) {
    ui.connected[player] = false;
    joined[player] = false;
    wires.drop(player);
    dots[player].tx = dots[player].x;
    dots[player].ty = dots[player].y;
    narration.value = `${names[player]} closed the tab. The room keeps her seat and her score.`;
  } else {
    ui.connected[player] = true;
    joined[player] = true;
    const view = viewFor(player);
    wires.send(clock, player, false, "welcome", "welcome", () => {
      screens[player].prev = screens[player].next = view;
      screens[player].at = clock;
    });
    screens[player].steeredUntil = 0;
    screens[player].thinkAt = clock + 900;
    narration.value = `${names[player]} is back. One welcome frame brings her screen up to date.`;
  }
  if (!playing.value) draw();
}

// ---- Drawing --------------------------------------------------------------------------------

function drawScreen(player: Who): void {
  const canvas = canvases[player];
  const ctx = canvas && fit(canvas);
  if (!canvas || !ctx) return;
  const k = canvas.width / WORLD;
  const view = shown(player);

  ctx.fillStyle = "#0b101c";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!ui.connected[player]) return;

  // Everything the screen knows about lies inside this circle. The rest was never sent.
  const glow = ctx.createRadialGradient(view.me.x * k, view.me.y * k, SIGHT * k * 0.2, view.me.x * k, view.me.y * k, SIGHT * k);
  glow.addColorStop(0, "#243154");
  glow.addColorStop(1, "#18213a");
  ctx.fillStyle = glow;
  disc(ctx, k, view.me, SIGHT);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,.14)";
  ctx.lineWidth = Math.max(1, k * 0.3);
  ctx.stroke();

  ctx.fillStyle = "#eef1f8";
  for (const pellet of Object.values(view.pellets)) {
    disc(ctx, k, pellet, 1.3);
    ctx.fill();
  }
  for (const [id, at] of Object.entries(view.others)) {
    ctx.fillStyle = hue[id as Who];
    disc(ctx, k, at, 3.2);
    ctx.fill();
  }
  ctx.fillStyle = hue[player];
  disc(ctx, k, view.me, 3.6);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = Math.max(1.5, k * 0.6);
  ctx.stroke();

  const click = screens[player].click;
  if (click && click.until > clock) {
    const left = (click.until - clock) / 900;
    ctx.strokeStyle = `rgba(255,255,255,${left.toFixed(2)})`;
    ctx.lineWidth = Math.max(1.5, k * 0.5);
    disc(ctx, k, click, 2 + (1 - left) * 4);
    ctx.stroke();
  }
}

function drawRoom(): void {
  const canvas = canvases.room;
  const ctx = canvas && fit(canvas);
  if (!canvas || !ctx) return;
  const k = canvas.width / WORLD;
  const dark = document.documentElement.classList.contains("dark");

  ctx.fillStyle = dark ? "#14171f" : "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = dark ? "#262b38" : "#e4e8f0";
  ctx.lineWidth = 1;
  for (let line = 10; line < WORLD; line += 10) {
    ctx.beginPath();
    ctx.moveTo(line * k, 0);
    ctx.lineTo(line * k, canvas.height);
    ctx.moveTo(0, line * k);
    ctx.lineTo(canvas.width, line * k);
    ctx.stroke();
  }

  for (const player of who) {
    if (!ui.connected[player]) continue;
    ctx.fillStyle = hue[player] + "14";
    ctx.strokeStyle = hue[player] + "99";
    ctx.lineWidth = Math.max(1, k * 0.35);
    ctx.setLineDash([k * 1.6, k * 1.6]);
    disc(ctx, k, dots[player], SIGHT);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.fillStyle = dark ? "#e7eaf1" : "#182033";
  for (const pellet of Object.values(pellets)) {
    disc(ctx, k, pellet, 1.3);
    ctx.fill();
  }
  for (const player of who) {
    disc(ctx, k, dots[player], 3.4);
    if (ui.connected[player]) {
      ctx.fillStyle = hue[player];
      ctx.fill();
    } else {
      // Away, but still seated: the room keeps the dot.
      ctx.fillStyle = dark ? "#14171f" : "#ffffff";
      ctx.fill();
      ctx.strokeStyle = hue[player];
      ctx.lineWidth = Math.max(1.5, k * 0.7);
      ctx.stroke();
    }
  }
}

function draw(): void {
  for (const player of who) drawScreen(player);
  drawRoom();
}

// ---- The loop -------------------------------------------------------------------------------

let owed = 0;

function advance(ms: number): void {
  clock += ms;
  owed += ms;
  while (owed >= TICK_MS) {
    owed -= TICK_MS;
    roomTick();
  }
  for (const player of who) think(player);
  wires.move(clock);
}

function setup(): void {
  for (let n = 0; n < PELLETS; n++) scatter();
  for (const player of who) screens[player].prev = screens[player].next = viewFor(player);
}

const { playing, vertical, waiting, play, pause } = useLoop(root, { setup, advance, draw });
const wires = createWires(vertical, LAG_MS);
</script>

<template>
  <figure ref="root" class="tf-demo" :class="{ vertical }">
    <div class="stage">
      <template v-for="(p, index) in who" :key="p">
        <div class="panel screen" :class="[p, { away: !ui.connected[p] }]">
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
              :aria-label="`${names[p]}'s screen. Click, or use the arrow keys, to steer ${names[p]}.`"
              @click="onClick(p, $event)"
              @keydown="onKey(p, $event)"
            />
            <p v-if="!ui.connected[p]" class="closed">Tab closed</p>
          </div>
          <p class="foot hint">{{ ui.connected[p] ? `Click to steer ${names[p]}` : "The room keeps the seat" }}</p>
        </div>

        <div :ref="(el) => el && (wires.hosts[p] = el as HTMLElement)" class="wire" :class="[p, { cut: !ui.connected[p] }]" aria-hidden="true" />

        <div v-if="index === 0" class="panel room">
          <div class="bar">
            <span class="title">Room <span class="muted">arena</span></span>
            <span class="count">tick {{ ui.tick }}</span>
          </div>
          <div class="glass">
            <canvas :ref="(el) => el && (canvases.room = el as HTMLCanvasElement)" aria-label="The room: the whole arena, with what each player can see marked by a circle." />
          </div>
          <ul class="foot seats" aria-label="Seats">
            <li v-for="s in who" :key="s">
              <i :style="{ background: hue[s] }" />{{ names[s] }}
              <span :class="{ away: !ui.connected[s] }">{{ ui.connected[s] ? `${ui.scores[s]} eaten` : "away, seat kept" }}</span>
            </li>
          </ul>
        </div>
      </template>
    </div>
    <figcaption>
      <p class="narration" aria-live="polite">{{ waiting ? "Press Play, or click a screen to steer its player." : narration }}</p>
      <p class="caption">
        <button type="button" class="playpause" @click="playing ? pause(true) : play()">{{ playing ? "Pause" : "Play" }}</button>
        <span class="long">A tiny arena, simulated in your browser. The room runs the game ten times a second and sends
        each screen only what its player can see: </span><span class="key dot" /> patches out, <span class="key pill">cmd</span> <span class="more">moves </span>in.
      </p>
    </figcaption>
  </figure>
</template>
