# Limits and how to live with them

Every limit here is one of three kinds: Cloudflare's, which nobody can lift; Tickflare's own design, which could change; and things that are simply not built yet. Each section says which it is, what you can do about it today, and what would lift it.

## At a glance

| | The limit | Where it comes from |
| --- | --- | --- |
| Players in a room | A few hundred at 10 ticks a second, [measured](#how-much-one-room-can-do). 32,768 connections at the very most. | One thread per room |
| A room's state | A few megabytes as JSON | It is saved, loaded and held in memory whole |
| A message from a player | 16 KB and 30 a second by default; both are settings | Tickflare, to protect the room |
| Transport | WebSockets: ordered and reliable, no UDP | Cloudflare |
| What a restart loses | Up to `saveIntervalMs` of a ticking room, five seconds by default | Tickflare |
| A room nobody is in | Stands still and stays, until your code says otherwise | Tickflare |
| Storage | 10 GB a room, 10 GB for accounts and match history | Cloudflare |
| Where a room runs | Where it was created; it does not move | Cloudflare |
| Clients | TypeScript and JavaScript | Not built |

Cloudflare's own numbers are on its [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) page.

## How much one room can do

A room is one Durable Object, and a Durable Object runs one thing at a time on one thread. That is what makes hooks simple and safe. It also means a room does only as much as one thread can.

What we measured, with Wrangler's local runtime on a two-core 2.1 GHz machine that was also running the players. A room asked for 10 ticks a second, with everything in it moving on every tick:

| In the room | Players | Ticks a second it managed |
| --- | --- | --- |
| 100 units, everyone sees all of them | 200 | 9.5 |
| 100 units, everyone sees all of them | 1,000 | 3.5 |
| 1,000 units, each player sees those near them | 200 | 9.2 |
| 1,000 units, each player sees those near them | 500 | 8.5 |
| 1,000 units, each player sees those near them | 1,000 | 6.0 |
| 5,000 units, each player sees those near them | 100 | 8.7 |
| 20,000 units, each player sees those near them | 20 | 9.2 |
| 1,000 units, by sight, asked for 30 ticks a second | 100 | 26 |
| 1,000 units, by sight, asked for 60 ticks a second | 50 | 53 |
| 1,000 units, by sight, and 480 commands a second | 100 | 9.0 |
| 5,000 units, by sight, and 480 commands a second | 100 | 8.3 |
| 20,000 units, by sight, and 400 commands a second | 20 | 8.7 |

Treat these as the right order of size, not as a promise: Cloudflare's machines are not this one, and with many players the same run varies by a tick a second or more. When a room cannot keep up, its simulation runs slow; it does not skip ahead to catch up.

Two things in Tickflare's design set these numbers:

- **The whole state is turned into JSON whenever it is saved or sent whole, and once or twice a tick.** In event mode that is every command that changes something: the state is written in full each time, and compared with what the players hold to send them the difference. While ticking it is the tick itself, which is compared whole so that `onTick` can run on plain objects, and the save every few seconds. What a command, a join or a timer costs in between is only what it touches: the room [follows a hook's writes](./rooms#the-state-inside-a-hook) rather than going through the state after it. A hook that changes nothing, or is refused, costs the same in a room of any size.
- **`view()` runs for every connected player on every tick**, and each result is compared with what that player was sent last.

**What you can do today**

- Send each player what they can see. A `view()` that filters by sight is the single biggest saving, in time and in bandwidth.
- Keep what never changes out of the state: a map, unit definitions. Send it once as a message, or let the page load it.
- In event mode, keep a large state out of rooms that take many commands: each one that changes anything writes all of it. Tick instead, even slowly, and the state is written every few seconds.
- Tick slower and let screens interpolate. Ten ticks a second is enough for most of what Tickflare aims at.
- Past a few hundred players, split the world [across rooms](./worlds).
- For many units and few players, use [lockstep](./lockstep): the room never touches the simulation.

**What would lift it.** Parts of a view that several players share are already [compared and written once](./state-and-views#views-that-share-a-public-part). Doing the same for a whole view, for a team that sees exactly the same, would save the rest of what such a player costs a tick. Not built.

## Bandwidth

Frames are JSON, and what is sent after a change is a patch: it names what changed and gives the new value. In event mode a move costs the bytes of what it changed, whatever the size of the state. While ticking, a moving unit costs about 26 bytes each tick it moves: a hundred units moving ten times a second is 26 KB a second to every player who sees them; a thousand is a quarter of a megabyte a second.

Cloudflare does not charge for it, but a player on a phone pays for it and a poor connection will not carry it.

A player is sent their whole view when they connect. With a custom `view()`, they are also sent it whole for the first change after the room has slept, since what each player was sent is remembered only while the room is in memory. A game with hidden hands and a minute between moves therefore still sends whole views; keep such a view small.

**What you can do today.** Filter with `view()`. Round positions to whole numbers. Send where a thing is going and when it gets there instead of where it is; [the costs guide](./costs#slow-games-do-not-tick) shows how. Tick slower.

**What would lift it.** A binary encoding in place of JSON, and sending numbers as differences. Not built.

## A room's state: saved whole

The state is one JSON document. It is saved whole: a ticking room writes all of it every `saveIntervalMs`, and an event-mode room writes all of it after every move that changes it.

That is deliberate. Cloudflare bills a room's storage by the row written, whatever the row holds, and a row written is most of what a move costs in a room that sleeps. One row for the whole state is the cheapest save there is; a state cut into parts that are saved separately would cost more, not less.

**How large it can be.** Cloudflare limits a row to 2 MB, so a state longer than 1.5 MB is spread over rows, one for each 1.5 MB, and each save writes them all. There is no fixed ceiling after that, but the state is held in memory three times over while a room is busy: as objects, as the JSON that was last saved, and as the copy that players are patched against. A room has 128 MB. We have run states of 4 MB; expect trouble somewhere past ten, and long before that every save and every join is moving megabytes.

**What you can do today**

- Keep large and static things out of the state, as above.
- A room has the whole of its database, 10 GB of it, through `this.ctx.storage.sql`. Tables of your own are read and written a row at a time, and are not sent to anyone.
- Split what is too big for one room across several.

## WebSockets, not UDP

Every message arrives, and in order. On a bad connection one lost packet holds up everything behind it. That is fine for strategy, cards, co-op and most action games at ten or twenty ticks a second. It is not fine for shooters and fighting games, where a late message is worth less than a lost one.

**What would lift it.** Nothing Tickflare can do by itself: a Durable Object can be reached by HTTP and WebSocket and nothing else. If Cloudflare gives Workers an unreliable transport, Tickflare can use it.

## Where a room runs

A Durable Object runs in the Cloudflare location where it was first created, and stays there. Players far from it have the latency of the distance.

Tickflare places a room near whoever asks for it first. A room made by a [matchmaker](./matchmaking) is placed near where most of its players are.

**What you can do today.** Create rooms through a matchmaker, and run a queue for each region if your players are spread across the world.

**What would lift it.** Matchmaking that weighs a player's distance when putting matches together. Not built.

## No prediction and no rollback

In state sync a player sees their own input one round trip later. Tickflare has no helpers for predicting it on the screen, nor for correcting the prediction when the room disagrees. In lockstep an order waits for the next turn.

**What you can do today.** Acknowledge the input on the screen at once, a selection ring or a sound, and let the result follow. For movement, draw toward the target while the room's answer is on its way.

**What would lift it.** Client-side prediction and reconciliation for state sync. Not built.

## Restarts and deploys

Every deploy of your Worker restarts every room. Cloudflare gives no warning of it, to you or to Tickflare.

- **Players are disconnected.** The client reconnects by itself and gets a fresh view. `onDisconnect` is not called for players dropped this way, though their seat timeout still starts.
- **A ticking room goes back** to its last save: up to `saveIntervalMs`, five seconds by default. An event-mode room loses nothing: it saves every move before anyone sees it.
- **A lockstep room loses no orders.** Its turn counter goes back by up to `saveIntervalMs` of empty turns, or with the players' clock skips ahead by as much.
- **The state is loaded as it was saved.** If a deploy changes the shape of your state, rooms already running still have the old shape. There is no migration step: read old shapes with care, or let old matches finish first.

**What you can do today.** Deploy when few matches are running. Call `saveNow()` after the moments you could not bear to lose. A save is one row, so a shorter `saveIntervalMs` is cheap.

## Rooms nobody is in

A room ticks only while a player is connected to it, unless you say otherwise. This is deliberate: an empty room is not billed. But it has a consequence that is easy to miss.

**A match everyone leaves stands still.** It is not over, it has no winner, and nothing ends it.

**Timers still fire.** A timer that sets itself again keeps waking an abandoned room for ever, and anything it does, such as keeping the room in a list, carries on.

**Rooms stay until you delete them.** A room that has had a player keeps its storage, a lockstep recording included, and with it the Durable Object, until it calls [`deleteRoom()`](./rooms#when-a-room-is-over). A room nobody was ever seated in stores nothing and leaves nothing behind.

**What you can do today.** Decide what an empty room means for your game, and say so in `onEmpty()`, which runs when the last seat is given up. For most matches, give the players a while to come back and then delete the room:

<<< @/snippets/empty/match.ts{28-33,39-43}

A lobby everyone has left needs the same decision, usually a plain `deleteRoom()`: nothing ends a room unless your code does.

A match that has to reach a result whoever is watching, a ranked one for instance, can [play on with nobody connected](./state-sync#playing-on-with-nobody-connected). That room is awake and billed until it ends, so it needs an end of its own.

## Storage

- **A room** has 10 GB. A lockstep recording grows by a row for each turn with an order in it; a finished match's recording belongs in R2, where [`finishMatch`](./match-results) puts it. On its way there it passes through the room's database, over as many rows as it needs.
- **Accounts and match history** are in one D1 database, which holds 10 GB and takes one write at a time. That is room for millions of accounts. Match history is one table keyed by match, without an index by player.

## Lockstep

- **Rejoining replays the match from the first turn.** There are no snapshots to shorten a long match, so a rejoin takes longer the longer the match has run.
- **Every screen holds the whole game.** There is no hidden information, and a modified client can show what the game hides.
- **A desync is noticed, not settled.** The room knows that two simulations differed and at which turn, not which one is wrong.
- **Anyone the gateway lets through can read a room's recording**, seated or not.
- **A lockstep client does not follow a handover** to another room.
- **With the players' clock**, the game stands still while nobody is connected.

**What would lift it.** Snapshots: the client saves its simulation now and then, and a rejoin starts from the latest. Not built.

## Accounts, matchmaking and results

- **Accounts** have no email verification and no password reset.
- **The matchmaker** is first come, first served: no skill ratings, no parties, no regions. Each queue is one object, good for about a thousand requests a second.
- **Delivery of match results and handovers is at least once.** After a crash at the wrong moment one can arrive twice. What a room owes and could not deliver is retried on its next event, not on a timer of its own.
- **A join token scoped to a name** opens both the room and the matchmaking queue of that name.

## Worlds

Seeing across a border is a recipe built on `signal`, not something a room does by itself, and a room cannot act on a neighbour's units.

## Clients

The client is TypeScript, for browsers and Node. There is none for Unity, Godot or native code. [The protocol](../reference/protocol) is JSON over a WebSocket and is written down, so one can be written.

## How far it has been tested

Tickflare is at 0.1. It has a test suite that runs against Cloudflare's own runtime, and one game running on it in production. It has not been load-tested on Cloudflare itself: the figures on this page were measured locally. The API can still change between versions; [Upgrading](../reference/upgrading) says what did.

## What would lift the most

In the order we would take them, by how much each removes for the work it needs:

1. **Snapshots for lockstep.** Rejoining a long match at once.
2. **A binary encoding.** Less bandwidth while ticking.
3. **Prediction helpers for state sync.**
4. **Matchmaking by skill and region; account recovery.**

None of these is promised. They are here so that you can see where the edges are, and which of them are meant to move.
