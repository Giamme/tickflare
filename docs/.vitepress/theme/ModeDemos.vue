<script setup lang="ts">
/**
 * The home page's demo: one small game for each of the three ways a room can
 * keep its players in step. One runs at a time.
 */
import ArenaDemo from "./ArenaDemo.vue";
import LockstepDemo from "./LockstepDemo.vue";
import TurnsDemo from "./TurnsDemo.vue";
import { mode, type Mode } from "./demo/shared";

const modes: { id: Mode; name: string; about: string }[] = [
  { id: "event", name: "Event mode", about: "The room sleeps until a move or a timer wakes it. For turns, cards and games played over days." },
  { id: "sync", name: "State sync", about: "The room runs the game and sends each player what they can see. For action, co-op and fog of war." },
  { id: "lockstep", name: "Lockstep", about: "The room only puts inputs in order; every screen runs the game. For strategy with many units." },
];
</script>

<template>
  <div id="demo" class="tf-shell">
    <div class="tf-pick" role="group" aria-label="Which kind of room to show">
      <button v-for="m in modes" :key="m.id" type="button" :aria-pressed="mode === m.id" @click="mode = m.id">{{ m.name }}</button>
      <p class="about">{{ modes.find((m) => m.id === mode)?.about }}</p>
    </div>
    <TurnsDemo v-if="mode === 'event'" />
    <ArenaDemo v-else-if="mode === 'sync'" />
    <LockstepDemo v-else />
  </div>
</template>
