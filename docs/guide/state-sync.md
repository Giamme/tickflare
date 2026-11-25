# State sync

State sync adds a simulation to a room. Set `tickRate` and write `onTick`; everything else about the room stays the same. Hooks, timers, seats and views work as in event mode.

```ts
import { Room, reject, type Player } from "tickflare";

interface Dot { x: number; y: number; tx: number; ty: number }
interface State { dots: Record<string, Dot> }
type Command = { type: "move"; x: number; y: number };

const SPEED = 120; // units a second

export class Arena extends Room<State, Command> {
  protected override tickRate = 20; // ticks a second
  protected override seatTimeoutMs = 30_000;

  protected initialState(): State {
    return { dots: {} };
  }

  protected parseCommand(raw: unknown): Command {
    const c = raw as Partial<Command> | null;
    if (c?.type === "move" && Number.isFinite(c.x) && Number.isFinite(c.y)) {
      return { type: "move", x: c.x!, y: c.y! };
    }
    return reject("invalid_command");
  }

  protected override onJoin(player: Player): void {
    this.state.dots[player.id] = { x: 200, y: 200, tx: 200, ty: 200 };
  }

  protected override onLeave(player: Player): void {
    delete this.state.dots[player.id];
  }

  // Commands only set a target. The simulation does the moving.
  protected onCommand(player: Player, command: Command): void {
    const dot = this.state.dots[player.id];
    if (!dot) reject("not_playing");
    dot.tx = command.x;
    dot.ty = command.y;
  }

  protected override onTick(dt: number): void {
    for (const dot of Object.values(this.state.dots)) {
      const dx = dot.tx - dot.x;
      const dy = dot.ty - dot.y;
      const distance = Math.hypot(dx, dy);
      const step = Math.min(distance, SPEED * dt);
      if (step > 0) {
        dot.x = Math.round((dot.x + (dx / distance) * step) * 10) / 10;
        dot.y = Math.round((dot.y + (dy / distance) * step) * 10) / 10;
      }
    }
  }
}
```

## What changes while a room ticks

**A patch for each tick, not for each change.** After each tick, every player gets a `patch` frame with only what changed in their own `view()` since the last one they received. The client applies it for you, so `room.state` and the `state` event work as before. In the arena example a tick is about 110 bytes of JSON, against 740 for the whole state, and the connection [compresses](./limits#bandwidth) what is sent.

**Commands show with the next tick.** A command is applied the moment it arrives, and its effect reaches clients with the next tick's patch. The room answers the command then, not before: `room.send()` resolves when `room.state` shows the result, a tick later at most. To show a player their own move sooner than that, [predict it](#showing-a-player-s-own-moves-at-once).

**Saving.** The state is written to storage every `saveIntervalMs` (5 seconds by default) and whenever the simulation stops, not on every change. A room torn down mid-simulation by a deploy or a crash resumes from the last write. Seats, timers, finished matches and handovers are still saved the moment they change, and the state is written with them, so storage never holds one without the other. The same goes for whatever `onTimer` does and for any hook that calls `this.saveNow()`. Which commands the room has handled is in the same write, so a room that resumes from a save knows which commands that save holds, and a client that reconnects [sends again](./client#when-the-connection-drops) only the ones it does not.

**Starting and stopping.** The simulation runs while at least one player is connected and `shouldTick()` returns true. When the last player disconnects, or `shouldTick()` returns false, it stops and the room can sleep. It starts again when both hold.

So a match that every player leaves stands still: it does not play on, and nothing ends it. Decide what that means for your game; [Rooms nobody is in](./limits#rooms-nobody-is-in) has the few lines it takes.

```ts
// Only simulate during the match. The lobby is in event mode.
protected override shouldTick(): boolean {
  return this.state.phase === "playing";
}
```

### Playing on with nobody connected

Some matches have to reach their end whoever is watching: a ranked match should have a winner even if the losing side closes the tab, and so should one the last player was only disconnected from. Return true from `ticksWhileEmpty()` and the simulation keeps running while `shouldTick()` does:

<<< @/snippets/onward/ranked.ts{32-44}

- **Give it an end.** The room is awake, and [billed](./costs), for every second it ticks, and nobody is there to notice one that never stops. End the match when it has a winner, cap how long it may run unattended, and delete the room when it is done.
- **It survives deploys and crashes.** While it ticks, alone or not, the room keeps an alarm thirty seconds ahead of itself. That keeps Cloudflare from taking it out of memory, and after a restart it is what starts the simulation again, from the last save.
- **Coming back is an ordinary join.** A player who connects again gets the state as it is now.

It is checked like `shouldTick()`, so it can depend on the state: `return this.state.ranked` plays ranked matches to the end and lets the others stand still.

### Keeping time

Ticks keep to a fixed clock. When the simulation starts, tick `n` falls due `n / tickRate` seconds later, whenever the one before it actually ran. A room that wakes late, because a tick or an event took long or the machine was busy, runs every tick that has come due since, each with the same `dt`, and sends one patch for all of them. So the game runs at the speed you set however the room is loaded, and a client can tell which tick the room is on.

- **The catch-up has a cap.** A room runs at most `maxCatchUpTicks` ticks back to back, 5 by default. After a longer stall it runs that many and lets the rest go: the clock moves on, and the game is that much behind the wall clock for good, instead of racing through a burst of ticks. Set it to 1 to never catch up.
- **Time spent stopped is not owed back.** When the simulation stops and starts again, its clock starts over from the tick it stopped at.
- **Saves are counted in ticks**, as before, so catching up does not change when they happen.
- **Lockstep is the exception to one patch:** a lockstep room that catches up still sends each turn in a frame of its own, since its players have to see every turn.

The room tells clients its clock, in `welcome` and in a [`clock` frame](/reference/protocol#the-room-s-clock) every five seconds and whenever it starts, stops or moves on. `room.serverTick()` turns that and the round trip into the tick the room is on at this moment, fraction included, which is what [interpolation](#smoothing-on-the-client) and [prediction](#showing-a-player-s-own-moves-at-once) need to line the screen up with the room:

```ts
const behind = room.serverTick()! - room.tick; // how many ticks the room is ahead of the latest patch
```

### Sending less often than you simulate

A tick does two things: it moves the game, and it sends each player what changed. They do not have to happen equally often. Fast things want a fine step, or a bullet passes through a wall between two ticks; what a player sees does not need more than 10 to 30 updates a second once the client [smooths](#smoothing-on-the-client) them. Set `patchRate` below `tickRate` and the room simulates at one rate and sends at the other:

```ts
export class Arena extends Room<State, Command> {
  protected override tickRate = 60;  // onTick runs 60 times a second
  protected override patchRate = 20; // a patch after every third tick
}
```

Each patch takes a player's view from the last one they were sent to now, so nothing that happened in between is lost; they only see it later, and never the ticks in between. What is saved is what a patch costs: running `view()` for every connected player, comparing each result with what that player holds, and the bytes. The more players a room has, the more of a tick that is. The tick itself costs what it did, and how much a room gains has not been [measured on Cloudflare](./limits#how-much-one-room-can-do) yet.

- **A command is acknowledged with the patch that shows it**, as always, so `room.send()` resolves up to a patch later than it would. A [`Predictor`](#showing-a-player-s-own-moves-at-once) draws the player's own moves at once either way.
- **Messages sent from `onTick`** with `send()` and `broadcast()` wait for that patch too, so that a message still arrives after the state it is about. Messages sent from other hooks go out at once, as before.
- **Nothing waits when the simulation stops**, or in a tick that removes a player: whatever is due goes out then.
- **A rate that does not divide `tickRate`** works: at 50 ticks and 20 patches a second, patches come two and three ticks apart in turn.
- **The client knows.** `room.patchRate` is the rate patches come at, which is `tickRate` for a room without a `patchRate`. `BufferedInterpolator` reads it and waits one patch longer; an `Interpolator` should glide for `1000 / room.patchRate` milliseconds.
- **A [lockstep](./lockstep) room ignores it:** every turn has to reach every player.

## Keeping ticks cheap

- **Key collections that come and go by id.** Patches go into objects key by key, and into arrays element by element. But an array whose elements shift, because one was taken out before the end, is sent whole.
- **Round positions.** One decimal is usually enough, and a third of the bytes on the wire: [what a moving unit costs](./limits#bandwidth).
- **Share the public part of views.** With many players, return the same object for the part of the view everyone sees. It is then diffed and serialised once per tick instead of once per player. See [State and views](./state-and-views#views-that-share-a-public-part).
- **Pick the lowest rate that feels right.** 10 to 20 ticks a second with client-side interpolation looks smooth for most games. Each tick costs CPU on the server and bandwidth for everyone. A game that needs a finer step than that can keep it and [send less often](#sending-less-often-than-you-simulate).

A room has a single thread. A room that is late now and then [catches up](#keeping-time); one whose ticks take longer than `1 / tickRate` seconds every time cannot, and runs slow.

## Smoothing on the client

Patches arrive 10 to 30 times a second; a screen draws 60 or more. `Interpolator` glides each moving thing from where it is drawn to its latest position over the time between two patches, so motion looks continuous:

```ts
import { Interpolator, RoomClient } from "tickflare/client";

const room = new RoomClient<State>(url, { token });
const glide = new Interpolator(1000 / 20, ["x", "y"]); // one patch at 20 a second

room.on("state", (state) => glide.update(state.dots));

function frame() {
  for (const id of Object.keys(room.state?.dots ?? {})) {
    const { x, y } = glide.at(id) ?? room.state!.dots[id]!;
    drawDot(x, y);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
```

Because it always starts from what is on screen, a late or bunched update bends the motion instead of making it jump. Use `room.patchRate` once connected to set the duration: `new Interpolator(1000 / room.patchRate, ["x", "y"])`. It is the room's `tickRate`, unless the room [sends less often than it ticks](#sending-less-often-than-you-simulate).

### Drawing at the room's pace

`Interpolator` adds almost no delay, but its pace is the network's: two patches that arrive together make a thing rush, and a late one makes it stop and lurch. `BufferedInterpolator` keeps the last few states of each thing by the tick they are of, and draws a moment a little behind the tick the room is on, from the [room's clock](#keeping-time), blending the two states on either side. Things then move at the room's own pace whatever the network does, and a patch that covers several ticks, after the room [caught up](#keeping-time), is spread over them. The same `update` and `at`, and the `RoomClient` to read the ticks from:

```ts
import { BufferedInterpolator, RoomClient } from "tickflare/client";

const room = new RoomClient<State>(url, { token });
const glide = new BufferedInterpolator(room, ["x", "y"], { snapDistance: 200 });

room.on("state", (state) => glide.update(state.dots));
// In the render loop, as before:
const { x, y } = glide.at(id) ?? room.state!.dots[id]!;
```

- **The delay** is two ticks behind the newest state it should have by now (`delayTicks`), plus a margin of twice the jitter it measures, which it keeps adjusting. Against a room with a `patchRate` the two ticks become one more than there are between two patches, so that there are always two states to draw between: four ticks at 60 ticks and 20 patches a second, which is 67 ms. `glide.delay` says what it is at, in ticks behind the room's clock, the network's own delay included. What it draws never goes back in time: when the delay grows, it waits for the clock.
- **When updates stop**, each thing carries on at its last speed for up to `maxExtrapolationTicks`, then stays where it got to. That is 3 ticks by default, and two more than there are between two patches against a room with a `patchRate`.
- **Jumps.** A respawn or a handover should not slide across the map. Call `glide.snap(id)` after the `update` that brought the jump, or set `snapDistance` and any change farther than that between two states in a row is one. Either way it is drawn when its tick comes.
- **Angles.** Name the fields that are angles in radians, `{ angles: ["heading"] }`, and they turn the short way round through ±π.
- **When the simulation stops**, it shows the latest state. Against a room older than 0.2, which does not say where its clock is, it times the patches as they arrive instead.

Which to use: `BufferedInterpolator` for other players and everything else that moves on its own, where an even pace matters more than a tenth of a second. `Interpolator` for a player's [own predicted moves](#showing-a-player-s-own-moves-at-once), which must answer at once, and where the delay would be felt. The arena example uses both.

## Showing a player's own moves at once

A player who clicks waits for the click to reach the room, for the next tick, and for the patch to come back before anything moves: a tenth of a second on a good connection, a quarter on a poor one. `Predictor` shows the move straight away and lets the room correct it:

```ts
import { Predictor, RoomClient } from "tickflare/client";

const room = new RoomClient<State, Command>(url, { token });
const predicted = new Predictor(room, {
  // What the room's onCommand does with this player's command.
  apply(state, command, you) {
    const dot = state.dots[you];
    if (dot) Object.assign(dot, { tx: command.x, ty: command.y });
  },
  // What the room's onTick does to this player's own dot.
  tick(state, you) {
    const dot = state.dots[you];
    if (dot) walk(dot, 1 / 20);
  },
});

canvas.onclick = (event) => predicted.send({ type: "move", x: event.offsetX, y: event.offsetY });
// When drawing: the player's own dot from the prediction, everyone else's from the room.
const mine = predicted.state?.dots[room.you!];
```

`predicted.state` is the room's state with this player's unconfirmed commands applied on top. Send through `predicted.send`, which resolves and rejects as `room.send` does.

- **`apply` is your `onCommand`, for one player.** It is handed a draft of the state to change in place, exactly as a hook changes `this.state`. The room's state is never touched, and parts the prediction did not change are the same objects as in `room.state`. Put the logic both sides share in one function and call it from both.
- **The room's word is final.** When its state arrives, the guess is thrown away and made again from it: commands the room has applied are part of the state now, a command it refused is dropped and its effect disappears, and commands still on their way are applied again. A wrong guess lasts until the room answers.
- **`tick` is for things a command sets in motion.** Without it the dot above would get its new target at once and still not move until the room's next patch. With it, the prediction runs `tick` as many times as the room will have ticked by the time a command sent now shows up there, so the dot sets off on the click and is drawn where the room will have it. How far ahead that is, `predicted.lead` ticks, is measured from the commands sent so far.
- **Predict what the player controls, and nothing else.** `tick` is called with the whole state, but where other players' dots will be is not this player's to know: leave them to the room and to `Interpolator`.
- **With `tick`, read `predicted.state` when you draw.** It moves on with time, between the room's frames too. `onState` tells you about the room's frames and about commands.

The arena example does this: the player's own dot is drawn from the prediction through an `Interpolator` of its own, the others from the room's state through a `BufferedInterpolator`.

It works in event mode as well, without `tick`: a piece placed on a board appears on the click and is taken back if the room says no.

```ts
const predicted = new Predictor(room, {
  apply(state, command, you) {
    if (state.board[command.cell] === null) state.board[command.cell] = state.marks[you];
  },
});
```

`produce(state, change)` is the function underneath, should you want it yourself: it returns what `change` makes of a state without touching the state, copying only what changed.

## Judging a command by what its player saw

What a player sees is the past. A patch takes time to arrive, and `BufferedInterpolator` draws a little behind on purpose, so a player who shoots at a runner aims at where the runner was a tenth of a second ago. By the time the shot reaches the room, the runner has moved on, and a room that checks the shot against `this.state` tells a player who aimed well that they missed. The usual answer is lag compensation: the room keeps the state of its last few ticks and checks the shot against the tick the player was looking at.

The room keeps the ticks, and looks one up with `stateAt`:

```ts
export class Arena extends Room<State, Command> {
  protected override tickRate = 60;
  protected override historyTicks = 12; // 200 ms at 60 ticks a second

  protected onCommand(player: Player, command: Command) {
    if (command.type === "shoot") {
      // Where everyone was when this player pulled the trigger, or where they are now.
      const then = this.stateAt(command.tick) ?? this.state;
      const target = then.dots[command.target];
      if (target && hits(then.dots[player.id], command.aim, target)) this.state.dots[command.target].hp -= 10;
    }
  }
}
```

The client says which tick it was drawing:

```ts
const glide = new BufferedInterpolator(room, ["x", "y"]);

canvas.onclick = (event) =>
  room.send({ type: "shoot", target: under(event), aim: angle(event), tick: glide.drawnTick() });
```

- **`stateAt(tick)` is the state as that tick left it**, which is what the patch of that tick showed. It is the whole state, not a player's view, and a copy of your own: each call parses that tick's JSON, so call it once for a command and keep what it gave. Changes go to `this.state`, as ever.
- **It returns `undefined` where there is nothing to look back at**: for a tick older than `historyTicks` or one that has not run, after the room restarted, and while the simulation is stopped, when players are shown every change as it is made and `this.state` is what they see. `?? this.state` covers them all.
- **`glide.drawnTick()` has a fraction**, since what is drawn lies between two ticks, and `stateAt` takes the nearest whole tick. At 60 ticks a second that is at most 8 ms off. Where it matters, look up `Math.floor(tick)` and `Math.ceil(tick)` and blend the positions as the client did.
- **Without `BufferedInterpolator`**, with `Interpolator` or in the Godot and Unity clients, what is drawn is on its way to the latest state: send `room.tick`.
- **`historyTicks` is how much lag you forgive, and how far a client can reach back.** The tick comes from the client, which can name an older one than it saw to hit a runner who has since taken cover. It cannot name one older than the room keeps, so keep no more than the delay of the slowest connection you mean to treat fairly: the client's `glide.delay`, in ticks, is a fair measure, and 150 to 250 ms is common. Check that `command.tick` is a number in `parseCommand`, as with everything else a client sends.
- **Only look back for what the player aimed at.** Their own position at that tick is where the room had them, which is not where their screen had them if their own moves are [predicted](#showing-a-player-s-own-moves-at-once). Most games take the shooter as the room has them now and rewind the targets.
- **What it costs.** No work in a tick: the room has each tick's JSON already. Memory for `historyTicks` states, and a parse of one state for every `stateAt`. See [the limits](./limits#a-room-s-state-saved-whole).
- **With a `patchRate`** the client draws between the ticks it was sent, in a straight line, while the room has what really happened at each tick in between. The two differ by as much as a thing turns between two patches.

The other side of it is the runner's: they are hit after they had, on their own screen, reached cover. Every game that compensates for lag makes that trade, and `historyTicks` is where you set how far it goes.

## What is not there yet

- Prediction is for a player's own commands. There is nothing for guessing where other players will be, and no rollback of a whole simulation.
