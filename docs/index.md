---
layout: home

hero:
  name: Tickflare
  text: Multiplayer games on Cloudflare
  tagline: Each room is one Durable Object. You write the rules; Tickflare handles connections, persistence, reconnects and what each player is allowed to see.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What it is
      link: /guide/introduction
    - theme: alt
      text: API reference
      link: /api/

features:
  - title: Event mode
    details: Turn-based and asynchronous games. The room sleeps between moves while sockets stay open, so a game played over days costs almost nothing to host.
    link: /guide/rooms
  - title: State sync
    details: Real-time rooms with a fixed-rate simulation. Each player gets only what changed in their own view, tick after tick.
    link: /guide/state-sync
  - title: Lockstep
    details: Strategy games with thousands of units. The room orders inputs into turns; every client runs the same deterministic simulation.
    link: /guide/lockstep
  - title: Accounts and player data
    details: Guests, sign-up, sessions, per-player data, stats and leaderboards on D1, with a client to match.
    link: /guide/accounts
  - title: Matchmaking and results
    details: Queues that pair players and reserve their room near them. Finished matches go through a Queue into D1, replays into R2.
    link: /guide/matchmaking
  - title: Worlds across rooms
    details: Worlds too big for one room are cut into cells. Players are handed from room to room, and rooms can see across their borders.
    link: /guide/worlds
---
