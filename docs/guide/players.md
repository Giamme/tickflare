# Players and seats

A player in a room holds a **seat**. The seat is what the room remembers about them between connections: a player who closes the tab, loses their signal or reloads the page still has their seat, and comes back to it with the current state. A connection is just how a seated player is reached at the moment.

```ts
interface Player {
  id: string;        // from your authenticate function
  connected: boolean;
  name?: string;     // only in hooks that run for a connecting request
}
```

`this.players` lists everyone with a seat, in join order. Clients get the same list in `room.players` and in `presence` events, so a page can show who is in the room and who is away.

Someone who only watches has no seat: see [Spectators](./spectators).

## How a seat starts and ends

```
            onJoin                    onDisconnect
connect ───────────▶ seated, connected ───────────▶ seated, away
                          ▲                              │
                          └──────── onReconnect ─────────┤
                                                         │ seatTimeoutMs
          onLeave                                        ▼
leave() ──────────▶ seat given up ◀──────────── onLeave ─┘
```

**Joining.** The first time a player connects, they take a seat and `onJoin(player)` runs. Call `reject(reason)` there to turn them away: the connection is closed with `CloseCode.JoinRejected` and your reason. The room also turns players away on its own, before `onJoin`:

- with `CloseCode.RoomFull` and `room_full` when `maxPlayers` seats are taken;
- with `CloseCode.JoinRejected` and `not_invited` when a [matchmaker](./matchmaking) reserved the room for other players.

**Dropping and coming back.** When a seated player's last connection closes, `onDisconnect(player)` runs and they keep their seat. When they connect again, `onReconnect(player)` runs and they get the current state in the first frame. There is nothing to replay. Commands that were on their way when the connection dropped are the client's to sort out with the room: it learns which were handled and [sends the others again](./client#when-the-connection-drops), and the room applies none of them twice.

**Going silent.** A connection can die without the room being told: a phone out of signal, a laptop lid. While a room is ticking it closes any connection that has sent nothing for two minutes, not even the keepalive the client sends every 25 seconds, and the player is away as after any other drop. This matters for the bill as much as for the game: a room ticks, and is billed, for as long as it believes someone is connected. `silentAfterMs` changes the two minutes, and 0 turns it off.

**Leaving.** A player who calls `room.leave()` on the client gives up their seat. `onLeave(player)` runs first, with `player.connected` true. Tidy up their part of the state there, or call `reject(reason)` to make them stay (the client's `leave()` then rejects with that reason). When `onLeave` returns, the seat is gone and the connection is closed with `CloseCode.Removed` and `left`. A later connection from them is a new join.

**Timing out.** Set `seatTimeoutMs` and a player who stays away that long loses their seat as if they had left: `onLeave(player)` runs, with `player.connected` false, and the seat is freed with the reason `away`.

```ts
protected override seatTimeoutMs = 60_000;

// Runs when they leave, and when their minute is up.
protected override onLeave(player: Player): void {
  delete this.state.units[player.id];
}
```

::: tip Set seatTimeoutMs in real-time rooms
The default, `Infinity`, keeps a seat until the player leaves or is removed. That suits a game played over days. In anything real-time, closed tabs would otherwise fill the room for good.
:::

**Removing.** `this.removePlayer(playerId, reason)` takes a seat away from inside any hook. The player's connection is closed with `CloseCode.Removed` and `reason` (default `removed`). `onLeave` is not called: remove their part of the state yourself.

```ts
protected onCommand(player: Player, command: Command): void {
  if (command.type === "kick") {
    if (player.id !== this.state.host) reject("only_the_host_can_kick");
    delete this.state.units[command.target];
    this.removePlayer(command.target, "kicked");
  }
}
```

## Names

If your `authenticate` function returns a name as well as an id (`{ id, name }`), or the player is signed in with [Accounts](./accounts), `player.name` is set. It is only set in the hooks that run for a connecting request: `onJoin`, `onReconnect`, `onArrive` and `onHttp`. Keep it in your state if you need it later:

```ts
protected override onJoin(player: Player): void {
  this.state.names[player.id] = player.name ?? "Guest";
}
```

## One connection per player

A player has at most one connection to a room. If they open a second tab, the newer connection wins and the older one is closed with `CloseCode.Replaced`. The client does not reconnect after that, so the old tab stays quiet instead of fighting the new one.

## Rate limits and message size

Each player may send `maxCommandsPerSecond` frames a second (default 30), with a burst of the same size. Frames over the limit never reach `parseCommand`: commands are refused with `rate_limited`. The allowance belongs to the player, not the connection, so reconnecting doesn't refill it.

Frames longer than `maxMessageLength` characters (default 16,384) are refused too. Raise it if your commands are large; keep it low otherwise, since everything a client sends is untrusted.

## Close codes

When a room closes a connection on purpose, it uses one of these codes. The client stops reconnecting after the first four.

| Code | Name | Meaning |
| --- | --- | --- |
| 4000 | `CloseCode.Replaced` | The same player opened a newer connection |
| 4001 | `CloseCode.RoomFull` | Every seat is taken |
| 4002 | `CloseCode.JoinRejected` | `onJoin` refused the player, or the room is reserved for others. The reason says why |
| 4003 | `CloseCode.Removed` | The seat is gone: `left`, `away`, or the reason given to `removePlayer` |
| 4004 | `CloseCode.Moved` | The player was [handed to another room](./worlds), named in the reason. The client follows |
