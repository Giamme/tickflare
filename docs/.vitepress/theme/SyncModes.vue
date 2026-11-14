<script setup lang="ts">
/**
 * One second of what a player receives in each mode, to scale. Flare marks
 * state on the wire; ink marks inputs; grey marks an empty turn.
 */
import { withBase } from "vitepress";
import { mode as shown, type Mode } from "./demo/shared";

interface Mark {
  at: number; // seconds into the strip
  height: number; // 0..1, how much the frame carries
  kind: "state" | "input" | "empty";
}

const W = 600;
const H = 64;
const BASE = 48;

function x(at: number): number {
  return 8 + at * (W - 16);
}

/** Switches the demo at the top of the page to this mode and goes there. */
function watch(id: Mode): void {
  shown.value = id;
  const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelector("#demo")?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "center" });
}

const modes: {
  id: Mode;
  name: string;
  what: string;
  suits: string;
  link: string;
  marks: Mark[];
  sleeps?: [number, number];
  legend: string;
}[] = [
  {
    id: "event",
    name: "Event mode",
    what: "The room wakes when something happens, runs your hook, sends everyone what changed in their view and goes back to sleep.",
    suits: "Turn-based, cards, board games, anything played over days.",
    link: "/guide/rooms",
    marks: [
      { at: 0.18, height: 0.4, kind: "state" },
      { at: 0.71, height: 0.4, kind: "state" },
    ],
    sleeps: [0.2, 0.69],
    legend: "Two moves: two small patches, and the room asleep in between",
  },
  {
    id: "sync",
    name: "State sync",
    what: "The room runs onTick at a fixed rate and sends each player a patch with only what changed in their view.",
    suits: "Action, co-op, .io games, fog of war.",
    link: "/guide/state-sync",
    marks: Array.from({ length: 20 }, (_, n) => ({
      at: n / 20 + 0.025,
      height: 0.25 + 0.2 * Math.abs(Math.sin(n * 1.7)),
      kind: "state" as const,
    })),
    legend: "20 ticks a second: 20 small patches",
  },
  {
    id: "lockstep",
    name: "Lockstep",
    what: "The room orders everyone's inputs into turns; every client runs the same deterministic simulation over them.",
    suits: "Real-time strategy, thousands of units, replays for free.",
    link: "/guide/lockstep",
    marks: Array.from({ length: 10 }, (_, n) => ({
      at: n / 10 + 0.05,
      height: n === 2 || n === 7 ? 0.35 : 0.12,
      kind: n === 2 || n === 7 ? ("input" as const) : ("empty" as const),
    })),
    legend: "10 turns a second: two carry an order, the rest are empty",
  },
];
</script>

<template>
  <div class="modes">
    <div v-for="mode in modes" :key="mode.name" class="mode">
      <div class="mode-text">
        <h3>{{ mode.name }}</h3>
        <p>{{ mode.what }}</p>
        <p class="suits">{{ mode.suits }}</p>
        <p class="go">
          <button type="button" @click="watch(mode.id)">Watch it run</button>
          <a :href="withBase(mode.link)">Read the guide</a>
        </p>
      </div>
      <figure class="mode-strip">
        <svg :viewBox="`0 0 ${W} ${H}`" role="img" :aria-label="mode.legend">
          <rect
            v-if="mode.sleeps"
            class="sleep"
            :x="x(mode.sleeps[0])"
            y="10"
            :width="x(mode.sleeps[1]) - x(mode.sleeps[0])"
            :height="BASE - 10"
            rx="6"
          />
          <text v-if="mode.sleeps" class="sleep-label" :x="(x(mode.sleeps[0]) + x(mode.sleeps[1])) / 2" y="34">asleep</text>
          <line class="axis" :x1="x(0)" :y1="BASE" :x2="x(1)" :y2="BASE" />
          <rect
            v-for="(mark, n) in mode.marks"
            :key="n"
            :class="['mark', mark.kind]"
            :x="x(mark.at) - 3"
            :y="BASE - 4 - mark.height * 34"
            width="6"
            :height="mark.height * 34"
            rx="2"
          />
          <text class="tick-label" :x="x(0)" :y="H - 2">0 s</text>
          <text class="tick-label end" :x="x(1)" :y="H - 2">1 s</text>
        </svg>
        <figcaption>{{ mode.legend }}</figcaption>
      </figure>
    </div>
  </div>
</template>

<style scoped>
.modes {
  margin-top: 8px;
}

.mode {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 12px 48px;
  padding: 28px 0;
  border-top: 1px solid var(--tf-line);
}

.mode:last-child {
  border-bottom: 1px solid var(--tf-line);
}

@media (min-width: 900px) {
  .mode {
    grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    align-items: center;
  }
}

.mode-text h3 {
  margin: 0 0 6px;
  font-size: 20px;
  font-weight: 720;
}

.mode-text p {
  margin: 0 0 6px;
  line-height: 1.55;
}

.mode-text .suits {
  color: var(--tf-slate);
  font-size: 14.5px;
}

.mode-text .go {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
  margin: 10px 0 0;
  font-size: 14.5px;
}

.go button {
  padding: 4px 13px;
  border-radius: 999px;
  font-weight: 600;
  color: var(--tf-ink);
  box-shadow: inset 0 0 0 1.5px var(--tf-line);
  transition: box-shadow 0.15s;
}

.go button:hover {
  box-shadow: inset 0 0 0 1.5px var(--tf-ink);
}

.go button:focus-visible {
  outline: 2px solid var(--tf-flare);
  outline-offset: 2px;
}

.mode-strip {
  margin: 0;
}

.mode-strip svg {
  display: block;
  width: 100%;
  height: auto;
}

.mode-strip figcaption {
  margin-top: 6px;
  font-size: 13px;
  color: var(--tf-slate);
}

.axis {
  stroke: var(--tf-wire);
  stroke-width: 1.5;
}

.mark.state {
  fill: var(--tf-flare);
}

.mark.input {
  fill: var(--tf-ink);
}

.mark.empty {
  fill: var(--tf-wire);
}

.sleep {
  fill: var(--tf-paper);
}

.sleep-label {
  text-anchor: middle;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-size: 13px;
  font-weight: 600;
  fill: var(--tf-slate);
}

.tick-label {
  font-size: 11px;
  fill: var(--tf-slate);
}

.tick-label.end {
  text-anchor: end;
}
</style>
