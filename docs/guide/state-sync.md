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

**A patch for each tick, not for each change.** After each tick, every player gets a `patch` frame with only what changed in their own `view()` since the last one they received. The client applies it for you, so `room.state` and the `state` event work as before. In the arena example a tick is about 110 bytes on the wire, against 740 for the whole state.

**Commands take effect with the next tick.** A command is applied the moment it arrives and acknowledged at once, but its effect reaches clients with the next tick's patch. So `room.send()` resolving no longer means `room.state` already shows the result.

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
- **Round positions.** One decimal is usually enough and much shorter on the wire.
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

## What is not there yet

- There are no client-side prediction helpers: a player sees the effect of their own input one round trip later. For many games, interpolating everything and showing the player's own target straight away (as the arena example does with the click marker) is enough.
- When a tick runs late, the simulation slows down instead of catching up.
