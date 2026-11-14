<script setup lang="ts">
/**
 * A small "?" beside a label that says what the thing is for. The text shows
 * when the button is hovered or focused, and a tap or click keeps it open
 * until the next one, a tap elsewhere or Escape. Only one is open at a time.
 *
 * The bubble is placed against the nearest positioned ancestor, not against
 * the button, so that a parent can keep it inside a narrow column.
 */
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { openTip } from "./help";

defineProps<{ about: string }>();

const id = useId();
const root = ref<HTMLElement>();
/** Opened by a tap or click, so that moving away does not close it. */
const pinned = ref(false);
const open = computed(() => openTip.value === id);
let closing: ReturnType<typeof setTimeout> | undefined;

function show(): void {
  clearTimeout(closing);
  openTip.value = id;
}

function hide(): void {
  clearTimeout(closing);
  if (open.value) openTip.value = null;
}

/** The pointer left. It may be on its way to the bubble, so wait a moment. */
function leave(): void {
  if (!pinned.value) closing = setTimeout(hide, 160);
}

function toggle(): void {
  if (open.value && pinned.value) return hide();
  show();
  pinned.value = true;
}

function outside(event: Event): void {
  if (!root.value?.contains(event.target as Node)) hide();
}

watch(open, (isOpen) => {
  if (!isOpen) pinned.value = false;
  // Touch screens do not take focus away from a button when something else is tapped.
  if (isOpen) document.addEventListener("pointerdown", outside);
  else document.removeEventListener("pointerdown", outside);
});

onBeforeUnmount(() => {
  clearTimeout(closing);
  document.removeEventListener("pointerdown", outside);
  hide();
});
</script>

<template>
  <span ref="root" class="help" @mouseenter="show" @mouseleave="leave" @keydown.esc="hide">
    <button
      type="button"
      :class="{ open }"
      :aria-label="`About “${about}”`"
      :aria-describedby="id"
      :aria-expanded="open"
      @focus="show"
      @blur="hide"
      @click="toggle"
    >
      <span aria-hidden="true">?</span>
    </button>
    <Transition name="tip">
      <span v-show="open" :id="id" class="tip" role="tooltip"><slot /></span>
    </Transition>
  </span>
</template>

<style scoped>
.help {
  display: inline-flex;
}

button {
  position: relative;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  font-family: var(--tf-display);
  font-size: 12.5px;
  font-weight: 750;
  line-height: 1;
  color: var(--tf-slate);
  box-shadow: inset 0 0 0 1.5px var(--tf-line);
  transition: background-color 0.15s, color 0.15s, box-shadow 0.15s;
}

/* A target a thumb can hit, around a mark small enough to sit in a label. */
button::before {
  content: "";
  position: absolute;
  inset: -10px;
}

button:hover,
button.open {
  background: var(--tf-ink);
  color: var(--vp-c-bg);
  box-shadow: none;
}

button:focus-visible {
  outline: 2px solid var(--tf-flare);
  outline-offset: 2px;
}

.tip {
  position: absolute;
  z-index: 20;
  bottom: calc(100% + 8px);
  left: 0;
  width: max-content;
  max-width: min(300px, calc(100vw - 88px));
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--tf-ink);
  color: var(--vp-c-bg);
  font-size: 13.5px;
  font-weight: 450;
  line-height: 1.5;
  text-align: left;
  box-shadow: 0 8px 24px rgb(10 14 26 / 0.22);
}

.tip-enter-active,
.tip-leave-active {
  transition: opacity 0.12s, transform 0.12s;
}

.tip-enter-from,
.tip-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (prefers-reduced-motion: reduce) {
  .tip-enter-active,
  .tip-leave-active {
    transition: none;
  }
}
</style>
