# Changelog

## 0.1.0

The first version with documentation of its own, at the docs site built from [`docs/`](docs). The API had grown one roadmap step at a time; this release smooths the places where that showed. It breaks code written for 0.0 in the ways listed below, each a small change.

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

`handOver()` and `relay()` can still be overridden, for rooms spread over more than one namespace.

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

**`RoomClient` and `LockstepClient` properties are read-only.** `state`, `seq`, `tick`, `tickRate`, `you`, `players` and `status` on `RoomClient`, and `sim`, `turn` and `ready` on `LockstepClient`, are getters now. Code that only read them is unaffected.

### New

- `RoomClient.on(event, listener)` listens for `state`, `presence`, `message`, `status` and `moved`, as well as the `on…` options do, and returns a function that stops listening.
- `findMatch` takes a `token` source, like `RoomClient` does.
- `findMatch` gives up on a queue that turns it away before the socket opens, instead of waiting for ever under Node.
- `CloseDetail` names the `{ code, reason }` that status callbacks receive.
- `npm install github:Giamme/tickflare` builds the package on install.
