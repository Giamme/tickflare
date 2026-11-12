<script setup lang="ts">
/** Which Cloudflare service does what in a Tickflare game, and what each is billed for. */
import { dollars, roomHour } from "./costs";

const services = [
  {
    name: "Workers",
    role: "The front door",
    does: "Checks who is connecting and passes their WebSocket to the right room. Also serves the accounts API and your pages.",
    billed: "Per request: one to open a connection, none for the messages that follow. Pages are free.",
  },
  {
    name: "Durable Objects",
    role: "The rooms",
    does: "Each room, and each matchmaking queue, is one. It runs your rules on a single thread, holds the players' sockets, and keeps state, seats and timers in its own SQLite.",
    billed: `Time awake: about ${dollars(roomHour)} an hour per room. Messages from players: 20 count as one request. Nothing while asleep.`,
    main: true,
  },
  {
    name: "D1",
    role: "The records",
    does: "Accounts, sessions, player data, stats and leaderboards, match history.",
    billed: "Rows read and written. The plan includes 25 billion reads and 50 million writes a month.",
  },
  {
    name: "Queues",
    role: "The courier",
    does: "Carries each finished match from its room to your Worker, and keeps trying until it is stored.",
    billed: "Per message. The plan includes a million operations a month.",
  },
  {
    name: "R2",
    role: "The archive",
    does: "Replays.",
    billed: "Storage, at $0.015 per GB a month. Downloads are free.",
  },
];
</script>

<template>
  <div class="stack" role="table" aria-label="How Tickflare uses Cloudflare">
    <div class="row head" role="row">
      <span role="columnheader">Service</span>
      <span role="columnheader">What Tickflare uses it for</span>
      <span role="columnheader">What you pay for</span>
    </div>
    <div v-for="service in services" :key="service.name" class="row" :class="{ main: service.main }" role="row">
      <div class="service" role="cell">
        <strong>{{ service.name }}</strong>
        <span>{{ service.role }}</span>
      </div>
      <p role="cell">{{ service.does }}</p>
      <p class="billed" role="cell"><span class="label">You pay for: </span>{{ service.billed }}</p>
    </div>
  </div>
</template>

<style scoped>
.stack {
  margin-top: 8px;
  border-bottom: 1px solid var(--tf-line);
}

.row {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 4px 32px;
  padding: 18px 0;
  border-top: 1px solid var(--tf-line);
}

.row.head {
  display: none;
}

@media (min-width: 900px) {
  .row {
    grid-template-columns: 180px minmax(0, 1fr) minmax(0, 1fr);
    padding: 18px 0;
  }

  .row.head {
    display: grid;
    padding: 0 0 8px;
    border-top: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--tf-slate);
  }

  .label {
    display: none;
  }
}

.service strong {
  display: block;
  font-family: var(--tf-display);
  font-variation-settings: "CASL" 0.5;
  font-size: 19px;
  font-weight: 720;
  line-height: 1.3;
  color: var(--tf-ink);
}

.main .service strong {
  color: var(--tf-flare-text);
}

.service span {
  font-size: 14px;
  color: var(--tf-slate);
}

.row p {
  margin: 0;
  line-height: 1.55;
}

.billed {
  color: var(--tf-slate);
}

.label {
  font-weight: 600;
  color: var(--tf-ink);
}
</style>
