<script setup lang="ts">
/** Monthly cost of three kinds of game, on Cloudflare and on the usual alternatives. */
import { computed, ref } from "vue";
import { PRICES_AS_OF, dollars, scenarios } from "./costs";

const chosen = ref(scenarios[0]!.id);
const scenario = computed(() => scenarios.find((s) => s.id === chosen.value)!);
const scale = computed(() => Math.max(...scenario.value.options.map((option) => option.high ?? option.low), 1));
const width = (amount: number) => `${Math.max(0.6, (amount / scale.value) * 100)}%`;
</script>

<template>
  <div class="compare">
    <div class="pick" role="group" aria-label="Kind of game">
      <button
        v-for="s in scenarios"
        :key="s.id"
        type="button"
        :aria-pressed="s.id === chosen"
        @click="chosen = s.id"
      >
        {{ s.name }}
      </button>
    </div>
    <p class="assumptions">{{ scenario.assumptions }}</p>

    <ul class="options">
      <li v-for="option in scenario.options" :key="option.name" :class="{ ours: option.ours }">
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

    <p class="verdict">{{ scenario.verdict }}</p>
    <p class="small">
      Estimates from published list prices, {{ PRICES_AS_OF }}. The Cloudflare figure is the whole bill; the others are
      the server or the service alone.
    </p>
  </div>
</template>

<style scoped>
.compare {
  margin-top: 8px;
  padding: 24px 20px 20px;
  border-radius: 16px;
  background: var(--tf-paper);
}

@media (min-width: 760px) {
  .compare {
    padding: 28px 32px 24px;
  }
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

.pick button:focus-visible {
  outline: 2px solid var(--tf-flare);
  outline-offset: 2px;
}

.assumptions {
  margin: 14px 0 0;
  min-height: 3.1em;
  max-width: 44rem;
  color: var(--tf-slate);
  line-height: 1.55;
}

.options {
  list-style: none;
  margin: 12px 0 0;
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

.price small {
  font-family: var(--vp-font-family-base);
  font-weight: 400;
  font-size: 13px;
  color: var(--tf-slate);
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

.verdict {
  margin: 8px 0 0;
  padding-top: 16px;
  border-top: 2px solid var(--tf-ink);
  max-width: 46rem;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.4;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--tf-ink);
}

.small {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--tf-slate);
}

@media (prefers-reduced-motion: reduce) {
  .bar {
    transition: none;
  }
}
</style>
