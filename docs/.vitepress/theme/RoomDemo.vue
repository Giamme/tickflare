<script setup lang="ts">
/**
 * A model of the counter example, run in the page: two players and the room
 * between them. Frames travel along the wires with the names they have in the
 * real protocol. Nothing here talks to a server.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";

type Who = "ada" | "grace";
type Kind = "cmd" | "state" | "ack" | "reject" | "welcome";

interface Packet {
  id: number;
  wire: Who;
  toRoom: boolean;
  kind: Kind;
  done: () => void;
}

const names: Record<Who, string> = { ada: "Ada", grace: "Grace" };
const room = reactive({ count: 0, lastBy: null as Who | null, seq: 0, flash: "" as "" | "applied" | "refused" });
const players = reactive<Record<Who, { connected: boolean; seen: number; busy: boolean; note: string; refused: boolean }>>({
  ada: { connected: true, seen: 0, busy: false, note: "", refused: false },
  grace: { connected: true, seen: 0, busy: false, note: "", refused: false },
});
const narration = ref("Press +1 as Ada or Grace.");
const packets = ref<Packet[]>([]);
const vertical = ref(false);
const root = ref<HTMLElement | null>(null);

let nextId = 1;
let reduced = false;
let touched = false;
const timers = new Set<ReturnType<typeof setTimeout>>();

function later(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      resolve();
    }, reduced ? 0 : ms);
    timers.add(timer);
  });
}

/** Sends a frame along a wire and resolves when it arrives. */
function travel(wire: Who, toRoom: boolean, kind: Kind): Promise<void> {
  if (reduced) return Promise.resolve();
  return new Promise((done) => {
    packets.value.push({ id: nextId++, wire, toRoom, kind, done });
  });
}

function arrived(packet: Packet): void {
  packets.value = packets.value.filter((p) => p !== packet);
  packet.done();
}

/** Where a frame starts and ends on its wire, as a percentage along it. */
function path(packet: Packet): [number, number] {
  // Ada's wire runs from her to the room; Grace's from the room to her.
  const fromPlayer = packet.wire === "ada" ? 0 : 100;
  const atRoom = 100 - fromPlayer;
  return packet.toRoom ? [fromPlayer, atRoom] : [atRoom, fromPlayer];
}

function animate(el: Element, packet: Packet): void {
  const [from, to] = path(packet);
  const property = vertical.value ? "top" : "left";
  const animation = (el as HTMLElement).animate(
    [{ [property]: `${from}%` }, { [property]: `${to}%` }],
    { duration: 520, easing: "cubic-bezier(.45,.05,.35,1)", fill: "forwards" },
  );
  animation.onfinish = () => arrived(packet);
  animation.oncancel = () => arrived(packet);
}

/** Starts a frame on its way as soon as it is on the wire. */
const vTravel = {
  mounted: (el: HTMLElement, binding: { value: Packet }) => animate(el, binding.value),
};

function note(who: Who, text: string, refused = false): void {
  players[who].note = text;
  players[who].refused = refused;
  const timer = setTimeout(() => {
    timers.delete(timer);
    if (players[who].note === text) {
      players[who].note = "";
      players[who].refused = false;
    }
  }, 2600);
  timers.add(timer);
}

async function press(who: Who, byHand = true): Promise<void> {
  if (byHand) touched = true;
  const player = players[who];
  if (!player.connected || player.busy) return;
  player.busy = true;
  await travel(who, true, "cmd");

  if (room.lastBy === who) {
    // onCommand called reject(): the room rolls back and answers only the sender.
    room.flash = "refused";
    narration.value = `Refused ${names[who]}'s +1: wait_for_someone_else. Nothing changed.`;
    await travel(who, false, "reject");
    if (players[who].connected) note(who, "Refused: wait_for_someone_else", true);
  } else {
    room.count += 1;
    room.lastBy = who;
    room.seq += 1;
    room.flash = "applied";
    narration.value = `Applied ${names[who]}'s +1. Saved, then sent to everyone.`;
    const count = room.count;
    const online = (Object.keys(players) as Who[]).filter((p) => players[p].connected);
    await Promise.all(
      online.map(async (p) => {
        await travel(p, false, "state");
        if (players[p].connected) players[p].seen = Math.max(players[p].seen, count);
      }),
    );
    if (players[who].connected) await travel(who, false, "ack");
  }
  player.busy = false;
  await later(300);
  room.flash = "";
}

async function toggle(who: Who): Promise<void> {
  touched = true;
  const player = players[who];
  if (player.connected) {
    player.connected = false;
    player.busy = false;
    packets.value.filter((p) => p.wire === who).forEach((p) => arrived(p));
    narration.value = `${names[who]} closed the tab. The room keeps the seat.`;
    return;
  }
  player.connected = true;
  player.busy = true;
  narration.value = `${names[who]} is back. The welcome frame carries the current state.`;
  await travel(who, false, "welcome");
  player.seen = room.count;
  player.busy = false;
}

/** Plays a short game once, the first time the demo comes into view. */
async function autoplay(): Promise<void> {
  // Two moves, then one the room refuses: Grace may not go twice in a row.
  const script: Who[] = ["ada", "grace", "grace"];
  await later(600);
  for (const who of script) {
    if (touched) return;
    await press(who, false);
    await later(450);
  }
  if (!touched) narration.value = "Your turn: press +1, press it twice, or close a tab.";
}

const tickAngle = computed(() => (room.seq % 24) * 15);

let observer: IntersectionObserver | undefined;
let media: MediaQueryList | undefined;
const onMedia = () => (vertical.value = media?.matches ?? false);

onMounted(() => {
  reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  media = window.matchMedia("(max-width: 760px)");
  onMedia();
  media.addEventListener("change", onMedia);
  if (reduced || !root.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer?.disconnect();
        void autoplay();
      }
    },
    { threshold: 0.5 },
  );
  observer.observe(root.value);
});

onBeforeUnmount(() => {
  observer?.disconnect();
  media?.removeEventListener("change", onMedia);
  for (const timer of timers) clearTimeout(timer);
});

const who: Who[] = ["ada", "grace"];
</script>

<template>
  <figure ref="root" class="demo" :class="{ vertical }">
    <div class="stage">
      <template v-for="(p, index) in who" :key="p">
        <div class="player" :class="[p, { away: !players[p].connected, refused: players[p].refused }]">
          <div class="player-name">{{ names[p] }}</div>
          <div class="player-count" aria-hidden="true">{{ players[p].connected ? players[p].seen : "–" }}</div>
          <div class="player-note" :class="{ refused: players[p].refused }">
            {{ players[p].connected ? players[p].note || "Connected" : "Tab closed" }}
          </div>
          <div class="player-actions">
            <button
              type="button"
              class="plus"
              :disabled="!players[p].connected || players[p].busy"
              :aria-label="`Press +1 as ${names[p]}`"
              @click="press(p)"
            >
              +1
            </button>
            <button type="button" class="tab" @click="toggle(p)">
              {{ players[p].connected ? "Close tab" : "Open tab" }}
            </button>
          </div>
        </div>

        <div class="wire" :class="[p, { cut: !players[p].connected }]" aria-hidden="true">
          <span
            v-for="packet in packets.filter((x) => x.wire === p)"
            :key="packet.id"
            v-travel="packet"
            class="packet"
            :class="packet.kind"
          >
            {{ packet.kind }}
          </span>
        </div>

        <div v-if="index === 0" class="room" :class="room.flash">
          <svg class="dial" viewBox="-60 -60 120 120" aria-hidden="true">
            <circle r="52" class="dial-face" />
            <line
              v-for="n in 24"
              :key="n"
              class="dial-tick"
              x1="0"
              y1="-52"
              x2="0"
              :y2="n % 6 === 1 ? -44 : -47"
              :transform="`rotate(${(n - 1) * 15})`"
            />
            <g class="dial-hand" :style="{ transform: `rotate(${tickAngle}deg)` }">
              <line x1="0" y1="-54" x2="0" y2="-40" />
            </g>
            <text class="dial-count" y="9">{{ room.count }}</text>
            <text class="dial-seq" y="28">seq {{ room.seq }}</text>
          </svg>
          <div class="room-name">Room <span>lobby</span></div>
          <ul class="seats" aria-label="Seats">
            <li v-for="s in who" :key="s" :class="{ away: !players[s].connected }">
              {{ names[s] }} <span>{{ players[s].connected ? "seated" : "away, seat kept" }}</span>
            </li>
          </ul>
        </div>
      </template>
    </div>
    <figcaption>
      <p class="narration" aria-live="polite">{{ narration }}</p>
      <p class="caption">
        The counter from the example below, simulated in your browser. Frames are named as on the real wire.
      </p>
    </figcaption>
  </figure>
</template>

<style scoped>
.demo {
  margin: 40px 0 0;
  padding: 28px 24px 20px;
  border-radius: 20px;
  background: var(--tf-paper);
}

@media (min-width: 960px) {
  .demo {
    padding: 36px 40px 24px;
  }
}

.stage {
  display: grid;
  grid-template-columns: minmax(150px, 1fr) minmax(80px, 1.2fr) auto minmax(80px, 1.2fr) minmax(150px, 1fr);
  grid-template-areas: "ada wire-ada room wire-grace grace";
  align-items: center;
}

.vertical .stage {
  grid-template-columns: minmax(0, 1fr);
  grid-template-areas: "ada" "wire-ada" "room" "wire-grace" "grace";
  justify-items: center;
}

.player.ada { grid-area: ada; }
.player.grace { grid-area: grace; }
.wire.ada { grid-area: wire-ada; }
.wire.grace { grid-area: wire-grace; }
.room { grid-area: room; }

/* ---- Players ---- */

.player {
  width: 100%;
  max-width: 220px;
  padding: 16px 16px 14px;
  border-radius: 14px;
  background: var(--vp-c-bg);
  box-shadow: 0 0 0 1px var(--tf-line);
  transition: box-shadow 0.2s, opacity 0.2s;
}

.player.away {
  opacity: 0.6;
}

.player.refused {
  box-shadow: 0 0 0 2px var(--tf-flare);
  animation: nudge 0.35s;
}

@keyframes nudge {
  25% { transform: translateX(-4px); }
  75% { transform: translateX(4px); }
}

.player-name {
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 700;
  font-size: 16px;
  color: var(--tf-ink);
}

.player-count {
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 1;
  font-weight: 800;
  font-size: 44px;
  line-height: 1.1;
  color: var(--tf-ink);
  font-variant-numeric: tabular-nums;
}

.player-note {
  min-height: 2.6em;
  font-size: 13px;
  line-height: 1.3;
  color: var(--tf-slate);
}

.player-note.refused {
  color: var(--tf-flare-text);
  font-weight: 600;
}

.player-actions {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.player-actions button {
  padding: 6px 14px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.4;
  transition: background-color 0.15s, box-shadow 0.15s;
}

.plus {
  background: var(--vp-button-brand-bg);
  color: #fff;
}

.plus:hover:not(:disabled) {
  background: var(--vp-button-brand-hover-bg);
}

.plus:disabled {
  background: var(--tf-line);
  color: var(--tf-slate);
  cursor: default;
}

.tab {
  color: var(--tf-ink);
  box-shadow: inset 0 0 0 1.5px var(--tf-line);
}

.tab:hover {
  box-shadow: inset 0 0 0 1.5px var(--tf-ink);
}

.player-actions button:focus-visible {
  outline: 2px solid var(--tf-flare);
  outline-offset: 2px;
}

/* ---- Wires and frames ---- */

.wire {
  position: relative;
  align-self: center;
  width: 100%;
  height: 2px;
  background: var(--tf-wire);
}

.wire.cut {
  background: repeating-linear-gradient(90deg, var(--tf-wire) 0 6px, transparent 6px 12px);
  opacity: 0.6;
}

.vertical .wire {
  width: 2px;
  height: 72px;
  margin: 4px 0;
}

.vertical .wire.cut {
  background: repeating-linear-gradient(180deg, var(--tf-wire) 0 6px, transparent 6px 12px);
}

.packet {
  position: absolute;
  top: 50%;
  left: 0;
  transform: translate(-50%, -50%);
  padding: 2px 9px 3px;
  border-radius: 999px;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
}

.vertical .packet {
  top: 0;
  left: 50%;
}

.packet.cmd {
  background: var(--tf-ink);
  color: var(--vp-c-bg);
}

.packet.state,
.packet.welcome {
  background: var(--tf-flare);
  color: #fff;
}

.packet.ack {
  background: var(--vp-c-bg);
  color: var(--tf-ink);
  box-shadow: inset 0 0 0 1.5px var(--tf-ink);
}

.packet.reject {
  background: var(--vp-c-bg);
  color: var(--tf-flare-text);
  box-shadow: inset 0 0 0 1.5px var(--tf-flare);
}

/* ---- The room ---- */

.room {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 8px;
}

.dial {
  width: 148px;
  height: 148px;
  overflow: visible;
}

.dial-face {
  fill: var(--vp-c-bg);
  stroke: var(--tf-line);
  stroke-width: 1.5;
  transition: stroke 0.25s;
}

.applied .dial-face {
  stroke: var(--tf-flare);
  stroke-width: 2.5;
}

.refused .dial-face {
  stroke: var(--tf-ink);
  stroke-dasharray: 4 4;
}

.dial-tick {
  stroke: var(--tf-wire);
  stroke-width: 1.5;
  stroke-linecap: round;
}

.dial-hand {
  transition: transform 0.45s cubic-bezier(0.3, 1.4, 0.5, 1);
}

.dial-hand line {
  stroke: var(--tf-flare);
  stroke-width: 3.5;
  stroke-linecap: round;
}

.dial-count {
  text-anchor: middle;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 1;
  font-weight: 800;
  font-size: 34px;
  fill: var(--tf-ink);
}

.dial-seq {
  text-anchor: middle;
  font-size: 10px;
  fill: var(--tf-slate);
}

.room-name {
  margin-top: 6px;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 700;
  font-size: 15px;
  color: var(--tf-ink);
}

.room-name span {
  font-weight: 500;
  color: var(--tf-slate);
}

.seats {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--tf-ink);
  text-align: center;
}

.seats li span {
  color: var(--tf-slate);
}

.seats li.away span {
  color: var(--tf-flare-text);
}

/* ---- Caption ---- */

figcaption {
  margin-top: 24px;
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
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--tf-slate);
}

@media (prefers-reduced-motion: reduce) {
  .player.refused {
    animation: none;
  }
  .dial-hand,
  .dial-face {
    transition: none;
  }
}
</style>
