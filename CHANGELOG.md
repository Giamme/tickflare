# Changelog

## Unreleased

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
