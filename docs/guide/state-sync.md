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

**Saving.** The state is written to storage every `saveIntervalMs` (5 seconds by default) and whenever the simulation stops, not on every change. A room torn down mid-simulation by a deploy or a crash resumes from the last write. Seats, timers, finished matches and handovers are still saved the moment they change, and the state is written with them, so storage never holds one without the other. The same goes for whatever `onTimer` does and for any hook that calls `this.saveNow()`.

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
- **It survives deploys and crashes.** While it ticks alone the room keeps an alarm twenty seconds ahead of itself. That keeps Cloudflare from taking it out of memory, and after a restart it is what starts the simulation again, from the last save.
- **Coming back is an ordinary join.** A player who connects again gets the state as it is now.

It is checked like `shouldTick()`, so it can depend on the state: `return this.state.ranked` plays ranked matches to the end and lets the others stand still.

## Keeping ticks cheap

- **Key collections by id.** Patches go into objects key by key; an array is sent whole when anything in it changes.
- **Round positions.** One decimal is usually enough, and a third of the bytes on the wire: [what a moving unit costs](./limits#bandwidth).
- **Share the public part of views.** With many players, return the same object for the part of the view everyone sees. It is then diffed and serialised once per tick instead of once per player. See [State and views](./state-and-views#views-that-share-a-public-part).
- **Pick the lowest rate that feels right.** 10 to 20 ticks a second with client-side interpolation looks smooth for most games. Each tick costs CPU on the server and bandwidth for everyone.

A room has a single thread. If a tick takes longer than `1 / tickRate` seconds, the simulation slows down rather than skipping ahead.

## Smoothing on the client

Ticks arrive 10 to 30 times a second; a screen draws 60 or more. `Interpolator` glides each moving thing from where it is drawn to its latest position over one tick, so motion looks continuous:

```ts
import { Interpolator, RoomClient } from "tickflare/client";

const room = new RoomClient<State>(url, { token });
const glide = new Interpolator(1000 / 20, ["x", "y"]); // one tick at 20 ticks a second

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

Because it always starts from what is on screen, a late or bunched update bends the motion instead of making it jump. Use `room.tickRate` once connected to set the duration: `new Interpolator(1000 / room.tickRate, ["x", "y"])`.

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

The arena example does this: the player's own dot is drawn from the prediction through an `Interpolator` of its own, the others from the room's state.

It works in event mode as well, without `tick`: a piece placed on a board appears on the click and is taken back if the room says no.

```ts
const predicted = new Predictor(room, {
  apply(state, command, you) {
    if (state.board[command.cell] === null) state.board[command.cell] = state.marks[you];
  },
});
```

`produce(state, change)` is the function underneath, should you want it yourself: it returns what `change` makes of a state without touching the state, copying only what changed.

## What is not there yet

- Prediction is for a player's own commands. There is nothing for guessing where other players will be, and no rollback of a whole simulation.
- When a tick runs late, the simulation slows down instead of catching up.
