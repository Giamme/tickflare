<script setup lang="ts">
/**
 * A model of a small state-sync room, run in the page: an arena with two
 * players, the room between them, and the frames on the wires. The room
 * simulates at ten ticks a second and sends each screen only what its player
 * can see. Nothing here talks to a server.
 */
import { onBeforeUnmount, onMounted, reactive, ref } from "vue";

type Who = "ada" | "grace";
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
interface Flight {
  wire: Who;
  toRoom: boolean;
  leave: number;
  arrive: number;
  el: HTMLElement;
  land: () => void;
}

const WORLD = 100;
const SIGHT = 30;
const SPEED = 26; // units a second
const TICK_MS = 100;
const LAG_MS = 260;
const PELLETS = 8;

const who: Who[] = ["ada", "grace"];
const names: Record<Who, string> = { ada: "Ada", grace: "Grace" };
const hue: Record<Who, string> = { ada: "#ff4f36", grace: "#3d8bff" };

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
    send(player, false, "patch", () => receive(player, view));
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
  ui.seen[player] = view.score;
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
  send(player, true, "cmd", () => {
    if (!joined[player]) return;
    dots[player].tx = to.x;
    dots[player].ty = to.y;
  });
}

// ---- The wires ------------------------------------------------------------------------------

let clock = 0;
let flights: Flight[] = [];
const wires: Partial<Record<Who, HTMLElement>> = {};

function send(wire: Who, toRoom: boolean, kind: "patch" | "cmd" | "welcome", land: () => void): void {
  const host = wires[wire];
  if (!host) return land();
  const el = document.createElement("span");
  el.className = `pulse ${kind}`;
  if (kind !== "patch") el.textContent = kind;
  host.append(el);
  flights.push({ wire, toRoom, leave: clock, arrive: clock + LAG_MS, el, land });
}

function moveFlights(): void {
  const landed = flights.filter((flight) => flight.arrive <= clock);
  flights = flights.filter((flight) => flight.arrive > clock);
  for (const flight of landed) {
    flight.el.remove();
    flight.land();
  }
  for (const flight of flights) {
    const progress = (clock - flight.leave) / (flight.arrive - flight.leave);
    // Ada's wire runs from her screen to the room; Grace's from the room to her screen.
    const fromScreen = flight.wire === "ada" ? 0 : 1;
    const at = flight.toRoom ? fromScreen + (1 - 2 * fromScreen) * progress : 1 - fromScreen + (2 * fromScreen - 1) * progress;
    flight.el.style.setProperty("--at", `${(at * 100).toFixed(1)}%`);
  }
}

function drop(wire: Who): void {
  for (const flight of flights) if (flight.wire === wire) flight.el.remove();
  flights = flights.filter((flight) => flight.wire !== wire);
}

// ---- What the visitor can do ----------------------------------------------------------------

const ui = reactive({
  playing: false,
  tick: 0,
  connected: { ada: true, grace: true } as Record<Who, boolean>,
  scores: { ada: 0, grace: 0 } as Record<Who, number>,
  seen: { ada: 0, grace: 0 } as Record<Who, number>,
});
const narration = ref("Click a screen to steer its player.");
const vertical = ref(false);
const root = ref<HTMLElement | null>(null);
const canvases: Partial<Record<Who | "room", HTMLCanvasElement>> = {};
let userPaused = false;
let inView = false;

function steer(player: Who, target: Point): void {
  if (!ui.connected[player]) return;
  const screen = screens[player];
  screen.click = { ...target, until: clock + 900 };
  screen.steeredUntil = clock + 8000;
  command(player, target);
  narration.value = `${names[player]}'s screen sent a move. The room moves her dot; both screens hear back.`;
  if (!ui.playing) play();
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
    drop(player);
    dots[player].tx = dots[player].x;
    dots[player].ty = dots[player].y;
    narration.value = `${names[player]} closed the tab. The room keeps her seat and her score.`;
  } else {
    ui.connected[player] = true;
    joined[player] = true;
    const view = viewFor(player);
    send(player, false, "welcome", () => {
      screens[player].prev = screens[player].next = view;
      screens[player].at = clock;
    });
    screens[player].steeredUntil = 0;
    screens[player].thinkAt = clock + 900;
    narration.value = `${names[player]} is back. One welcome frame brings her screen up to date.`;
  }
  if (!ui.playing) draw();
}

function play(): void {
  userPaused = false;
  if (ui.playing) return;
  ui.playing = true;
  last = performance.now();
  frame = requestAnimationFrame(loop);
}

function pause(byUser: boolean): void {
  if (byUser) userPaused = true;
  ui.playing = false;
  cancelAnimationFrame(frame);
}

// ---- Drawing --------------------------------------------------------------------------------

function fit(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const size = Math.round(canvas.clientWidth * Math.min(2, window.devicePixelRatio || 1));
  if (size > 0 && canvas.width !== size) canvas.width = canvas.height = size;
  return canvas.getContext("2d");
}

function disc(ctx: CanvasRenderingContext2D, k: number, at: Point, radius: number): void {
  ctx.beginPath();
  ctx.arc(at.x * k, at.y * k, radius * k, 0, Math.PI * 2);
}

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

let frame = 0;
let last = 0;
let owed = 0;

function advance(ms: number): void {
  clock += ms;
  owed += ms;
  while (owed >= TICK_MS) {
    owed -= TICK_MS;
    roomTick();
  }
  for (const player of who) think(player);
  moveFlights();
}

function loop(now: number): void {
  // A tab that was in the background comes back with one long frame; don't replay it.
  advance(Math.min(50, now - last));
  last = now;
  draw();
  if (ui.playing) frame = requestAnimationFrame(loop);
}

let observer: IntersectionObserver | undefined;
let resize: ResizeObserver | undefined;
let media: MediaQueryList | undefined;
const onMedia = () => (vertical.value = media?.matches ?? false);
const onHidden = () => {
  if (document.hidden) pause(false);
  else if (inView && !userPaused) play();
};

onMounted(() => {
  for (let n = 0; n < PELLETS; n++) scatter();
  for (const player of who) screens[player].prev = screens[player].next = viewFor(player);

  media = window.matchMedia("(max-width: 760px)");
  onMedia();
  media.addEventListener("change", onMedia);
  document.addEventListener("visibilitychange", onHidden);
  resize = new ResizeObserver(() => !ui.playing && draw());
  if (root.value) resize.observe(root.value);
  draw();

  // With reduced motion the arena waits for the visitor to press Play.
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    userPaused = true;
    narration.value = "Press Play, or click a screen to steer its player.";
    return;
  }
  observer = new IntersectionObserver(
    (entries) => {
      inView = entries.some((entry) => entry.isIntersecting);
      if (inView && !userPaused) play();
      else if (!inView) pause(false);
    },
    { threshold: 0.25 },
  );
  if (root.value) observer.observe(root.value);
});

onBeforeUnmount(() => {
  pause(false);
  observer?.disconnect();
  resize?.disconnect();
  media?.removeEventListener("change", onMedia);
  document.removeEventListener("visibilitychange", onHidden);
});
</script>

<template>
  <figure ref="root" class="demo" :class="{ vertical }">
    <div class="stage">
      <template v-for="(p, index) in who" :key="p">
        <div class="panel screen" :class="[p, { away: !ui.connected[p] }]">
          <div class="bar">
            <span class="title"><i :style="{ background: hue[p] }" />{{ names[p] }}'s screen</span>
            <span class="count">{{ ui.connected[p] ? `${ui.seen[p]} eaten` : "" }}</span>
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
          <button type="button" class="tab" @click="toggleTab(p)">{{ ui.connected[p] ? "Close tab" : "Open tab" }}</button>
        </div>

        <div :ref="(el) => el && (wires[p] = el as HTMLElement)" class="wire" :class="[p, { cut: !ui.connected[p] }]" aria-hidden="true" />

        <div v-if="index === 0" class="panel room">
          <div class="bar">
            <span class="title">Room <span>arena</span></span>
            <span class="count">tick {{ ui.tick }}</span>
          </div>
          <div class="glass">
            <canvas :ref="(el) => el && (canvases.room = el as HTMLCanvasElement)" aria-label="The room: the whole arena, with what each player can see marked by a circle." />
          </div>
          <ul class="seats" aria-label="Seats">
            <li v-for="s in who" :key="s">
              <i :style="{ background: hue[s] }" />{{ names[s] }}
              <span :class="{ away: !ui.connected[s] }">{{ ui.connected[s] ? `${ui.scores[s]} eaten` : "away, seat kept" }}</span>
            </li>
          </ul>
        </div>
      </template>
    </div>
    <figcaption>
      <p class="narration" aria-live="polite">{{ narration }}</p>
      <p class="caption">
        <button type="button" class="playpause" @click="ui.playing ? pause(true) : play()">{{ ui.playing ? "Pause" : "Play" }}</button>
        A tiny arena, simulated in your browser. The room runs the game ten times a second and sends
        each screen only what its player can see: <span class="key patch" /> patches out, <span class="key cmd">cmd</span> moves in.
      </p>
    </figcaption>
  </figure>
</template>

<style scoped>
.demo {
  margin: 40px 0 0;
  padding: 24px 20px 18px;
  border-radius: 20px;
  background: var(--tf-paper);
}

@media (min-width: 960px) {
  .demo {
    padding: 32px 36px 22px;
  }
}

.stage {
  display: grid;
  grid-template-columns: minmax(0, 1fr) clamp(40px, 7vw, 96px) minmax(0, 1fr) clamp(40px, 7vw, 96px) minmax(0, 1fr);
  grid-template-areas: "ada wire-ada room wire-grace grace";
  align-items: center;
}

.vertical .stage {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "ada" "wire-ada" "room" "wire-grace" "grace";
  justify-items: center;
}

.screen.ada { grid-area: ada; }
.screen.grace { grid-area: grace; }
.wire.ada { grid-area: wire-ada; }
.wire.grace { grid-area: wire-grace; }
.room { grid-area: room; }

/* ---- Panels ---- */

.panel {
  width: 100%;
  max-width: 300px;
  justify-self: center;
}

.bar {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}

.title {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 700;
  font-size: 15px;
  color: var(--tf-ink);
  white-space: nowrap;
}

.title span {
  font-weight: 500;
  color: var(--tf-slate);
}

.title i,
.seats i {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}

.count {
  font-size: 12.5px;
  color: var(--tf-slate);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.glass {
  position: relative;
  aspect-ratio: 1;
  border-radius: 14px;
  overflow: hidden;
}

.screen .glass {
  box-shadow: 0 0 0 4px var(--tf-ink);
}

.dark .screen .glass {
  box-shadow: 0 0 0 4px #000;
}

.room .glass {
  box-shadow: 0 0 0 1.5px var(--tf-wire);
}

canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.screen canvas {
  cursor: crosshair;
}

.screen canvas:focus-visible {
  outline: 3px solid var(--tf-flare);
  outline-offset: -3px;
}

.closed {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  margin: 0;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 650;
  font-size: 15px;
  color: #8793ab;
  pointer-events: none;
}

.tab {
  display: block;
  margin: 12px auto 13px;
  padding: 5px 14px;
  border-radius: 999px;
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--tf-ink);
  box-shadow: inset 0 0 0 1.5px var(--tf-line);
  transition: box-shadow 0.15s;
}

.tab:hover {
  box-shadow: inset 0 0 0 1.5px var(--tf-ink);
}

.tab:focus-visible,
.playpause:focus-visible {
  outline: 2px solid var(--tf-flare);
  outline-offset: 2px;
}

.seats {
  list-style: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: 10px 0 0;
  padding: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--tf-ink);
}

.seats li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  white-space: nowrap;
}

.seats span {
  color: var(--tf-slate);
  font-variant-numeric: tabular-nums;
}

.seats span.away {
  color: var(--tf-flare-text);
}

/* ---- Wires and frames ---- */

.wire {
  position: relative;
  align-self: center;
  width: 100%;
  height: 2px;
  /* Level with the middle of the screens, which sit between a title and what is under them. */
  margin-top: -22px;
  background: var(--tf-wire);
}

.wire.cut {
  background: repeating-linear-gradient(90deg, var(--tf-wire) 0 6px, transparent 6px 12px);
  opacity: 0.6;
}

.vertical .wire {
  width: 2px;
  height: 56px;
  margin: 2px 0 8px;
}

.vertical .tab {
  margin-bottom: 0;
}

.vertical .wire.cut {
  background: repeating-linear-gradient(180deg, var(--tf-wire) 0 6px, transparent 6px 12px);
}

.wire :deep(.pulse) {
  position: absolute;
  top: 50%;
  left: var(--at, 0%);
  transform: translate(-50%, -50%);
  pointer-events: none;
}

.vertical .wire :deep(.pulse) {
  top: var(--at, 0%);
  left: 50%;
}

.wire :deep(.pulse.patch),
.key.patch {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--tf-flare);
}

.wire :deep(.pulse.cmd),
.wire :deep(.pulse.welcome),
.key.cmd {
  padding: 1px 8px 2px;
  border-radius: 999px;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-size: 11.5px;
  font-weight: 700;
  line-height: 1.3;
  white-space: nowrap;
  background: var(--tf-ink);
  color: var(--vp-c-bg);
}

.wire :deep(.pulse.welcome) {
  background: var(--tf-flare);
  color: #fff;
}

/* ---- Caption ---- */

figcaption {
  margin-top: 20px;
  text-align: center;
}

.narration {
  margin: 0;
  min-height: 1.6em;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.5;
  font-weight: 650;
  font-size: 16px;
  color: var(--tf-ink);
}

.caption {
  margin: 6px auto 0;
  max-width: 46rem;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--tf-slate);
}

.key {
  display: inline-block;
  vertical-align: middle;
}

.playpause {
  margin-right: 8px;
  padding: 2px 12px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: var(--tf-ink);
  box-shadow: inset 0 0 0 1.5px var(--tf-line);
}

.playpause:hover {
  box-shadow: inset 0 0 0 1.5px var(--tf-ink);
}
</style>
