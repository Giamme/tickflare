# Changelog

## Unreleased

**A join is told as a join, not as the whole list of players.**

- Every join, drop and leave used to send every player the whole list of players. In a full room that is what a join cost: for a thousand players, a thousand frames of a thousand players each, and it is what broke rooms of that size when we measured on Cloudflare.
- This is version 3 of the protocol. A `presence` frame can now say who is new or different, in `set`, and who is gone, in `gone`, in place of `players`. `RoomClient` and the Godot and Unity clients ask for it; a client that asks for version 1 or 2 is sent the whole list as before. `PresenceFrame.players` is optional in the types for that reason.

**A ticking room closes connections that have gone silent.**

- A room ticks, and is billed, for as long as someone is connected. A connection whose other end is gone without the room being told kept it awake for nobody. A ticking room now closes a connection that has sent nothing for two minutes, neither a frame nor a keepalive, with the new close code 4100, `CloseCode.Silent`; the player is away as after any other drop, and a client that is there after all reconnects.
- `silentAfterMs` sets how long, and 0 turns it off. Tickflare's clients send a keepalive every 25 seconds. **A client of your own that sends no `ping` and can go two minutes without a command now has to send one**, or set a longer time in the room.

**Measured on Cloudflare.**

- `bench/` holds a Worker with a room in which everything moves on every tick, a script that plays in it, and one that asks Cloudflare's analytics what it counted. The workflow *Measure on Cloudflare* deploys the Worker under a key made for the run, measures, and deletes it.
- The limits and costs pages of the guide have what came back: rooms held their tick rate on a fifth of a processor, bytes on the wire were as measured locally, an idle room with five players was billed two thirds of a second in ninety, and a thousand players joining one room at once did not work.

**Matchmaking by skill and by region.**

- `Matchmaker` has a `ratingOf(player, request)` hook, asked once when a player starts waiting, and two settings: `ratingGap`, how far apart two players' ratings may be, and `ratingGapPerSecond`, how much that grows for each second a player has waited. A match is built around whoever has waited longest, from the players nearest to them.
- `regionWaitMs` matches a player only within their region for that long, and with anyone after. The region is the location hint the gateway worked out; `regionOf(player, request)` replaces it with your own.
- Both are off by default, and a queue without them matches exactly as before. A queue that is waiting for a gap to widen or a region wait to end sets an alarm for that moment, and hibernates until then.

**Ways back into an account.**

- **Recovery codes.** `POST /recovery-code` (`createRecoveryCode`) gives a signed-in player a code, shown once and stored as a hash. `POST /recover` (`recoverWithCode`) sets a new password with it, once. No email is involved.
- **Password reset by email.** With `sendPasswordReset` set, `POST /forgot` makes a token that lasts an hour and hands it to your function to send; `POST /reset` sets the new password. Tickflare sends no email itself. `Accounts.route` takes the Worker's `ctx` as a second argument, so that the email is sent after the answer.
- `AccountClient` has `createRecoveryCode`, `recover`, `forgotPassword` and `resetPassword`, and an account has `recoveryCode: boolean`.
- A new table, `tickflare_recovery`, is created on first use like the others. `ACCOUNTS_SCHEMA` has it, for those who apply the schema as a migration.

**Clients for Godot and Unity.**

- `clients/godot` is a client in GDScript for Godot 4, and `clients/unity` one in C# for Unity 2021.3 and later, as a package with no dependencies. Both connect and reconnect, keep the room's state up to date from JSON or binary patches, send commands and report the room's answer, and follow a player who is moved to another room. They ask for binary patches by default. Lockstep, prediction and interpolation remain in the TypeScript client only.
- Both are tested in CI against a Worker with two of the test rooms: the Godot client in Godot 4.5, the Unity client compiled as Unity compiles it and run on .NET.

**Arrays are patched element by element.** An array that changed was sent whole, however little of it changed, which made `units: Unit[]` the expensive way to write a state.

- A change to an array is now `[changes, length]` in a patch: the elements that changed, by index, and the array's new length. A unit that moves costs its new position, in an array as in an object. An array whose elements shifted, because one was taken out before the end, is still sent whole, so things that come and go are still better kept in an object keyed by id.
- This is version 2 of the protocol. A client asks for it with `v=2` in the query, and the room's `welcome` says which version it will speak. `RoomClient` asks; a client that does not, such as one from an earlier Tickflare still open in a player's tab, is sent whole arrays as before. Binary patches carry array changes too, under the same rule.
- `Patch` has a new member type, `ArrayPatch`. `applyPatch` and `diff` handle it.

**Binary patches, for clients whose WebSocket is not compressed.**

- A client that connects with `patches=b1` in the query is sent its `patch` frames as binary messages: every key by number after the first time, whole numbers as varints, numbers with one or two decimals as whole numbers of tenths or hundredths. Without compression they are a little over a third of the size of the JSON; with it, about 15% smaller. Everything else stays JSON, and so does a room that is not asked.
- The format is written down byte by byte in the protocol reference, with test vectors in `test/vectors/binary-patches.json` for checking a decoder in another language.
- `decodePatchFrame(bytes, keys)` is the reference decoder, and `RoomClient` has a `binary` option. Leave it off in a browser or in Node: the connection is compressed there, and JSON frames can be read in the developer tools.

**Prediction: a player's own move shows on the click.**

- **`Predictor`**, in `tickflare/client`, draws a player's unconfirmed commands over the room's state. You give it `apply`, which does to a draft of the state what the room's `onCommand` does, and it gives you `state` and `send`. When the room's state arrives the guess is made again from it; a refused command's effect is taken back. With a `tick` as well, for things a command sets in motion, it runs as many ticks ahead of the room as a command takes to come back, measured as it goes. It works in event mode too.
- **`room.unconfirmed`** lists the commands sent that `room.state` does not show yet. A command leaves it in the same step as the state changes to show it.
- **`produce(state, change)`** returns what `change` makes of a state without touching the state, copying only what changed.
- **In a ticking room a command is now answered with the tick that shows its effect**, after that tick's patch, not the moment it arrives. `room.send()` so resolves up to one tick later than before, and when it does `room.state` has the result, as it always had in event mode and as the documentation said it did. A refusal still comes at once.
- **The frame that first shows a player's command says so**, in a new `c` field on `patch` and `state` frames, and the `ack` of a ticking room says which `tick` the view is of. If you speak the protocol yourself, nothing you do today breaks: the `ack` frames still follow.
- **A room that comes back in the middle of a simulation welcomes its players again** on the connections they have, instead of sending them whole `state` frames at the next tick. The client takes the view from the `welcome` and rejects what was in flight with `disconnected`, since the room no longer knows of it.

**Lockstep snapshots: joining late no longer means running the match again.** A client that connected to a lockstep room rebuilt its simulation from turn 1 of the recording, every time, so a reload half an hour into a match ran eighteen thousand turns before it showed anything.

- **Give the simulation `save` and `load`** and the room keeps a snapshot a minute (`snapshotIntervalMs`; 0 for none). `save` returns the simulation as JSON, `load` rebuilds it. A client with no simulation starts from the latest snapshot and the turns since.
- **The players make the snapshots, and have to agree on them.** The room has no simulation to take one from. One client sends what `save` returned; the room keeps it once every other connected player has reported the same hash for that turn, and the client that loads it hashes it again before using it. A player alone in the room is taken at their word. A player whose opponents are away is not.
- **`fingerprint(value)`**, a new export, is the hash for this: the first 32 hex digits of the SHA-256 of a value's JSON. A simulation with `save` and no `hash` reports `fingerprint(save(sim))`, so desync detection now comes with `save` and needs no hash of your own. If old clients with a `hash` of their own are still playing, keep it in the new client until they are gone: two clients that hash differently look like a desync.
- **`seededRandom(seed).state`** is where a generator stands, as one whole number, and `seededRandom(state)` carries on from it. That is how `save` and `load` keep a simulation's randomness.
- **A client that drops and comes back with its simulation is sent only the turns it missed**, unless the room restarted meanwhile. It used to replay the recording from turn 1 then too.
- **After a restart a room resumes at its snapshot's turn or later**, so that the snapshot and the recording always fit together.
- **`stepThrough(sim, replay, simulation, from, upTo)`** advances a simulation you already have over a recording, for a replay viewer's play button.
- `GET …/replay` without a query is the whole recording, as before. A client that is catching up adds `since`, `epoch` and `snapshot`, and may be answered with the end of the recording: see `CatchUp` and the wire protocol in the reference. `POST …/snapshot` is how a client sends one. If you override `onHttp` in a lockstep room, pass on what is not yours with `super.onHttp(request, player)`.
- The view of a lockstep room has a new field, `snapshotEvery`.

**Event mode sends what changed, and a state may be longer than one row.**

- **A change in event mode is sent as a patch.** Every change used to send every player their whole view. Now each player is sent what the change did to their view, as ticking rooms already did, and a player whose view it did not touch is sent nothing. The client applies patches as before, so `room.state` and the `state` event are unchanged. Without a custom `view()` this holds after the room has slept as well; with one, the first change after a sleep sends whole views, since what each player was sent is remembered only in memory.
- **A patch sent outside a simulation says which view it is a patch of**, in a new `from` field. A client that holds another view reconnects rather than apply it. If you speak the protocol yourself, handle `patch` frames in event mode and check `from`: see the wire protocol in the reference.
- **A state longer than 1.5 MB is saved across rows**, as is a match recording on its way to R2. Cloudflare limits a row to 2 MB, and a state past that used to fail to save. A state that fits is still one row, which is what Cloudflare bills a save by.

What an event-mode change costs the room is about what it was: the state is still written whole, and it is now compared with what players hold instead of being sent to them. What it costs the players' connections is the size of the change instead of the size of the state.

**A hook costs what it touches.** Until now the whole state was turned into JSON after every hook, to see whether the hook changed anything and to be able to undo it. A command in a room with a large state cost as much as the state was large, however little it did.

The room now follows what a hook writes. Inside a hook, `this.state` and what is reached through it are proxies that note each change; undoing a refused hook replays the notes backwards, and the state becomes JSON only when it is saved or sent whole. `onTick` still runs on the plain state and is compared whole, since a simulation reads far more than it writes.

Measured locally, in a room asked for 10 ticks a second:

| In the room | Before | Now |
| --- | --- | --- |
| 5,000 units, 100 players, 480 commands a second | 6.3 ticks a second | 8.3 |
| 20,000 units, 20 players, 400 commands a second | 3.5 ticks a second | 8.7 |
| Event mode, 20,000 units: commands that change nothing, a second | 440 | 3,500 |

A command that changes the state in event mode costs what it did, since the whole state is still written and sent each time.

What changes for your code, in hooks other than `onTick`:

- An object read from the state is a proxy. It is not `===` to an object that did not come from the state, and `structuredClone` refuses it. `plain(value)`, a new export, gives the object underneath.
- Reach the state through `this.state` in every hook. A change made through a reference kept from an earlier hook is not followed: it is not sent until the next tick or save, and it stays if the hook is refused.
- A state that JSON cannot hold (a `BigInt`, a loop) is refused when it is written, in the hook that writes it.
- `trackChanges = false` puts a room back on the plain state, at the old cost.

**Rooms can be deleted, unused rooms no longer exist, and a match can play on without its players.** Until now every room a request ever reached stayed in your Cloudflare account for good, with its storage, and a match everyone left stood still.

- **`this.deleteRoom()`** ends a room: everyone still connected is disconnected with `CloseCode.Removed` and the reason `"room_deleted"`, and everything the room stored is deleted, a lockstep recording and tables of your own included, so that the Durable Object ceases to exist. A finished match and players on their way to another room are delivered first. The room id is free for a new room afterwards. Nothing calls it for you: decide when a room of yours is over, for instance when the last player leaves.
- **`onEmpty()`** is called when the last seat is given up, however its player went: left, stayed away, removed or moved to another room. It is the one place to say what becomes of an empty room.
- **`ticksWhileEmpty()`** lets a match play on with nobody connected, for results that have to stand whoever is still watching. Return true and the simulation runs for as long as `shouldTick()` says, through deploys and crashes. Such a room is awake and billed until it stops, so give it an end.
- **A room stores nothing until its first player is seated.** A refused join or a request to a room id nobody uses used to create the room's tables, which is enough for Cloudflare to keep the object. Rooms created by earlier versions are read as before.

**Lockstep rooms can sleep between turns.** Set `turnClock = "players"` on a `LockstepRoom` and it has no timer of its own: `LockstepClient` asks it for each turn as it falls due, one player's client at a time, with the others standing by to take over. The room closes as many turns as its own clock says have passed, so nobody can hurry the game or hold it back, and orders take effect as soon as they do with the room's clock. For the costs guide's RTS example it brings the bill from about $45 a month to about $11.

It is opt-in, and the default is unchanged. Two things differ with it: the game stands still while nobody is connected, and after a restart it skips ahead by up to `saveIntervalMs` of empty turns where the room's clock goes back by as much. `LockstepClient` needs nothing set; a client of your own has one command to send and one message to read, both in the protocol reference.

**Rooms write far fewer rows**, which is what Cloudflare bills storage by. Nothing changes in how rooms behave or in the API.

| | Before | Now |
| --- | --- | --- |
| A lockstep turn with an order in it | 4 rows | 1 |
| A save of a ticking room | 3 rows | 1 |
| Setting a timer again | 3 rows | 1 |

- **Lockstep** writes a turn to the recording as it closes, as before, but no longer saves the whole room with it. After a restart the room compares its saved state with the recording, and drops the orders that were waiting when it was last saved if the recording already has them. Orders are still recorded exactly once, and a turn is still in storage before any player is sent it.
- **The tick counter** is kept in the room's own row instead of a row of its own. Rooms saved by 0.1.0 are picked up where they were.
- **Timers:** only the timers that changed are written, instead of all of them, and the tables for timers and for the room's small values no longer keep a second index.

For the costs guide's RTS example, 500 half-hour lockstep matches a day, this takes the bill from about $173 a month to $45.

**Docs: the limits page is rewritten.** It gives each limit, where it comes from, what to do about it today and what would lift it, with measurements of how many players and units one room keeps up with. It also spells out one that is easy to miss: a room ticks only while a player is connected, so a match everyone leaves stands still until your room ends it.

**Docs:** the home page has a live demo for each sync mode with the real code behind it, and a cost estimator for your own numbers whose examples fill in every setting. The costs guide now counts what rooms write to storage, which its first version left out, says how far each kind of game can grow before a rented server costs less, and shows how the design of a game changes its bill.

## 0.1.0

The first version with documentation of its own, at the docs site built from [`docs/`](https://github.com/Giamme/tickflare/tree/main/docs). The API had grown one roadmap step at a time; this release smooths the places where that showed. It breaks code written for 0.0 in the ways listed below, each a small change.

### Upgrading from 0.0

**Rooms that hand players over or signal their neighbours** no longer implement `handOver()` and `relay()`. Set `rooms` to the namespace the other rooms live in instead:

```ts
// 0.0
protected override async handOver(roomId: string, playerId: string, carry: unknown) {
  const rooms = this.env.ROOMS;
  await rooms.get(rooms.idFromName(roomId)).arrive(roomId, playerId, carry);
}
protected override async relay(roomId: string, data: unknown) {
  const rooms = this.env.ROOMS;
  return rooms.get(rooms.idFromName(roomId)).hear(this.roomId!, data);
}

// 0.1
protected override rooms = this.env.ROOMS;
```

For rooms spread over more than one namespace, override `roomsFor(roomId)` to return the right one.

**Matchmakers** no longer implement `reserveRoom()`. Set `rooms` the same way:

```ts
// 0.1
export class Lobby extends Matchmaker<Env> {
  protected override rooms = this.env.ROOMS;
}
```

An override of `reserveRoom()` that does more first still works. Call `super.reserveRoom()` from it.

**`routeToMatchmaker`** takes `matchmakers` where it took `matchmaker`, matching `rooms` in `routeToRoom`.

**Lockstep turn entries** are spelled out: `{ player, input, event }` instead of `{ p, i, e }`. Change your simulation's `step`:

```ts
// 0.0
if (entry.e === "join") spawn(sim, entry.p);
else if (entry.i) order(sim, entry.p, entry.i);

// 0.1
if (entry.event === "join") spawn(sim, entry.player);
else if (entry.input) order(sim, entry.player, entry.input);
```

Recordings are now format version 2. `runReplay` still reads version 1 recordings stored by 0.0.

**The RPC methods rooms call on each other**, `arrive()`, `hear()` and `reserve()`, are now one method, `tickflare()`. You only called them from the overrides that are no longer needed. Don't give a method of your own that name.

**`RoomClient`, `LockstepClient` and `AccountClient` properties are read-only.** `state`, `seq`, `tick`, `tickRate`, `you`, `players` and `status` on `RoomClient`, and `sim`, `turn` and `ready` on `LockstepClient`, are getters now, as is `account` on `AccountClient`. Code that only read them is unaffected.

### New

- `RoomClient.on(event, listener)` listens for `state`, `presence`, `message`, `status` and `moved`, as well as the `on…` options do, and returns a function that stops listening.
- `findMatch` takes a `token` source, like `RoomClient` does.
- `findMatch` gives up on a queue that turns it away before the socket opens, instead of waiting for ever under Node.
- `CloseDetail` names the `{ code, reason }` that status callbacks receive.
- A room's `invited` lists the players a matchmaker reserved it for, so it can start once they are all there.
- Every protocol frame has a named type (`WelcomeFrame`, `PatchFrame`, …), and `act` resolves to the named `ActOutcome`.
- `npm install github:Giamme/tickflare` builds the package on install.
