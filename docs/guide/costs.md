<script setup>
import {
  PRICES_AS_OF,
  breakEven,
  breakEvenMovesAMinute,
  cheaperUpTo,
  dollars,
  estimate,
  millionMessages,
  millionMoves,
  presets,
  roomHour,
  server,
  tickingHour,
} from "../.vitepress/theme/costs";

const game = (id) => presets.find((preset) => preset.id === id).game;
/** The estimator's examples are the size of a new game. The worked examples are ten times that. */
const grown = (id) => ({ ...game(id), matchesPerDay: game(id).matchesPerDay * 10 });
const n = (value, digits = 0) => value.toLocaleString("en-US", { maximumFractionDigits: digits });
const about = (value) => Number(value.toPrecision(2)).toLocaleString("en-US");

const freeAtLaunch = presets.filter((preset) => estimate(preset.game).free).length;
const rts = estimate(grown("rts"));
const rtsAsleep = estimate({ ...grown("rts"), runs: "asked" });
const rtsAsleepSlower = estimate({ ...grown("rts"), runs: "asked" }, 0.02);
const rtsStateSync = estimate({ ...grown("rts"), runs: "sync" });
const cards = estimate(grown("cards"));
const arena = estimate(grown("arena"));
const battler = estimate(grown("rounds"));
const battlerTicking = estimate({ ...grown("rounds"), runs: "sync" });
const withClock = breakEven({ timerPerMove: true, saveEverySeconds: 5 });
const alwaysOn = tickingHour * 730;
</script>

# What it costs

A Tickflare game has no servers to rent. Cloudflare bills each service for what it does, so the cost depends on what your rooms are doing, not on how many players have accounts. This page has an estimator for your own numbers, explains the billing behind it, works through three games, and shows how the way a game is built changes its bill.

All prices are published list prices in US dollars, read in {{ PRICES_AS_OF }}. They change; the [sources](#sources) are linked at the end.

## The short version

- **A room that is running costs under a cent an hour:** about {{ dollars(tickingHour) }}, of which {{ dollars(roomHour) }} is for being awake and the rest for saving its state every five seconds. That is the same whether it holds two players or fifty, and whatever its tick rate.
- **A room asleep costs nothing.** In event mode a room sleeps between moves, with its players still connected.
- **A move in a sleeping room costs about {{ dollars(millionMoves) }} per million**, nearly all of it for saving the move before anyone sees it.
- **Messages from players cost {{ dollars(millionMessages) }} per million.** Messages to players, and bandwidth, are free.
- **The paid plan is $5 a month** and includes enough for a new game: every example in the estimator below, a few hundred players a day each, costs $5, and {{ freeAtLaunch }} of the {{ presets.length }} fit Cloudflare's free plan.

So a game played in sessions costs by the match: rooms exist while matches do, and an empty evening costs nothing. The estimator says how far each game can grow before a rented server would cost less in rent.

## Your own numbers

Start from an example or type your own; an example fills in every setting. The four boxes in the middle show the same game in each [sync mode](./sync-modes), lockstep twice: with the room keeping time, and with [the players' clients keeping it](./lockstep#letting-the-room-sleep-between-turns). Pick one to see where the money goes.

<CostEstimator />

## What "awake" means

A room is a Durable Object. Cloudflare bills a Durable Object for the time it is awake, counted as 128 MB of memory for each second, whatever it actually uses.

- **Event mode.** The room is awake only while a hook runs: a few hundredths of a second for a move. Between moves it sleeps, and Cloudflare keeps the WebSockets open at no charge. Keepalives are answered without waking it, and a timer does not keep it awake while it waits.
- **State sync and lockstep.** The room is awake for as long as its simulation runs: while at least one player is connected and `shouldTick()` returns true. When the last player disconnects, or the match ends, it goes back to sleep.
- **Lockstep with the players' clock.** The room is awake only to answer: a request for the turns that are due, ten times a second from one player's client, and the orders themselves. Between them it sleeps.
- **Matchmakers** sleep while players wait in the queue.

What Cloudflare counted when we [measured this on its network](./limits#the-same-rooms-on-cloudflare):

| | Awake, as billed |
| --- | --- |
| Five players connected to a room for 90 seconds, sending keepalives and one move | 0.66 seconds |
| A hundred moves in event mode, each of which is stored | 1.9 seconds: 0.019 each |
| A hundred commands that change nothing | 0.13 seconds |
| A room ticking for 10.5 seconds | 10.6 seconds |

Two things do not change the bill: the tick rate, and how much CPU your simulation uses. A room ticking 30 times a second with a heavy simulation costs the same per hour as one ticking 5 times with a light one. More players in a room cost nothing extra either, apart from their messages.

## Price list

| | Free plan | Paid plan includes | Then |
| --- | --- | --- | --- |
| **Workers** requests | 100,000 a day | 10 million a month | $0.30 per million |
| **Durable Objects** requests | 100,000 a day | 1 million a month | $0.15 per million |
| **Durable Objects** time awake | 13,000 GB-s a day | 400,000 GB-s a month | $12.50 per million GB-s |
| **Durable Objects** rows written | 100,000 a day | 50 million a month | $1.00 per million |
| **Durable Objects** stored data | 5 GB | 5 GB | $0.20 per GB a month |
| **D1** rows written | 100,000 a day | 50 million a month | $1.00 per million |
| **D1** rows read | 5 million a day | 25 billion a month | $0.001 per million |
| **D1** stored data | 5 GB | 5 GB | $0.75 per GB a month |
| **Queues** operations | 10,000 a day | 1 million a month | $0.40 per million |
| **R2** stored data | 10 GB | 10 GB | $0.015 per GB a month |

Reading it for a game:

- **A request** to a Durable Object is a connection being opened, a timer firing, or 20 messages from players. Cloudflare counts incoming WebSocket messages at 20 to a request.
- **A GB-second** is one second awake at 1 GB. A room is billed as 128 MB, so an hour awake is 3,600 × 0.128 = 460.8 GB-s, or {{ dollars(roomHour) }}.
- **Rows written** are the room saving. Measured with Wrangler's local runtime, a room writes:
  - one row for an accepted move in event mode, and one more if the move sets a timer again, as a turn clock does;
  - one row for each save while ticking, every `saveIntervalMs` (five seconds by default);
  - one row for each lockstep turn that has something in it, in the recording. Empty turns write nothing;
  - one row a minute for a lockstep room's [snapshot](./lockstep#snapshots), which arrives as one request. Thirty of each in a half-hour match: too little to show in the sums below.

  A save is one row whatever the size of the state, up to 1.5 MB of JSON. A longer state takes a row for each 1.5 MB.
- **A second awake costs the same as 1.6 rows.** That one comparison decides most of what follows.
- **The free plan's daily time** is worth about 28 room-hours of real-time play a day. For games that tick, that runs out first; for event-mode games, the 100,000 rows a day do.
- On the free plan a request gets 10 ms of CPU. Sign-up and sign-in hash a password, which can take longer, so plan on the paid plan if you use [accounts](./accounts). Rooms and guests are not affected.

## Three games, worked through

The estimator's examples are the size of a new game, where everything fits inside what the plan includes. These are three of them at ten times that size, where the arithmetic shows.

### An RTS, played in matches

{{ n(grown("rts").matchesPerDay) }} matches a day in [lockstep](./lockstep): eight players, half an hour, each sending an order every five seconds. That is {{ n(rts.matches) }} matches a month, with {{ n(rts.averageOnline) }} players online on average and {{ n(rts.peakOnline) }} at the peak.

- **Time awake.** A room runs for the 1,800 seconds of its match: {{ n(rts.matches) }} × 1,800 × 0.128 = {{ n(rts.gbSeconds) }} GB-s. Less the 400,000 included, at $12.50 per million: **{{ dollars(rts.bill.awake) }}**.
- **Saving.** A save every five seconds is 360 rows a match. The recording adds a row for every turn with an order in it: with 1.6 orders a second arriving across ten turns, that is about one turn in seven. Together {{ n(rts.rowsPerMatch) }} rows a match, {{ n(rts.rowsWritten / 1e6, 1) }} million a month, inside the 50 million included.
- **Messages.** {{ n(rts.messagesPerMatch) }} a match, counting the hashes the clients report, at 20 to a request: **{{ dollars(rts.bill.messages) }}**.

**Total: about {{ dollars(Math.round(rts.bill.total)) }} a month**, or {{ dollars(rts.perMatch * 1000) }} for each thousand matches beyond that. Nearly all of it is rooms being awake for their matches.

**With `turnClock = "players"`** the same rooms sleep between turns. A match's {{ n(rtsAsleep.messagesPerMatch) }} messages, most of them requests for turns, keep its room awake for about {{ n(rtsAsleep.secondsAwake) }} of its 1,800 seconds: {{ dollars(rtsAsleep.bill.awake) }} for time awake and {{ dollars(rtsAsleep.bill.messages) }} for messages. **Total: about {{ dollars(Math.round(rtsAsleep.bill.total)) }} a month.**

### A card game

{{ n(grown("cards").matchesPerDay) }} matches a day in event mode: two players, ten minutes, a move every twenty seconds each, on a turn clock.

- **Time awake.** {{ n(cards.messagesPerMatch) }} moves a match at about 0.02 seconds each: the room is awake for {{ n(cards.secondsAwake, 1) }} seconds of its ten minutes. {{ n(cards.gbSeconds) }} GB-s a month, inside the 400,000 included.
- **Saving.** Two rows a move, the move and the clock: {{ n(cards.rowsWritten / 1e6, 1) }} million a month, inside the 50 million included.
- **Messages.** {{ n(cards.requests) }} requests a month, inside the million included.

**Total: {{ dollars(cards.bill.total) }} a month**, the plan's base, and it stays there up to about {{ about(cheaperUpTo(game("cards"), 5)) }} matches a day. A thousand more matches cost {{ dollars(cards.perMatch * 1000) }}.

### An arena, in hour-long sessions

{{ n(grown("arena").matchesPerDay) }} sessions a day in [state sync](./state-sync): ten players for an hour, each steering twice a second. That is {{ n(arena.averageOnline) }} players online on average, in {{ n(arena.roomsAwake, 1) }} rooms.

- **Time awake.** {{ n(arena.matches) }} room-hours a month: {{ n(arena.gbSeconds) }} GB-s. Less the 400,000 included: **{{ dollars(arena.bill.awake) }}**.
- **Saving.** A row every five seconds: {{ n(arena.rowsWritten / 1e6, 1) }} million a month, inside the 50 million included.
- **Messages.** {{ n(arena.messagesPerMatch) }} a session, at 20 to a request; {{ n(arena.requests / 1e6, 1) }} million requests a month, less the million included: **{{ dollars(arena.bill.messages) }}**.

**Total: about {{ dollars(Math.round(arena.bill.total)) }} a month.**

## Compared with other ways to host

The estimator puts three alternatives beside the Cloudflare figure. What each covers:

- **Tickflare on Cloudflare** is the whole bill: compute, storage, bandwidth, TLS and the network that places rooms near players.
- **A rented server** is the rent for a 2 vCPU, 4 GB virtual server: about $7 a month at the cheapest host we found (Hetzner's CX23, when it is in stock), and $12 to $24 at larger ones. You install, deploy, secure and monitor it, keep rooms alive across restarts yourself, and it sits in one region. How many players one holds depends entirely on your game; the estimator assumes 750 and lets you change it.
- **Colyseus Cloud** is managed hosting for Colyseus servers, from $15 a month for a server, with no limit on players and bandwidth included.
- **Photon Fusion** is priced by the most players you have online at once: free up to 100 for one game, then $125 a month for 500, $250 for 1,000, $500 for 2,000, and $0.50 a player beyond that. It is a different kind of product, for Unity, and is here as the best-known example of pricing by concurrent players.

One difference runs through all of these. Cloudflare bills for the time rooms are actually awake, which follows your **average** load. A server, or a plan priced by concurrent players, has to be sized for your **peak**. The estimator assumes a peak three times the average.

## When a server is cheaper

A room that never stops costs about {{ dollars(alwaysOn) }} a month on Cloudflare. A rented server at ${{ server.low }} to ${{ server.high }} a month costs the same as one to five such rooms. So if your game keeps many rooms running around the clock, and one server can hold them, renting servers is cheaper, and the gap grows with size.

Where the line falls depends on the game, and the estimator works it out for yours. For the examples:

| | Costs less than a ${{ server.low }} server up to | Less than a ${{ server.high }} one up to |
| --- | --- | --- |
| RTS matches, lockstep | {{ about(cheaperUpTo(game("rts"), server.low)) }} matches a day | {{ about(cheaperUpTo(game("rts"), server.high)) }} |
| RTS matches, lockstep with the players' clock | {{ about(cheaperUpTo({ ...game("rts"), runs: "asked" }, server.low)) }} matches a day | {{ about(cheaperUpTo({ ...game("rts"), runs: "asked" }, server.high)) }} |
| Arena sessions, state sync | {{ about(cheaperUpTo(game("arena"), server.low)) }} sessions a day | {{ about(cheaperUpTo(game("arena"), server.high)) }} |
| Co-op runs, state sync | {{ about(cheaperUpTo(game("coop"), server.low)) }} runs a day | {{ about(cheaperUpTo(game("coop"), server.high)) }} |
| Auto-battler, event mode | {{ about(cheaperUpTo(game("rounds"), server.low)) }} matches a day | {{ about(cheaperUpTo(game("rounds"), server.high)) }} |
| Card game, event mode | {{ about(cheaperUpTo(game("cards"), server.low)) }} matches a day | {{ about(cheaperUpTo(game("cards"), server.high)) }} |

Past those sizes the real-time games cost more than the one small server that could hold them: the two worked through above are about twice the price of a typical one.

Cloudflare costs less when rooms are awake a small part of the time:

- turn-based and asynchronous games, where rooms sleep between moves;
- games with quiet hours, where empty rooms cost nothing instead of idling on a server you pay for;
- new and small games, where the bill is $5 or nothing;
- spiky games, where a launch-day crowd needs no servers ordered in advance.

What you get for the difference in the other cases is not having servers: nothing to patch or restart, rooms that survive deploys, placement near players around the world, and no bandwidth bill.

## Designing a game that costs less

Three meters run: seconds awake, rows written and messages in. Messages are close to free. So a design is cheap when it keeps rooms asleep, or when it saves less often, and the two pull against each other: a sleeping room saves every move, a ticking room saves on a schedule.

### Pay by the match

A room costs only while it runs, so the first thing is to run it only while there is a game.

- Return false from `shouldTick()` in the lobby, between rounds and after the result. The room then behaves as in event mode and sleeps.
- Set `seatTimeoutMs`, so a closed tab gives up its seat and an abandoned match can empty and stop.
- Keep the lobby, chat and matchmaking in rooms without a tick rate. Players waiting cost nothing.

### Slow games: do not tick

Below about **{{ breakEvenMovesAMinute }} moves a minute in a room**, or {{ withClock }} if every move sets a timer, a room that sleeps is cheaper than one that ticks, and the slower the game the bigger the difference. An auto-battler where eight players each make two decisions a minute costs {{ dollars(battler.bill.total) }} a month for {{ n(grown("rounds").matchesPerDay) }} half-hour matches a day in event mode, and {{ dollars(Math.round(battlerTicking.bill.total)) }} if the room ticks through them.

This reaches further than turn-based games. Much of what looks continuous on screen is decided at a few moments: an order is given, a unit arrives, a wave spawns, a round ends. Send what will happen instead of where things are, let every screen animate it, and set a timer for the next moment the room has to decide something:

<<< @/snippets/march/march.ts

The room is awake for each order and each arrival, a few hundredths of a second at a time. Movement is exactly as smooth as the screens draw it. What you give up is the room noticing things between those moments: if two units can meet halfway, work out when they will and set a timer for that, or use a tick.

### Fast games: tick, and let the room do the work

Above that rate, tick. A ticking room saves on a schedule however much is going on, so its cost is flat: {{ dollars(tickingHour) }} an hour.

- **Fill the rooms.** The room is billed, not the players. Ten players in one room cost a tenth of ten rooms.
- **Use the time you have paid for.** Tick rate and CPU are not billed, so a busier simulation costs nothing more.
- **Leave `saveIntervalMs` alone** unless you have a reason. A save is one row, so at five seconds saving is a tenth of the room's cost.

### Lockstep: let the room sleep

A lockstep room does no simulating, yet with its own timer it is awake for the whole match just to close turns, most of them empty. Give the clock to the players and it sleeps between turns:

```ts
export class Skirmish extends LockstepRoom<Order> {
  protected override turnClock = "players" as const;
}
```

One player's client then asks for each turn as it falls due, and the room wakes for a moment to close it. The room still decides how many turns are due, so nobody can hurry the game, and orders take effect as soon as they did. [The lockstep guide](./lockstep#letting-the-room-sleep-between-turns) says what else changes.

| The RTS example, {{ n(grown("rts").matchesPerDay) }} matches a day | A month |
| --- | --- |
| Lockstep, the room keeping time | {{ dollars(Math.round(rts.bill.total)) }} |
| State sync, the room running the simulation | {{ dollars(Math.round(rtsStateSync.bill.total)) }} |
| Lockstep, the players' clients keeping time | {{ dollars(Math.round(rtsAsleep.bill.total)) }} |

The last figure rests on one assumption that cannot be checked from outside Cloudflare: that a request for turns keeps the room awake for about a hundredth of a second, as Cloudflare's own pricing examples assume for a message. At twice that it would be about {{ dollars(Math.round(rtsAsleepSlower.bill.total)) }}.

Whichever clock you use, a turn with an order in it is one row in the recording, written before any player is sent that turn. At the example's rate that is about 3,000 rows a match, which the plan's 50 million a month cover up to roughly 500 matches a day. So:

- **Send decisions.** Selecting, hovering and camera moves stay on the screen. Only what changes the game goes to the room.
- **Make one order say more.** "These twelve units attack there" is one order, not twelve. A queue of waypoints is one order.

### Small things

- **Batching messages** is not worth designing for. At {{ dollars(millionMessages) }} per million it matters only for very chatty games.
- **A timer costs a row** each time it is set again. A turn clock on every move doubles what the move writes; a single deadline for the round does not.
- **Stored data** is 5 GB before it costs anything. Recordings of finished matches belong in R2, where `finishMatch` puts them.

## Sources

Read in {{ PRICES_AS_OF }}:

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/), from Cloudflare.
- [Photon Fusion pricing](https://www.photonengine.com/fusion/pricing).
- [Colyseus Cloud pricing](https://colyseus.io/pricing/).
- [Hetzner Cloud](https://www.hetzner.com/cloud) for the cheapest server; the higher figure is the usual price of the same size at larger hosts.

The row counts are Tickflare's own, measured by running each kind of write in Wrangler's local runtime and reading what it reports as written; on Cloudflare a hundred moves were counted as 118 rows written, joining included. The time a move keeps a room awake, 0.02 seconds, is twice what Cloudflare's pricing examples assume, and what Cloudflare counted for our moves: 0.019 seconds.

These are estimates to plan with. Your own numbers depend on how long your players stay, how many share a room and how much they send; the estimator and the arithmetic above are there to redo with them.
