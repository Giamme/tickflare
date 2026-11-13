# Changelog

## Unreleased

**Rooms can be deleted, unused rooms no longer exist, and a match can play on without its players.** Until now every room a request ever reached stayed in your Cloudflare account for good, with its storage, and a match everyone left stood still.

- **`this.deleteRoom()`** ends a room: everyone still connected is disconnected with `CloseCode.Removed` and the reason `"room_deleted"`, and everything the room stored is deleted, a lockstep recording and tables of your own included, so that the Durable Object ceases to exist. A finished match and players on their way to another room are delivered first. The room id is free for a new room afterwards. Nothing calls it for you: decide when a room of yours is over, for instance when the last player leaves.
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
