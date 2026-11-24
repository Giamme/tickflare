# State and views

The room's state is one JSON value that you own: `this.state`. Hooks change it in place, and the room saves it and sends it on. Players never see the state itself. Each player sees their **view** of it: by default the whole state, or whatever `view(player)` returns.

## Shaping the state

The state is stored and sent as JSON, so it can hold objects, arrays, strings, numbers, booleans and `null`. Not `Map`, `Set`, `Date` or class instances: they don't survive the trip. Store times as epoch milliseconds.

Two habits pay off, especially in [state sync](./state-sync), where only differences are sent:

- **Key collections that come and go by id.** Objects are compared key by key. An array is compared element by element, so a unit that moves costs its new position there too, as long as the elements keep their places. Take one out before the end and every element after it is in a new place: the array is sent whole. Keep units, players and projectiles in objects keyed by id; use arrays for what is a list, such as a path, a hand of cards or the cells of a board.
- **Round what you can.** A position with one decimal is shorter on the wire than a 17-digit float.

```ts
interface State {
  phase: "lobby" | "playing" | "over";
  units: Record<string, { x: number; y: number; owner: string; hp: number }>;
  hands: Record<string, Card[]>; // private: see below
  log: string[];
}
```

The state is saved whole, as JSON, in one row of the room's database. Cloudflare limits a row to 2 MB, so a longer state is spread over as many rows as it takes; [how large a state can get](./limits#a-room-s-state-saved-whole) is on the limits page. A room that needs megabytes is usually a sign that the world should be [split across rooms](./worlds).

## Hiding information with view()

Override `view(player)` to decide what each player may see. The room calls it for every player whenever the state changes, and sends each the result.

```ts
protected override view(player: Player): View {
  return {
    phase: this.state.phase,
    units: this.state.units,
    // Everyone sees how many cards the others hold, but only their own hand.
    myHand: this.state.hands[player.id] ?? [],
    handSizes: Object.fromEntries(
      Object.entries(this.state.hands).map(([id, hand]) => [id, hand.length]),
    ),
  };
}
```

This is the only reliable way to keep a secret in a multiplayer game. Anything you send to a client can be read by its player, whatever the page shows. Fog of war, hidden hands and secret roles belong in `view()`, not in the client.

`view()` runs as part of the event, so keep it cheap. It shouldn't change the state.

## Views that share a public part

In a ticking room with many players, building and comparing a view per player per tick is the main cost. When the views have a large public part, build it once and return the same object from every `view()` call:

```ts
#publicPart: Public | null = null;
#builtFor = -1;

protected override view(player: Player): View {
  // Rebuilt once per change of the state, then shared by every player's view.
  if (this.#builtFor !== this.seq) {
    this.#publicPart = buildPublicPart(this.state);
    this.#builtFor = this.seq;
  }
  return { world: this.#publicPart!, me: privatePart(this.state, player.id) };
}
```

When a top-level field of the view is the same object for several players, the room diffs and serialises it once per tick for all of them, not once per player. In a 20-player match with 500 units this took the cost of sending a tick from 85 ms to 10 ms.

## Views that did not change

By default the room builds every player's view on every change and every tick, and compares it with what that player holds, even when nothing they can see has moved. In a large world most players' views stay the same from one tick to the next. Give views a version, and the room skips those players: it does not call their `view()` or compare anything.

`viewVersion(player)` returns a number or a string that changes whenever what `view(player)` would return changes. The room remembers the version of the view each player was last sent, and builds the view again only when the version differs. A grid of cells, each with a counter that goes up whenever anything in it changes, gives such a version for a view by sight:

```ts
/** One counter per cell of the map, which goes up whenever anything in the cell changes. */
#cells = new Uint32Array(CELLS_ACROSS * CELLS_ACROSS);

protected override onTick(): void {
  for (const unit of movingUnits(this.state)) {
    this.#cells[cellOf(unit)] += 1; // the cell it leaves
    move(unit);
    this.#cells[cellOf(unit)] += 1; // the cell it enters
  }
}

protected override viewVersion(player: Player): number {
  // The counters only go up, so their sum changes whenever any of them does.
  let version = 0;
  for (const cell of cellsInSight(this.state, player.id)) version += this.#cells[cell];
  return version;
}
```

Three things to get right:

- **It is a version, not a flag.** The room compares it with the version of what the player was last sent, which can be several ticks back: after the room [catches up](./state-sync#keeping-time), or when the player could not be sent to. A flag for "changed this tick" misses changes; counters that only go up do not.
- **Everything `view()` reads counts**: what the player can see, and anything else it puts in, such as a score or the phase of the match. If the version stays the same when the view changes, the player is not sent the change until the version moves again.
- **It only saves work when most views stay the same.** Where everything a player can see moves on every tick, every version changes too, and the room builds every view as before. Counting the versions is a little extra work then, too small for us to measure.

A player who has just connected, or whom the room knows nothing about, is sent their whole view whatever the version says. Without `viewVersion`, or when it returns `undefined`, every view is built.

Measured with Wrangler's local runtime: a room ticking 10 times a second, with 1,000 players who each see the units near them out of 1,000, a grid of cells as wide as a player's sight, and the CPU time of the room's thread for each tick:

| Units that move on each tick | Without versions | With versions |
| --- | --- | --- |
| All of them | 94 ms | 94 ms |
| One in a hundred | 36 ms | 27 ms |
| None | 17 ms | 4.5 ms |

## What the client receives

Clients get the view, never the state. `room.state` on the client holds the latest view, and the `state` event fires on each change:

```ts
room.on("state", (view, seq) => render(view));
```

Every change makes a new object, but parts that didn't change are the same objects as before, so you can compare by reference: `previous.units === next.units` means no unit changed. That keeps re-rendering cheap in UI frameworks.

How a change travels depends on the mode:

- **Event mode** sends a patch after each change, with only what the change did to that player's view. A player whose view it did not touch is sent nothing. The client applies the patch for you.
- **State sync** sends a patch after each tick, with only what changed in that player's view since the last one they received. See [State sync](./state-sync).
- **Lockstep** sends the turn's inputs. Each client works out the state itself. See [Lockstep](./lockstep).

A player is sent their whole view when they connect, and again whenever the room cannot tell what they hold. With a custom `view()` that is the first change after the room has slept: what a player was sent is remembered only while the room is in memory. Without one, the room knows that everyone holds the state as it was saved, and goes on sending patches.

The format of `state` and `patch` frames is in the [wire protocol](../reference/protocol).
