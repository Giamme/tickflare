# Spectators

A spectator watches a room without playing in it: a friend who arrived after the match began, a caster, a player who is out and wants to see how it ends. They connect like a player and are sent a view that is kept up to date like a player's, but they take no seat, and the room can keep them a few seconds behind so that what they see is of no use to someone still playing.

```ts
export class Arena extends Room<State, Command> {
  protected override maxPlayers = 8;
  protected override maxSpectators = 50;
  protected override spectatorDelayMs = 5_000;
}
```

```ts
import { RoomClient } from "tickflare/client";

const room = new RoomClient<State>(url, { token, spectate: true });
room.on("state", (state) => render(state));
```

That is all of it for a room whose players see the whole state. `maxSpectators` is 0 by default, and a room takes no spectators until it says how many.

## What a spectator is

- **They have no seat.** They are not among `players`, they do not count towards `maxPlayers`, and `onJoin`, `onDisconnect`, `onReconnect` and `onLeave` never run for them. Nor do they keep a room going: `onEmpty` runs when the last seat is given up, whoever is watching, and a simulation does not tick for spectators alone. With no player connected, `ticksWhileEmpty()` decides whether it ticks, as ever.
- **They send nothing.** A command from a spectator is refused with the reason `spectator`, and so is a `leave`. `RoomClient` refuses both without sending them. A spectator who is done closes the connection.
- **They are sent the spectators' view**, as a whole view first and patches after, then who is here, and what the room sends with `broadcast()`. Not what it sends one player with `send()`.
- **One connection each.** A spectator who connects again replaces their earlier connection, as a player does. An identity that holds a seat can also watch, on a second connection, unless the room says no.
- **`this.spectators`** is how many are connected, should the game want to show it.

A spectator needs an identity like anyone else: the gateway's `authenticate` runs for them as for a player, and the room is told who is asking.

## Who may watch

`onSpectate(player)` runs when someone asks to watch. Throw `reject(reason)` to turn them away; their connection is closed with `CloseCode.JoinRejected` and your reason. `player.connected` is true when they also hold a seat and are connected to it.

```ts
protected override onSpectate(player: Player): void {
  // Nobody watches a match they are playing in.
  if (this.players.some((seated) => seated.id === player.id)) reject("playing");
  if (!this.state.public && !this.state.friends.includes(player.id)) reject("private");
}
```

The room turns spectators away on its own with `CloseCode.RoomFull` and `spectators_full` when `maxSpectators` are watching, and with `CloseCode.JoinRejected` and `no_spectators` when it takes none. `RoomClient` does not reconnect after either.

It is a hook like the others, so what it changes in the state is kept. There is no hook for a spectator who goes: count them with `this.spectators`, not in the state.

## What they see

By default a spectator sees the whole state. That is right for a room whose players see it too, and wrong for one that hides something: a spectator who sees every hand can tell a player what the others hold. So a room with a `view()` of its own takes no spectators until it says what they may see, with `spectatorView()`:

```ts
protected override view(player: Player): View {
  return { table: this.state.table, hand: this.state.hands[player.id] };
}

// Everyone who watches sees the table, and how many cards each player holds.
protected override spectatorView(): SpectatorView {
  const held = Object.fromEntries(Object.entries(this.state.hands).map(([id, hand]) => [id, hand.length]));
  return { table: this.state.table, held };
}
```

There is one view for all spectators, which is what lets the room work out what changed once and send everyone the same bytes. With a delay you can afford to show more: a hand that was played five seconds ago is no secret.

## Keeping them behind

`spectatorDelayMs` holds back everything a spectator is sent by that long: the view, who came and went, and broadcasts, in the order the players were sent them. Nothing of the room as it is now reaches a spectator, not even in the first frame.

- **The first to watch waits.** They are connected at once and told who they are and what the delay is, and their view arrives when it is that old. `room.state` is undefined until then, and `room.delayMs` says how long that is. Someone who starts watching while others already do is sent what the others have at once.
- **Coming back is quick.** The room keeps taking the spectators' view for 20 seconds after the last one left, so a spectator whose connection dropped carries on from where the others are, or where they would be, and not from a new wait.
- **How long.** Long enough that what a spectator knows is stale by the time they could pass it on. A few seconds for an arena; thirty or more for anything with fog of war, where knowing where an army was half a minute ago still helps.

The delay is the room's, and a spectator cannot shorten it. A player who wants to cheat with a second identity can still watch, late; `onSpectate` is where you refuse those you can tell.

### What the delay costs

- **Memory.** The room holds what its spectators have not been sent yet, as the text of the frames, and two copies of their view. For a view of 50 KB of which a twentieth changes twenty times a second, thirty seconds of frames are about 1.5 MB. If more than 16 million characters are waiting, the room logs an error and starts the spectators' view over, rather than run out of memory.
- **Time awake, in event mode.** A room that would sleep between moves stays awake for `spectatorDelayMs` after each change while someone watches, since it has frames to send then. [Awake is what a room is billed for.](./costs#what-awake-means) A ticking room is awake anyway.
- **One more view.** Each time it sends its players a change, the room works out the spectators' view and what changed in it, once for all of them: about what one more player with a `view()` costs, however many watch. Sending each spectator the frame costs what sending a player one does.

## Smoothing

A spectator's client is not told the [room's clock](./state-sync#keeping-time): it says which tick the room is on now and when the simulation stops, and a spectator is to learn neither ahead of the view. `BufferedInterpolator` then times the patches as they arrive, as it does against a room older than 0.2, and `room.serverTick()` is undefined. Motion is a little less even than a player's. `Interpolator` works as ever.

`Predictor` is for a player's own commands, and a spectator has none.

## When the room restarts

What is waiting to be sent to spectators is in memory. A room that wakes with spectators connected, after sleeping or after Cloudflare moved it, does not know what they hold or what was on its way to them, so it starts their view over: they are sent the whole view again, `spectatorDelayMs` after it woke. In a room that sleeps between moves that is a whole view for every move after a sleep, which is one more reason to keep a spectators' view small.

## The first deploy with spectators

Cloudflare gives a busy room new code [some minutes after](./limits#when-a-deploy-reaches-a-room) the Worker in front of it. Until then a match that began before the deploy runs on a room that knows nothing of spectators. Tickflare's gateway keeps such a room from seating someone who asked to watch: the room turns the request away, and the client keeps trying until the room has the new code. A match that is under way when you first ship spectators can be watched once Cloudflare's delay has passed.

## What is not there yet

- **Lockstep rooms take no spectators.** Their state is on the players' machines; a spectator would have to run the simulation from the orders, late. Not built.
- **The Godot and Unity clients cannot spectate.** [The protocol](../reference/protocol#spectators) for it is short.
- **One view for everyone who watches.** No view for each spectator, and no following one player's view.
- **Not measured on Cloudflare.** The tests run in Cloudflare's runtime on one machine. How many spectators a room carries next to its players has not been measured on the network; each costs what a player does to send to, and [those figures](./limits#how-much-one-room-can-do) are the ones to go by.
