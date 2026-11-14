<script setup lang="ts">
/**
 * What a game costs a month on Cloudflare, from the visitor's own numbers:
 * matches a day, players, length and how much they send. It shows the same
 * game in each mode, where the money goes, and what the usual
 * alternatives would charge.
 */
import { computed, reactive, useId } from "vue";
import HelpTip from "./HelpTip.vue";
import {
  PRICES_AS_OF,
  breakEven,
  cheaperUpTo,
  dollars,
  estimate,
  presets,
  runsNames,
  server,
  type Game,
  type Runs,
} from "./costs";

const props = defineProps<{ start?: string }>();

const game = reactive<Game>({ ...(presets.find((preset) => preset.id === props.start) ?? presets[0]!).game });

/** A prefix for the ids that tie each label to its input: the estimator is on more than one page. */
const uid = useId();

const fields: {
  key: "matchesPerDay" | "playersPerMatch" | "matchMinutes" | "messagesPerMinute";
  label: string;
  hint: string;
  help: string;
  min: number;
  max: number;
}[] = [
  {
    key: "matchesPerDay",
    label: "Matches a day",
    hint: "Sessions started",
    help: "How many matches, or play sessions, start on an average day. Each one is a room, and everything on the bill grows with this number.",
    min: 0,
    max: 10_000_000,
  },
  {
    key: "playersPerMatch",
    label: "Players in a match",
    hint: "In one room",
    help: "How many players share one room. More players send more messages into it, but a room costs the same to keep awake whoever is in it.",
    min: 1,
    max: 1000,
  },
  {
    key: "matchMinutes",
    label: "Minutes in a match",
    hint: "Start to end",
    help: "How long a match lasts, from the first player in to the last one out. A room that runs is billed for every second of it. A room that sleeps is billed for its moves, however long the match takes.",
    min: 1,
    max: 43_200,
  },
  {
    key: "messagesPerMinute",
    label: "Messages a minute",
    hint: "From each player",
    help: "What one player sends the room in a minute: moves, orders, inputs. In a room that sleeps, each one wakes it and is saved, so this is most of the bill. In a room that runs they are close to free.",
    min: 0,
    max: 6000,
  },
];

/** What the settings under "More settings" are for. */
const more = {
  saveEverySeconds:
    "How often a room that runs writes its state to storage: saveIntervalMs, five seconds unless you change it. Each save is one row. Saving less often costs less and loses more if the room is restarted. Rooms that sleep save each move instead.",
  timerPerMove:
    "Whether each move also sets a timer, as a turn clock or a deadline to move does. The timer is a second row written with the move, so it doubles what a move costs in a room that sleeps. Rooms that run are not affected.",
  peakFactor:
    "How much busier your busiest hour is than an average one: 3 means three times as many players online. Cloudflare bills what is used, so its figure does not change. Rented servers are sized for the peak, so theirs does.",
  playersPerServer:
    "How many players one rented server carries at once, for the comparison with servers. It depends on your game and the machine; a few hundred to a few thousand is usual. The Cloudflare figure does not depend on it.",
};
const runs: { id: Runs; what: string }[] = [
  { id: "event", what: "Rooms sleep between moves" },
  { id: "sync", what: "Rooms run for the whole match" },
  { id: "lockstep", what: "Rooms run, and record the turns" },
  { id: "asked", what: "Rooms sleep between turns" },
];

/** Whatever is typed, the sums get a sensible number. */
const clean = computed<Game>(() => {
  const within = (value: unknown, min: number, max: number, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  const tidy = { ...game };
  for (const field of fields) tidy[field.key] = within(game[field.key], field.min, field.max, field.min);
  tidy.timerPerMove = Boolean(game.timerPerMove);
  tidy.saveEverySeconds = within(game.saveEverySeconds, 1, 3600, 5);
  tidy.peakFactor = within(game.peakFactor, 1, 50, 3);
  tidy.playersPerServer = within(game.playersPerServer, 1, 100_000, 750);
  return tidy;
});

const result = computed(() => estimate(clean.value));
const inEach = computed(() => runs.map((run) => ({ ...run, total: estimate({ ...clean.value, runs: run.id }).bill.total })));
const chosen = computed(() => presets.find((preset) => (Object.keys(preset.game) as (keyof Game)[]).every((key) => preset.game[key] === clean.value[key])));

const parts = computed(() => {
  const { bill } = result.value;
  return [
    { name: "The plan", amount: bill.base, kind: "base" },
    { name: "Rooms awake", amount: bill.awake, kind: "awake" },
    { name: "Saving", amount: bill.storage, kind: "storage" },
    { name: "Messages", amount: bill.messages, kind: "messages" },
  ];
});

const scale = computed(() => Math.max(...result.value.options.map((option) => option.high ?? option.low), 1));
const width = (amount: number) => `${Math.max(0.6, (amount / scale.value) * 100)}%`;
const count = (n: number) => (n >= 100 ? Math.round(n).toLocaleString("en-US") : n >= 10 ? n.toFixed(0) : Number(n.toFixed(1)).toString());

/** How far the game can grow before a rented server costs less in rent. */
const edge = computed(() => {
  const total = result.value.bill.total;
  const about = (matches: number) => Number(matches.toPrecision(2)).toLocaleString("en-US");
  const cheapest = cheaperUpTo(clean.value, server.low);
  const typical = cheaperUpTo(clean.value, server.high);
  if (typical === null) return "At these settings it stays under the price of a rented server however many matches are played.";
  if (total <= server.low && cheapest !== null) {
    return `Less than the cheapest server we found (${dollars(server.low)} a month) up to about ${about(cheapest)} matches a day, and less than a typical one (${dollars(server.high)}) up to about ${about(typical)}.`;
  }
  if (total <= server.high) {
    return `More than the cheapest server we found (${dollars(server.low)} a month) at this size, and less than a typical one (${dollars(server.high)}) up to about ${about(typical)} matches a day.`;
  }
  return `At this size a rented server costs less in rent: Cloudflare is the cheaper of the two up to about ${about(typical)} matches a day. What it adds beyond that is nothing to run, and rooms near every player.`;
});

/** Where the money goes for these numbers, and what would change it. */
const insight = computed(() => {
  const { bill, roomMessagesAMinute, roomsAwake } = result.value;
  const { runs: mode } = clean.value;
  const beyond = bill.total - bill.base;
  const inRoom = `${count(roomMessagesAMinute)} ${roomMessagesAMinute === 1 ? "message" : "messages"} a minute`;
  const breakEvenMovesAMinute = breakEven(clean.value);
  if (beyond < 0.5) return "All of this fits inside what the plan includes, so the bill is the plan itself.";

  if (mode === "event") {
    return roomMessagesAMinute > breakEvenMovesAMinute
      ? `A sleeping room saves every move, and a room here gets ${inRoom}. Above about ${breakEvenMovesAMinute} a minute, a room that ticks and saves on a schedule costs less.`
      : `Nearly all of this is saving each move as it is made. The rooms are asleep the rest of the time.`;
  }
  if (mode === "lockstep" && bill.storage > bill.awake) {
    const lighter = estimate({ ...clean.value, messagesPerMinute: clean.value.messagesPerMinute / 3 }).bill.total;
    return `Most of this is the recording: every turn with an order in it is saved. Orders that say more and come a third as often would bring it to ${dollars(lighter)}.`;
  }
  const asleep = estimate({ ...clean.value, runs: "event" }).bill.total;
  if (mode === "lockstep") {
    const asleep = estimate({ ...clean.value, runs: "asked" }).bill.total;
    return `Most of this is ${count(roomsAwake)} rooms awake around the clock, on average: a lockstep room keeps time for as long as the match lasts. Let the players' clients keep time instead and it sleeps between turns, for ${dollars(asleep)}.`;
  }
  if (mode === "asked") {
    const share = Math.round((result.value.secondsAwake / (clean.value.matchMinutes * 60)) * 100);
    return `The rooms are awake only to answer: about ${share}% of a match here. The rest is requests for turns, ten a second from one player's client, and they are cheap.`;
  }
  if (roomMessagesAMinute < breakEvenMovesAMinute && asleep < bill.total * 0.8) {
    return `Most of this is ${count(roomsAwake)} rooms awake around the clock, on average. A room here gets only ${inRoom}: a game that can run on moves and timers, with no tick, would cost ${dollars(asleep)}.`;
  }
  return `Most of this is ${count(roomsAwake)} rooms awake around the clock, on average. The tick rate and how hard the simulation works do not change it; how long matches last does.`;
});
</script>

<template>
  <div class="estimator">
    <p class="start">Start from an example, or type your own numbers. An example fills in every setting, the ones under "More settings" too.</p>
    <div class="pick" role="group" aria-label="Examples">
      <button v-for="preset in presets" :key="preset.id" type="button" :aria-pressed="preset === chosen" @click="Object.assign(game, preset.game)">
        {{ preset.name }}
      </button>
    </div>
    <p class="about">{{ chosen ? chosen.about : "Your own numbers." }}</p>

    <div class="fields">
      <div v-for="field in fields" :key="field.key" class="field">
        <span class="head">
          <label class="label" :for="`${uid}-${field.key}`">{{ field.label }}</label>
          <HelpTip :about="field.label">{{ field.help }}</HelpTip>
        </span>
        <input :id="`${uid}-${field.key}`" v-model.number="game[field.key]" type="number" inputmode="decimal" :min="field.min" :max="field.max" step="any" />
        <span class="hint">{{ field.hint }}</span>
      </div>
    </div>

    <div class="runs" role="group" aria-label="How the rooms run">
      <button v-for="run in inEach" :key="run.id" type="button" :aria-pressed="run.id === game.runs" @click="game.runs = run.id">
        <span class="mode">{{ runsNames[run.id] }}</span>
        <span class="what">{{ run.what }}</span>
        <span class="figure">{{ dollars(run.total) }} <small>a month</small></span>
      </button>
    </div>

    <div class="result" aria-live="polite">
      <p class="total">
        <strong>{{ dollars(result.bill.total) }}</strong> a month on Cloudflare
        <span v-if="result.free" class="free">or nothing: a day of this fits the free plan</span>
      </p>
      <p class="per">
        {{ dollars(result.perMatch * 1000) }} for a thousand more matches, {{ dollars(result.perPlayerHour * 1000) }} for a thousand
        player-hours. {{ count(result.averageOnline) }} players online on average, {{ result.peakOnline.toLocaleString("en-US") }} at the peak.
      </p>
      <div class="split" aria-hidden="true">
        <span v-for="part in parts" :key="part.kind" :class="part.kind" :style="{ flexGrow: part.amount }" />
      </div>
      <ul class="parts">
        <li v-for="part in parts" :key="part.kind"><i :class="part.kind" />{{ part.name }} <b>{{ dollars(part.amount) }}</b></li>
      </ul>
      <p class="insight">{{ insight }}</p>
      <p class="edge">{{ edge }}</p>
    </div>

    <ul class="options" aria-label="The same game hosted other ways">
      <li v-for="option in result.options" :key="option.name" :class="{ ours: option.ours }">
        <div class="line">
          <span class="name">{{ option.name }}</span>
          <span class="price">
            {{ option.prefix ? `${option.prefix} ` : "" }}{{ dollars(option.low) }}{{ option.high ? ` to ${dollars(option.high)}` : "" }}
            <small>a month</small>
          </span>
        </div>
        <div class="track" aria-hidden="true">
          <span v-if="option.high" class="bar range" :style="{ width: width(option.high) }" />
          <span class="bar" :style="{ width: width(option.low) }" />
        </div>
        <p class="note">{{ option.note }}</p>
      </li>
    </ul>

    <details class="assume">
      <summary>More settings</summary>
      <div class="fields">
        <div class="field">
          <span class="head">
            <label class="label" :for="`${uid}-save`">Seconds between saves</label>
            <HelpTip about="Seconds between saves">{{ more.saveEverySeconds }}</HelpTip>
          </span>
          <input :id="`${uid}-save`" v-model.number="game.saveEverySeconds" type="number" inputmode="decimal" min="1" max="3600" step="any" />
          <span class="hint">Rooms that tick: saveIntervalMs</span>
        </div>
        <div class="field check">
          <span class="head">
            <label class="label" :for="`${uid}-timer`">A timer on every move</label>
            <HelpTip about="A timer on every move">{{ more.timerPerMove }}</HelpTip>
          </span>
          <label class="box"><input :id="`${uid}-timer`" v-model="game.timerPerMove" type="checkbox" /> {{ game.timerPerMove ? "Yes" : "No" }}</label>
          <span class="hint">Rooms that sleep: a turn clock</span>
        </div>
        <div class="field">
          <span class="head">
            <label class="label" :for="`${uid}-peak`">Peak over average</label>
            <HelpTip about="Peak over average">{{ more.peakFactor }}</HelpTip>
          </span>
          <input :id="`${uid}-peak`" v-model.number="game.peakFactor" type="number" inputmode="decimal" min="1" max="50" step="any" />
          <span class="hint">Servers are sized for the peak</span>
        </div>
        <div class="field">
          <span class="head">
            <label class="label" :for="`${uid}-server`">Players a server holds</label>
            <HelpTip about="Players a server holds">{{ more.playersPerServer }}</HelpTip>
          </span>
          <input :id="`${uid}-server`" v-model.number="game.playersPerServer" type="number" inputmode="numeric" min="1" max="100000" step="any" />
          <span class="hint">It depends on your game</span>
        </div>
      </div>
    </details>

    <p class="small">
      Estimates from published list prices, {{ PRICES_AS_OF }}. The Cloudflare figure is the whole bill; the others are
      the server or the service alone.
    </p>
  </div>
</template>

<style scoped>
.estimator {
  margin-top: 8px;
  padding: 24px 20px 20px;
  border-radius: 16px;
  background: var(--tf-paper);
}

@media (min-width: 760px) {
  .estimator {
    padding: 28px 32px 24px;
  }
}

button:focus-visible,
input:focus-visible,
summary:focus-visible {
  outline: 2px solid var(--tf-flare);
  outline-offset: 2px;
}

/* ---- Examples to start from ---- */

.start {
  margin: 0 0 12px;
  font-size: 14.5px;
  line-height: 1.5;
  color: var(--tf-slate);
}

.pick {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.pick button {
  padding: 6px 16px;
  border-radius: 999px;
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--tf-ink);
  box-shadow: inset 0 0 0 1.5px var(--tf-line);
  transition: background-color 0.15s, box-shadow 0.15s;
}

.pick button:hover {
  box-shadow: inset 0 0 0 1.5px var(--tf-ink);
}

.pick button[aria-pressed="true"] {
  background: var(--tf-ink);
  color: var(--vp-c-bg);
  box-shadow: none;
}

.about {
  margin: 12px 0 0;
  min-height: 1.55em;
  color: var(--tf-slate);
  line-height: 1.55;
}

/* ---- The numbers ---- */

.fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0 16px;
  margin-top: 16px;
}

.field {
  margin-bottom: 14px;
}

@media (min-width: 900px) {
  .fields {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }

  .assume .fields {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

/*
 * A field is what its help text is placed against: the bubble opens above the label. Its three
 * parts sit on the rows of the grid of fields, so that the inputs of a row line up whichever
 * label next to them runs to two lines.
 */
.field {
  position: relative;
  display: grid;
  grid-row: span 3;
  grid-template-rows: subgrid;
  row-gap: 4px;
  min-width: 0;
}

.head {
  display: flex;
  align-items: end;
  gap: 6px;
  min-height: 22px;
}

.head :deep(.help) {
  margin-bottom: 1px;
}

.label {
  min-width: 0;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.3;
  color: var(--tf-ink);
}

/* In the right-hand column the bubble grows leftwards, so that it stays on the page. */
.field:nth-child(2n) :deep(.tip) {
  left: auto;
  right: 0;
}

@media (min-width: 900px) {
  .field:nth-child(2n) :deep(.tip) {
    left: 0;
    right: auto;
  }

  .field:nth-child(4n) :deep(.tip),
  .field:nth-child(4n - 1) :deep(.tip) {
    left: auto;
    right: 0;
  }
}

input {
  width: 100%;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--vp-c-bg);
  box-shadow: inset 0 0 0 1.5px var(--tf-line);
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-size: 18px;
  font-weight: 650;
  color: var(--tf-ink);
  font-variant-numeric: tabular-nums;
}

input:hover {
  box-shadow: inset 0 0 0 1.5px var(--tf-wire);
}

.box {
  display: flex;
  align-items: center;
  cursor: pointer;
  gap: 10px;
  min-height: 43px;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-size: 18px;
  font-weight: 650;
  color: var(--tf-ink);
}

.box input {
  width: 22px;
  height: 22px;
  padding: 0;
  accent-color: var(--tf-ink);
  box-shadow: none;
}

.hint {
  font-size: 12.5px;
  line-height: 1.4;
  color: var(--tf-slate);
}

/* ---- The same game in each mode ---- */

.runs {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 8px;
  margin-top: 20px;
}

@media (min-width: 760px) {
  .runs {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.runs button {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0 12px;
  align-items: baseline;
  padding: 10px 14px;
  border-radius: 12px;
  text-align: left;
  color: var(--tf-ink);
  box-shadow: inset 0 0 0 1.5px var(--tf-line);
  transition: background-color 0.15s, box-shadow 0.15s;
}

.runs button:hover {
  box-shadow: inset 0 0 0 1.5px var(--tf-ink);
}

.runs button[aria-pressed="true"] {
  background: var(--vp-c-bg);
  box-shadow: inset 0 0 0 2px var(--tf-ink);
}

.mode {
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.5;
  font-weight: 720;
  font-size: 15.5px;
}

.what {
  grid-column: 1;
  font-size: 13px;
  line-height: 1.4;
  color: var(--tf-slate);
}

.figure {
  grid-column: 2;
  grid-row: 1 / span 2;
  align-self: center;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 720;
  font-size: 17px;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.figure small,
.price small {
  font-family: var(--vp-font-family-base);
  font-weight: 400;
  font-size: 13px;
  color: var(--tf-slate);
}

/* ---- The answer ---- */

.result {
  margin-top: 22px;
  padding-top: 18px;
  border-top: 2px solid var(--tf-ink);
}

.total {
  margin: 0;
  font-size: 17px;
  line-height: 1.3;
  color: var(--tf-ink);
}

.total strong {
  margin-right: 4px;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 820;
  font-size: clamp(34px, 5vw, 46px);
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.free {
  display: block;
  margin-top: 2px;
  font-size: 14.5px;
  color: var(--tf-flare-text);
  font-weight: 600;
}

.per {
  margin: 8px 0 0;
  max-width: 46rem;
  line-height: 1.55;
  color: var(--tf-slate);
}

.split {
  display: flex;
  gap: 2px;
  height: 10px;
  margin-top: 14px;
}

.split span {
  flex: 0 0 0;
  min-width: 0;
  border-radius: 3px;
  transition: flex-grow 0.35s cubic-bezier(0.3, 0.9, 0.4, 1);
}

.base {
  background: var(--tf-wire);
}

.awake {
  background: var(--tf-flare);
}

.storage {
  background: var(--tf-ink);
}

.messages {
  background: var(--tf-slate);
}

.parts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 20px;
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  font-size: 14px;
  color: var(--tf-slate);
}

.parts li {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 0;
}

.parts i {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.parts b {
  font-weight: 650;
  color: var(--tf-ink);
  font-variant-numeric: tabular-nums;
}

.insight {
  margin: 14px 0 0;
  max-width: 46rem;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.4;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--tf-ink);
}

.edge {
  margin: 8px 0 0;
  max-width: 46rem;
  line-height: 1.55;
  color: var(--tf-slate);
}

/* ---- Other ways to host it ---- */

.options {
  list-style: none;
  margin: 20px 0 0;
  padding: 0;
}

.options li {
  margin: 0;
  padding: 12px 0;
  border-top: 1px solid var(--tf-line);
}

.line {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.name {
  font-weight: 600;
  color: var(--tf-ink);
}

.ours .name {
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.5;
  font-weight: 720;
}

.price {
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 720;
  font-size: 17px;
  color: var(--tf-ink);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.track {
  position: relative;
  height: 8px;
  margin: 8px 0 6px;
}

.bar {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 4px;
  background: var(--tf-wire);
  transition: width 0.35s cubic-bezier(0.3, 0.9, 0.4, 1);
}

.bar.range {
  opacity: 0.35;
}

.ours .bar {
  background: var(--tf-flare);
}

.note {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.5;
  color: var(--tf-slate);
}

.assume {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px solid var(--tf-line);
}

.assume summary {
  cursor: pointer;
  font-size: 14px;
  font-weight: 600;
  color: var(--tf-ink);
}

.small {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--tf-slate);
}

@media (prefers-reduced-motion: reduce) {
  .bar,
  .split span {
    transition: none;
  }
}
</style>
