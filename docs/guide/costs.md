<script setup>
import { PRICES_AS_OF, dollars, millionMessages, roomHour, scenarios } from "../.vitepress/theme/costs";
const [turns, realtime, busy] = scenarios;
</script>

# What it costs

A Tickflare game has no servers to rent. Cloudflare bills each service for what it does, so the cost depends on what your rooms are doing, not on how many players have accounts. This page explains the billing, works through three games, and compares the result with other ways to host.

All prices are published list prices in US dollars, read in {{ PRICES_AS_OF }}. They change; the [sources](#sources) are linked at the end.

## The short version

- **A room awake costs about {{ dollars(roomHour) }} an hour.** That is the same whether it holds two players or fifty, and whatever its tick rate.
- **A room asleep costs nothing.** In event mode a room sleeps between moves, with its players still connected.
- **Messages from players cost {{ dollars(millionMessages) }} per million.** Messages to players are free.
- **Bandwidth is free.**
- **The paid plan is $5 a month** and includes enough for a small game. Rooms and guests also run on Cloudflare's free plan.

So a turn-based game costs close to nothing, and a real-time game costs in proportion to how many rooms are running and for how long.

## What "awake" means

A room is a Durable Object. Cloudflare bills a Durable Object for the time it is awake, counted as 128 MB of memory for each second, whatever it actually uses.

- **Event mode.** The room is awake only while a hook runs: a few hundredths of a second for a move. Between moves it sleeps, and Cloudflare keeps the WebSockets open at no charge. Keepalives are answered without waking it.
- **State sync and lockstep.** The room is awake for as long as its simulation runs: while at least one player is connected and `shouldTick()` returns true. When the last player disconnects, or the match ends, it goes back to sleep.
- **Matchmakers** sleep while players wait in the queue.

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
- **The free plan's daily time** is worth about 28 room-hours of real-time play a day.
- **Rows written** are the room saving its state: once per accepted change in event mode, and once every `saveIntervalMs` (five seconds by default) while ticking.
- On the free plan a request gets 10 ms of CPU. Sign-up and sign-in hash a password, which can take longer, so plan on the paid plan if you use [accounts](./accounts). Rooms and guests are not affected.

## Three games, worked through

### A turn-based game

{{ turns.assumptions }}

- **Requests.** 60,000 moves a day is 1.8 million messages a month, which count as 90,000 requests. Add 90,000 connections: 180,000, inside the million included.
- **Time awake.** 1.8 million moves at about 0.02 seconds each is 36,000 seconds, or 4,608 GB-s, inside the 400,000 included.
- **Rows written.** About four per move with a turn clock: 7.2 million, inside the 50 million included.

**Total: {{ dollars(turns.bill.total) }} a month**, the plan's base. At a few hundred players a day the same game fits the free plan; what runs out first there is the 100,000 rows written a day.

### A real-time game

{{ realtime.assumptions }}

- **Time awake.** Ten rooms around the clock: 10 × 2,628,000 seconds × 0.128 = 3,363,840 GB-s. Less the 400,000 included, at $12.50 per million: **$37.05**.
- **Requests.** 100 players × 2 inputs × 2,628,000 seconds is 525.6 million messages, which count as 26.3 million requests. Add 219,000 connections, take off the million included, at $0.15 per million: **$3.82**.
- **Rows written.** Ten rooms saving every five seconds: 5.3 million, inside the 50 million included.

**Total: about {{ dollars(Math.round(realtime.bill.total)) }} a month**, base included. That is the cost of ten rooms that never stop. If the same players are only online in the evening, the rooms sleep the rest of the day and the bill falls with them.

### A busy real-time game

{{ busy.assumptions }}

- **Time awake.** A hundred rooms around the clock: 33,638,400 GB-s. Less the included 400,000: **$415.48**.
- **Requests.** 5.26 billion messages count as 262.8 million requests. With 2.19 million connections, less the included million: **$39.60**.
- **Rows written.** 52.6 million, which is 2.6 million over: **$2.56**.

**Total: about {{ dollars(Math.round(busy.bill.total)) }} a month.**

### One match

Often the most useful number is the cost of a match. A 30-minute match in one room costs half a room-hour: **about {{ dollars(roomHour / 2) }}**, plus about a hundredth of a cent for eight players' messages. A thousand such matches a day is about $87 a month.

## Compared with other ways to host

<CostCompare />

What each figure covers:

- **Tickflare on Cloudflare** is the whole bill: compute, storage, bandwidth, TLS and the network that places rooms near players.
- **A rented server** is the rent for a 2 vCPU, 4 GB virtual server: about $7 a month at the cheapest host we found (Hetzner's CX23, when it is in stock), and $12 to $24 at larger ones. You install, deploy, secure and monitor it, keep rooms alive across restarts yourself, and it sits in one region. How many players one holds depends entirely on your game.
- **Colyseus Cloud** is managed hosting for Colyseus servers, from $15 a month for a server, with no limit on players and bandwidth included.
- **Photon Fusion** is priced by the most players you have online at once: free up to 100 for one game, then $125 a month for 500, $250 for 1,000, $500 for 2,000, and $0.50 a player beyond that. It is a different kind of product, for Unity, and is here as the best-known example of pricing by concurrent players.

One difference runs through all of these. Cloudflare bills for the time rooms are actually awake, which follows your **average** load. A server, or a plan priced by concurrent players, has to be sized for your **peak**. The examples assume a peak three times the average.

## When a server is cheaper

A room that never sleeps costs about $4.20 a month on Cloudflare. A rented server at $7 to $24 a month costs the same as two to six such rooms. So if your game keeps many rooms running around the clock, and one server can hold them, renting servers is cheaper, and the gap grows with size. The busy example above costs several times what a few servers would.

Cloudflare costs less when rooms are awake a small part of the time:

- turn-based and asynchronous games, where rooms sleep between moves;
- games with quiet hours, where empty rooms cost nothing instead of idling on a server you pay for;
- new and small games, where the bill is $5 or nothing;
- spiky games, where a launch-day crowd needs no servers ordered in advance.

What you get for the difference in the other cases is not having servers: nothing to patch or restart, rooms that survive deploys, placement near players around the world, and no bandwidth bill.

## Keeping the bill down

- **Stop the simulation when nothing is happening.** Return false from `shouldTick()` in the lobby and after the match. The room then behaves as in event mode and sleeps.
- **Use event mode where you can.** A game that advances on moves and timers needs no tick loop.
- **Put more players in a room** when the game allows it. The room is billed, not the players.
- **Send intentions, not keystrokes.** One message with a target costs less than a stream of them. At {{ dollars(millionMessages) }} per million this matters only for very chatty games.
- **Set `seatTimeoutMs`** in real-time rooms, so a closed tab gives up its seat and the room can empty.

## Sources

Read in {{ PRICES_AS_OF }}:

- [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/) and [R2 pricing](https://developers.cloudflare.com/r2/pricing/), from Cloudflare.
- [Photon Fusion pricing](https://www.photonengine.com/fusion/pricing).
- [Colyseus Cloud pricing](https://colyseus.io/pricing/).
- [Hetzner Cloud](https://www.hetzner.com/cloud) for the cheapest server; the higher figure is the usual price of the same size at larger hosts.

These are estimates to plan with. Your own numbers depend on how long your players stay, how many share a room and how much they send; the arithmetic above is short enough to redo with them.
