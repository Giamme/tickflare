# Limits and how to live with them

Every limit here is one of three kinds: Cloudflare's, which nobody can lift; Tickflare's own design, which could change; and things that are simply not built yet. Each section says which it is, what you can do about it today, and what would lift it.

## At a glance

| | The limit | Where it comes from |
| --- | --- | --- |
| Players in a room | Five hundred with a view each at 10 ticks a second, a thousand who all see the same, [measured](#the-same-rooms-on-cloudflare). 32,768 connections at the very most. | One thread per room |
| A room's state | A few megabytes as JSON | It is saved, loaded and held in memory whole |
| A message from a player | 16 KB and 30 a second by default; both are settings | Tickflare, to protect the room |
| Transport | WebSockets: ordered and reliable, no UDP | Cloudflare |
| What a restart loses | Up to `saveIntervalMs` of a ticking room, five seconds by default | Tickflare |
| A room nobody is in | Stands still and stays, until your code says otherwise | Tickflare |
| Storage | 10 GB a room, 10 GB for accounts and match history | Cloudflare |
| Where a room runs | Where it was created; it does not move | Cloudflare |
| Clients | TypeScript, Godot and Unity; lockstep and prediction in TypeScript only | Not built |

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

### The same rooms on Cloudflare

The same rooms, deployed to Cloudflare in November 2026 and played from a machine in a data centre near them. The last column is how much of one processor the room used, from Cloudflare's own count of its CPU time:

| In the room | Players | Ticks asked for | Managed | Of one processor |
| --- | --- | --- | --- | --- |
| 100 units, everyone sees all of them | 200 | 10 | 9.9 | 8% |
| 100 units, everyone sees all of them | 1,000 | 10 | 9.5 | not counted |
| 1,000 units, each player sees those near them | 200 | 10 | 9.9 | 18% |
| 1,000 units, by sight | 500 | 10 | 9.8 to 10 | 28% |
| 1,000 units, by sight | 1,000 | 10 | 1.3 | not counted |
| 5,000 units, by sight | 100 | 10 | 9.7 to 10 | 20% |
| 20,000 units, by sight | 20 | 10 | 9.1 to 10 | not counted |
| 1,000 units, by sight | 100 | 30 | 30.4 | not counted |
| 1,000 units, by sight | 50 | 60 | 63 | 19% |
| 1,000 units, by sight, and 480 commands a second | 100 | 10 | 9.5 | 19% |
| 5,000 units, by sight, and 480 commands a second | 100 | 10 | 7.7 to 9.6 | 25% |
| 20,000 units, by sight, and 400 commands a second | 20 | 10 | 9.4 to 9.9 | 22% |

Where the local machine fell behind, Cloudflare's did not, with one exception, and no room for which we have the count used a third of a processor. A room asked for 60 ticks a second ran 62 or 63: ticks are a whole number of milliseconds apart, 16 for 60 a second.

**A thousand players with a view each is too many.** A thousand who all see the same hundred units were served 9.5 ticks a second. A thousand who each see their own part of a thousand units got 1.3: `view()` runs for every player on every tick, and at that size it is what the tick is spent on. Five hundred were fine. Past that, split the world [across rooms](./worlds).

**Players arriving together used to break a room, and no longer do.** The first time we measured, a thousand players connecting to one room did not work at all: every join was told to every player with the whole list of players, Cloudflare restarted the room for using too much memory six times while they connected, and most connections were lost. Five hundred worked in one run and not in the next. Since then a join is told as [who came, not who is here](../reference/protocol#presence), and in a room of more than 64 connections at most ten times a second. Measured again, a thousand players connected in 16 seconds, as fast as one machine could open the connections, and the room was never restarted; five hundred connected in under five.

These were four runs of a few minutes each, with every player on one machine in a data centre in the United States. They say nothing about a room that runs for hours, or about players on home connections around the world. The Worker and the scripts are in the repository's `bench` folder, and the workflow *Measure on Cloudflare* runs them on your own account.

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

Frames are JSON, and what is sent after a change is a patch: it names what changed and gives the new value. In event mode a move costs the bytes of what it changed, whatever the size of the state. While ticking, a unit that moves is about 26 bytes of JSON each tick.

**That is not what crosses the network.** Cloudflare's runtime compresses a WebSocket for every client that offers it, and browsers and Node offer it with every connection. There is nothing to turn on; it needs a compatibility date of 2023-08-15 or later. What reached a player, measured locally and again on Cloudflare, with the same result to within a byte, with units that walk in straight lines and turn now and then:

| A unit's position, each tick it moves | As JSON | On the wire |
| --- | --- | --- |
| Whole numbers | 26 bytes | 6 bytes |
| One decimal | 31 bytes | 7 bytes |
| Unrounded floats | 54 bytes | 20 bytes |

So a hundred units moving ten times a second is about 6 KB a second to every player who sees them, and a thousand about 60 KB a second. Cloudflare does not charge for it, but a player on a phone pays for it and a poor connection will not carry it.

- **Round what you send.** A position with all its decimals costs three times one rounded to a tenth, on the wire as in JSON. `Math.round(x * 10) / 10`, in the simulation or in `view()`.
- **A client of your own has to offer compression** (`permessage-deflate`), or it is sent the JSON as it is, unless it asks for binary patches. To see whether a connection has it, look for `Sec-WebSocket-Extensions` among the response headers of the WebSocket in your browser's developer tools.
- **Compression costs the room nothing we could measure.** Rooms ticked as fast with it as without, up to 1.2 MB of JSON a second to each of twenty players.

**Binary patches are for clients that cannot compress.** A client can ask for its patches [in binary](../reference/protocol#binary-patches), with every name sent once and numbers packed. The same units, measured the same way, in bytes on the wire for each unit that moves:

| | JSON | JSON, compressed | Binary | Binary, compressed |
| --- | --- | --- | --- | --- |
| Whole numbers | 27 | 6 | 11 | 5 |
| One decimal | 31 | 7 | 11 | 6 |
| Unrounded floats | 55 | 22 | 23 | 17 |

Without compression, binary is a little over a third of the JSON. With it, binary saves another 15% or so on rounded numbers. And compressed JSON is smaller than binary that is not compressed: about half the size, for rounded numbers. So: a browser or Node client gains little and loses frames it can read in the developer tools, which is why it is off unless asked for. A client in an engine whose WebSocket does not compress should ask for it. One that can compress should do that first. Rooms ticked as fast sending binary as sending JSON. These figures are from Cloudflare's runtime run locally: we have not measured on Cloudflare's network.

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

How long a command took to come back answered, from a machine about 18 ms from the Worker and back, with the room in the same region:

| | Typical | Slowest of twenty |
| --- | --- | --- |
| A request to the Worker, with no room involved | 18 ms | |
| A command that changes nothing | 21 ms | 24 ms |
| A command that changes the state, in event mode | 42 ms | 95 ms |
| A command in a room ticking 20 times a second | 43 ms | 45 ms |

A room adds about 3 ms to the way there and back. In event mode a change is stored before anyone hears of it, which took about 20 ms more. In a ticking room a command is answered with the tick that shows it, so it waits for up to one tick, and nothing is stored on the way.

**What you can do today.** Create rooms through a matchmaker, and have it [match within a region first](./matchmaking#matching-by-region) if your players are spread across the world.

## Prediction is for a player's own moves

In state sync a player's own command can be [shown on the click](./state-sync#showing-a-player-s-own-moves-at-once), ahead of the room, and is corrected when the room answers. That is all `Predictor` does:

- **Other players are not predicted.** They are drawn where the room last said they were, a tick or so in the past, so two players can each see themselves reach a pellet first. The room decides, and the loser's screen is corrected.
- **A correction is a jump.** When a guess was wrong, the state changes to the room's in one step. Draw through an `Interpolator` and it becomes a short glide.
- **You write the game's rules twice**, or share them: `apply` and `tick` have to do what `onCommand` and `onTick` do, for one player. Where they differ, the room wins and the player sees a correction every time.
- **The lead is measured, not known.** How far ahead the prediction runs comes from how long recent commands took. When the connection's delay changes, it is off by a tick until the next few commands have come back.
- **There is no rollback of a whole simulation**, as fighting games do it. In lockstep an order waits for the next turn.

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

- **A snapshot is as trustworthy as the players who made it.** The room cannot check one against a simulation of its own. It keeps a snapshot only when every other connected player reported the same hash, and the client that loads it hashes it again, so one modified client cannot plant one. All the connected players together could. With a `hash` of your own in place of the built-in fingerprint, the check covers what your hash covers.
- **A player who is alone among absent opponents makes no snapshots.** The room goes on serving the last one everyone agreed on, and whoever returns runs the turns since.
- **Without `save` and `load`, rejoining replays the match from the first turn**, and takes longer the longer the match has run.
- **Every screen holds the whole game.** There is no hidden information, and a modified client can show what the game hides.
- **A desync is noticed, not settled.** The room knows that two simulations differed and at which turn, not which one is wrong.
- **Anyone the gateway lets through can read a room's recording**, seated or not.
- **A lockstep client does not follow a handover** to another room.
- **With the players' clock**, the game stands still while nobody is connected.

**What would lift it.** Snapshots: the client saves its simulation now and then, and a rejoin starts from the latest. Not built.

## Accounts, matchmaking and results

- **Accounts** do not verify email addresses, and send no email themselves: a [password reset by email](./accounts#by-email) needs a mail service of yours.
- **The matchmaker** matches by [skill](./matchmaking#matching-by-skill) and [region](./matchmaking#matching-by-region) but knows no parties and does not split players into teams. Each queue is one object, good for about a thousand requests a second. A queue that matches by skill or region looks at every pair of waiting players when one arrives, which is fine for hundreds waiting at once and slow for many thousands.
- **Delivery of match results and handovers is at least once.** After a crash at the wrong moment one can arrive twice. What a room owes and could not deliver is retried on its next event, not on a timer of its own.
- **A join token scoped to a name** opens both the room and the matchmaking queue of that name.

## Worlds

Seeing across a border is a recipe built on `signal`, not something a room does by itself, and a room cannot act on a neighbour's units.

## Clients

The full client is TypeScript, for browsers and Node. The clients for [Godot and Unity](./engines) connect, reconnect, keep the state and send commands, in event mode and state sync: what `Predictor`, `Interpolator` and `LockstepClient` do, a game in those engines has to do for itself for now. Neither has been used in a shipped game yet. The Unity client is tested on .NET and not inside the Unity editor, and a WebGL build needs a socket of its own.

There is no client for native code or other engines. [The protocol](../reference/protocol) is JSON over a WebSocket and is written down, so one can be written. For an engine whose WebSocket is not compressed there are [binary patches](../reference/protocol#binary-patches), with test vectors to check a decoder against.

## How far it has been tested

Tickflare is at 0.1. It has a test suite that runs against Cloudflare's own runtime, and one game running on it in production. It has been measured on Cloudflare itself four times, for a few minutes each time, [as described above](#the-same-rooms-on-cloudflare): enough to check the figures on this page, not a test of hours or of many rooms at once. The API can still change between versions; [Upgrading](../reference/upgrading) says what did.

**One thing from those runs is not explained.** In the first, two rooms were still counted as awake, and as sending messages, nine minutes after every player had disconnected; they stopped when the Worker was deleted. In the runs since, every room stopped within two seconds of its last player leaving, and it has not happened locally. We do not know the cause. What we have done is bound it: a ticking room now [closes a connection](./players) that has sent nothing for two minutes, not even a keepalive, so one whose other end is gone cannot keep a room awake for longer than that. A room that stays awake is billed for it, a little over half a cent an hour, so it is still worth looking at your rooms' active time in Cloudflare's dashboard now and then, and having [`onEmpty`](./rooms#when-a-room-is-over) delete rooms that are done.

## What would lift the most

In the order we would take them, by how much each removes for the work it needs:

1. **Lockstep, prediction and interpolation in the Godot and Unity clients.**
2. **Parties in matchmaking**: friends who queue together and stay together.
3. **A view for each of very many players.** Working out a view only for the players whose part of the state changed, where today every view is made on every tick, is what a room of a thousand players with a view each would need.

None of these is promised. They are here so that you can see where the edges are, and which of them are meant to move.
