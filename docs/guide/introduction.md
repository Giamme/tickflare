# What Tickflare is

Tickflare is a multiplayer game framework for [Cloudflare Workers](https://developers.cloudflare.com/workers/) and [Durable Objects](https://developers.cloudflare.com/durable-objects/).

A Durable Object is a single-threaded JavaScript object with its own storage. Cloudflare creates it on first use, near whoever asked for it, and routes every request for the same name to the same instance. That is exactly what an authoritative game server needs: one place that holds the truth about a match and that every player talks to.

Tickflare gives that object a game-shaped API. You write a `Room` class with the state and the rules. Tickflare handles the rest:

- player WebSockets
- seats and reconnects
- saving every change before anyone hears about it
- rolling back moves you refuse
- timers that survive restarts
- sending each player only what they are allowed to see

```
browser ── WebSocket ──▶ Worker (gateway) ──▶ Room (Durable Object, one per room id)
                         authenticates          runs your hooks, saves state,
                         and routes             sends each player their view
```

## Which games it suits

Tickflare is aimed at games where an authoritative server and a few tens of milliseconds of latency are fine:

- turn-based and asynchronous games: board games, card games, word games, anything played over days
- co-op and party games
- `.io`-style real-time games
- strategy games, including real-time strategy with many units

Games that need UDP and rollback netcode are out of scope: shooters, fighting games and sim racing. Durable Objects speak TCP (WebSockets), and Tickflare doesn't try to hide that.

## Three ways to keep players in sync

A room synchronises its players in one of three ways. All three share the same room kernel, so seats, timers, persistence and identity work the same way in each.

| Mode | The room... | Suits |
| --- | --- | --- |
| [Event mode](./rooms) | wakes when something happens, runs your hook and goes back to sleep | turn-based, cards, async |
| [State sync](./state-sync) | runs `onTick` at a fixed rate and sends each player what changed in their view | action, co-op, `.io` |
| [Lockstep](./lockstep) | orders everyone's inputs into turns; clients run the simulation | RTS, many units |

[Choosing a mode](./sync-modes) goes into the trade-offs.

## What else is in the box

Around the room kernel there are the services a game usually needs, built on Cloudflare products:

- **A gateway** that authenticates connections and routes them to rooms ([Identity and join tokens](./identity)).
- **Accounts** on D1: guests, sign-up, sessions, per-player data, stats and leaderboards ([Accounts and player data](./accounts)).
- **Matchmaking** with queues that reserve a room for each match and place it near its players ([Matchmaking](./matchmaking)).
- **Match results** sent through a Queue into D1, with replays in R2 ([Match results and replays](./match-results)).
- **Worlds across rooms**, for worlds too big for one object ([Worlds across rooms](./worlds)).
- **A client** for browsers and Node that reconnects on its own and keeps the latest state. A command that was on its way when the connection dropped is neither lost nor applied twice ([Connecting from the client](./client)).

## Status

Tickflare is at version 0.1, its first public release, on npm as `tickflare`. Expect the API to change before 1.0: the [changelog](../reference/upgrading) says how versions work until then, and lists every change with what to do about it.

[Limits and known gaps](./limits) lists what is not there yet.
