# Worlds across rooms

One room is one thread with a limited amount of memory, and its state lives in one 2 MB row. A world bigger than that is cut into cells, with a room for each cell. A room hands a player to the next one when they cross a border, and rooms can tell each other what is near their shared edges so players see across.

## Naming cells

`shardFor(x, y, cellSize, world)` names the room responsible for a position, and `cellOf(roomId, world)` reads the cell back:

```ts
import { cellOf, shardFor } from "tickflare";

shardFor(1300, -20, 480, "overworld"); // "overworld_2_-1"
cellOf("overworld_2_-1", "overworld");  // { cx: 2, cy: -1 }
```

Positions may be negative. The names are valid room ids, so `/rooms/overworld_2_-1` reaches that cell's room.

## Handing players over

Set `rooms` to the namespace the cells live in, usually the room's own, and call `movePlayer` when a player crosses a border:

```ts
import { Room, shardFor, type Player } from "tickflare";

const CELL = 480;

export class Zone extends Room<State, Command, Env> {
  protected override tickRate = 20;
  protected override rooms = this.env.ZONES;

  protected override onTick(dt: number): void {
    // ...move things...
    for (const [id, unit] of Object.entries(this.state.units)) {
      const home = shardFor(unit.x, unit.y, CELL, "overworld");
      if (home === this.roomId) continue;
      delete this.state.units[id];
      this.movePlayer(id, home, unit); // `unit` travels with the player
    }
  }

  // The other side: a player handed over by a neighbour takes their seat here.
  protected override onArrive(player: Player, carry: unknown): void {
    this.state.units[player.id] = carry as Unit;
  }
}
```

What happens:

1. `movePlayer(playerId, toRoomId, carry)` gives up the player's seat as part of the hook's commit. Remove their part of the state yourself, as above.
2. After the hook commits, the room tells the other room, over RPC, that the player is coming and what they carry. The handover is saved first; if the other room can't be reached, it is tried again on this room's next event.
3. Once the other room has accepted, the player's connection here is closed with `CloseCode.Moved` and the new room's id.
4. The client reconnects by itself to the same URL with the new room id, asking the `token` function for a token for that room, and fires `moved(roomId)`. From the game's point of view, `state` just starts delivering the new room's view.
5. In the new room, `onArrive(player, carry)` runs instead of `onJoin`. A player handed over is always admitted, even if the room is full or reserved.

A player who isn't connected when they are handed over is sent on, with the same close code, when they next connect to the room they left. So is one who comes back within half a minute of being told, in case the news never reached them. After that, connecting there is an ordinary join again.

## Seeing across a border

Players near an edge should see what is just across it. Rooms can send each other **signals**:

```ts
protected override onTick(): void {
  // A few times a second, tell the room to the east what is near the shared border.
  if (this.tick % 5 === 0) {
    this.signal(eastRoomId, { units: unitsNearEastBorder(this.state) }, { onlyIfWatched: true });
  }
}

protected override onSignal(fromRoomId: string, data: unknown): void {
  // Part of the state, so players get it like anything else.
  this.state.beyond[fromRoomId] = (data as { units: Record<string, Unit> }).units;
}
```

- A signal goes out once, after the hook commits. It isn't saved and isn't retried, which suits snapshots that the next one replaces.
- With `onlyIfWatched`, a room that reports nobody connected is left alone for two seconds at a time, so an empty neighbour isn't kept awake by its neighbours.
- What arrives is a picture: a room can show a neighbour's units, not act on them.

The arena example does exactly this for dots within 60 units of a wall: walk into a wall and your dot is handed to the arena next door, and dots near a wall are visible from both sides.

## Rooms in more than one namespace

`rooms` covers the usual case where every cell is the same class. If handovers or signals also go to rooms of another class, override `roomsFor(roomId)` to say where each room lives:

```ts
protected override roomsFor(roomId: string) {
  return roomId.startsWith("dungeon_") ? this.env.DUNGEONS : this.env.ZONES;
}
```

## What is not there yet

- Seeing across a border is a recipe built on `signal`, not something a room does by itself.
- Handover is for event mode and state sync. A lockstep client doesn't follow a move.
- Delivery of a handover is at least once: after a crash at the wrong moment, the other room can be told twice.
