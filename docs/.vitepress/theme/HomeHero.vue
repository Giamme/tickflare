<script setup lang="ts">
import { ref } from "vue";
import { withBase } from "vitepress";
import ModeDemos from "./ModeDemos.vue";
import { data as release } from "./release.data";

const install = "npm install tickflare";
const copied = ref(false);

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(install);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1800);
  } catch {
    // No clipboard (an insecure origin, an old browser): the command is on screen to select.
  }
}
</script>

<template>
  <section class="tf-hero">
    <div class="tf-hero-text">
      <a class="tf-release" href="#new">
        <span class="tf-release-version">v{{ release.version }}</span>
        <span v-if="release.dated" class="tf-release-date">{{ release.dated }}</span>
        <span class="tf-release-more">What is new</span>
      </a>
      <h1 class="tf-headline">Multiplayer rooms that run on Cloudflare.</h1>
      <p class="tf-sub">
        Each room is one Durable Object. You write the rules in TypeScript; Tickflare keeps every
        player's connection, seat and view of the game in step, and saves each move before anyone sees it.
      </p>
      <div class="tf-actions">
        <a class="tf-button" :href="withBase('/guide/getting-started')">Get started</a>
        <a class="tf-button tf-quiet" :href="withBase('/guide/introduction')">How it works</a>
        <div class="tf-install">
          <code>{{ install }}</code>
          <button type="button" class="tf-copy" @click="copy">{{ copied ? "Copied" : "Copy" }}</button>
        </div>
      </div>
    </div>
    <ModeDemos />
  </section>
</template>

<style scoped>
.tf-hero {
  max-width: 1280px;
  margin: 0 auto;
  padding: 40px 24px 24px;
}

@media (min-width: 640px) {
  .tf-hero {
    padding: 56px 48px 32px;
  }
}

@media (min-width: 960px) {
  .tf-hero {
    padding: 64px 64px 40px;
  }
}

.tf-hero-text {
  max-width: 64rem;
}

/* Which version this is, from package.json and the changelog, and the way to what it brought. */
.tf-release {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 12px;
  margin: 0 0 20px;
  padding: 5px 14px 5px 6px;
  border-radius: 999px;
  background: var(--tf-paper);
  font-size: 14px;
  line-height: 1.5;
  color: var(--tf-slate);
  text-decoration: none;
}

.tf-release-version {
  padding: 1px 9px;
  border-radius: 999px;
  background: var(--tf-ink);
  color: var(--vp-c-bg);
  font-family: var(--vp-font-family-mono);
  font-size: 13px;
  font-weight: 600;
}

/* On a phone the three do not fit on a line, and the date is the one to go: the section it leads to has it. */
@media (max-width: 439px) {
  .tf-release-date {
    display: none;
  }
}

.tf-release-more {
  font-weight: 600;
  color: var(--tf-flare-text);
}

.tf-release:hover .tf-release-more {
  text-decoration: underline;
}

.tf-release:focus-visible {
  outline: 2px solid var(--tf-flare);
  outline-offset: 2px;
}

.tf-headline {
  margin: 0;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.6;
  font-weight: 820;
  font-size: clamp(40px, 6vw, 72px);
  line-height: 1.02;
  letter-spacing: -0.025em;
  color: var(--tf-ink);
  text-wrap: balance;
}

.tf-sub {
  margin: 20px 0 0;
  max-width: 40rem;
  font-size: 18px;
  line-height: 1.6;
  color: var(--tf-slate);
}

.tf-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 28px;
}

.tf-install {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 4px 4px 14px;
  border-radius: 10px;
  background: var(--tf-paper);
  max-width: 100%;
}

.tf-install code {
  font-family: var(--vp-font-family-mono);
  font-size: 14px;
  color: var(--tf-ink);
  background: none;
  white-space: nowrap;
  overflow-x: auto;
}

.tf-copy {
  flex: none;
  padding: 6px 12px;
  border-radius: 7px;
  font-size: 13px;
  font-weight: 600;
  color: var(--tf-slate);
}

.tf-copy:hover {
  color: var(--tf-ink);
  background: var(--vp-c-bg);
}

.tf-copy:focus-visible {
  outline: 2px solid var(--tf-flare);
  outline-offset: 2px;
}
</style>
