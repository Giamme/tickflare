# Lockstep

In lockstep the room never runs the game. It checks each player's inputs, puts them in order, cuts them into numbered turns and sends every player the same turns. Each client runs the same deterministic simulation over those turns, so everyone ends up in the same state without the state ever crossing the network.

Bandwidth depends on how often players act, not on how many units exist. That is what real-time strategy games need, and it gives you replays for free: a match is its seed plus its inputs.

## The room

```ts
import { LockstepRoom, reject } from "tickflare";

export type Order = { type: "move"; x: number; y: number };

export class Skirmish extends LockstepRoom<Order> {
  protected override tickRate = 10; // turns a second
  protected override seatTimeoutMs = 60_000;

  // Every client will feed what this returns to its simulation, so be strict.
  protected parseInput(raw: unknown): Order {
    const input = raw as Partial<Order> | null;
    if (input?.type !== "move" || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      return reject("invalid_order");
    }
    return { type: "move", x: Math.round(input.x!), y: Math.round(input.y!) };
  }
}
```

That is the whole server side. `LockstepRoom` is a `Room`, so the gateway, seats, `seatTimeoutMs`, `maxPlayers`, matchmaking and match results work as for any other room. Two more options:

- `maxInputsPerTurn` (default 32): inputs one player may send within a single turn. More are refused.
- `onDesync(turn)`: called when two players report different hashes for the same turn.

If you override `onJoin`, `onDisconnect` or `onReconnect`, call `super` so the event still reaches the turn stream.

## The client

```ts
import { LockstepClient, seededRandom, type TurnEntry } from "tickflare/client";
import type { Order } from "../src/skirmish";

interface World {
  random: () => number;
  squads: Record<string, { x: number; y: number; tx: number; ty: number }>;
}

const client = new LockstepClient<Order, World>(`wss://${location.host}/rooms/skirmish`, {
  token: accounts.tokenSource,

  create: (seed) => ({ random: seededRandom(seed), squads: {} }),

  step(world, entries: TurnEntry<Order>[], turn) {
    for (const entry of entries) {
      if (entry.event === "join") {
        world.squads[entry.player] = { x: 100, y: 100, tx: 100, ty: 100 };
      } else if (entry.event === "leave") {
        delete world.squads[entry.player];
      } else if (entry.input) {
        const squad = world.squads[entry.player];
        if (squad) Object.assign(squad, { tx: entry.input.x, ty: entry.input.y });
      }
    }
    for (const squad of Object.values(world.squads)) {
      squad.x += Math.sign(squad.tx - squad.x);
      squad.y += Math.sign(squad.ty - squad.y);
    }
  },

  // Optional: lets the room notice when two clients' simulations disagree.
  hash: (world) => JSON.stringify(world.squads),
  onTurn: (world) => render(world),
});

canvas.addEventListener("click", (event) => {
  client.input({ type: "move", x: event.offsetX, y: event.offsetY });
});
```

`step` receives each turn's entries in the order every client must apply them. An entry is a player's input, or a player joining, leaving, dropping or coming back:

```ts
interface TurnEntry<Input> {
  player: string;
  input?: Input;
  event?: "join" | "leave" | "disconnect" | "reconnect";
}
```

The simulation lives in `client.sim` once it has caught up (`client.ready`), and `client.turn` is the turn it is at.

## How turns work

- **Turns.** `tickRate` times a second the room closes a turn: whatever inputs arrived since the last one, in arrival order. It does so on a timer of its own, or [when a player's client asks](#letting-the-room-sleep-between-turns). Every player gets the same turn. An input takes effect in the turn the room puts it in, for everyone at once, so there is nothing to predict or roll back.
- **Players are part of the stream.** Joining, leaving, dropping and reconnecting arrive as entries with `event` set, so every simulation sees them at the same turn. Every way of losing a seat (leaving, `seatTimeoutMs`, `removePlayer`) arrives as `leave`.
- **Even pacing.** A real network delivers turns in fits. The client holds one turn in reserve (`bufferTurns`, default 1) and advances at the room's pace, so movement doesn't stutter. An order is visible one to two turns after it reaches the room; show the player their click straight away.
- **Catching up.** On every connect and reconnect, the client loads the room's recording, rebuilds its simulation from turn 1, then follows the live turns. A reload mid-match ends in the same state as everyone else's.
- **Desyncs.** If you pass `hash`, clients report it every `hashEvery` turns (default 20). When two players disagree about the same turn, the room records it in the view's `desync`, `onDesync(turn)` runs on the server, and every client's `onDesync` fires. One player alone can't trigger it.

## Letting the room sleep between turns

A lockstep room closes its turns on a timer, so it is awake, and billed, for as long as the match lasts, even while nobody gives an order. One line changes that:

<<< @/snippets/asleep/skirmish.ts{11}

With `turnClock = "players"` the room has no timer. `LockstepClient` keeps time for it: one player's client asks the room for each turn as it falls due, and the room closes it and goes back to sleep. Nothing changes in your simulation or in the page.

- **The room still decides what time it is.** A request closes as many turns as the room's own clock says have passed, never more. Asking more often does not make the game run faster, and one player cannot hold it back while anyone else is connected.
- **One client asks at a time.** The one whose request closed the latest turn keeps asking, once a turn. The others stand by, each waiting a little longer than the one before it, and the first of them takes over if turns stop arriving: a closed tab, a dropped connection, a tab in the background that the browser has slowed down.
- **Orders are as fast as before.** An order still waits for the next turn to close, half a turn on average. Measured on one machine with `bufferTurns: 0`, an order took effect 57 ms after it was sent on average, with the room's clock and with the players' alike.
- **Players coming and going do not wait.** A join, a leave, a drop or a return is put in a turn at once, in the same write as the change of seats.

Three things are different, and worth knowing before you choose it:

- **The game stands still while nobody is connected.** With no one to ask, no turns close. When someone comes back, the room closes at most thirty turns, three seconds' worth at ten a second, and carries on from there.
- **After a restart it skips ahead instead of going back.** The turn counter is saved every `saveIntervalMs`. With the room's clock a restart goes back by up to that much of empty turns; with the players' it passes over that many, so that no number a connected player has seen is used twice.
- **It costs requests instead of time.** Each request for turns is a message to the room. [What it costs](./costs#lockstep-let-the-room-sleep) has the sums: for the guide's RTS example it is about a quarter of the price.

The turns themselves arrive as messages instead of in the view; `LockstepClient` handles both. If you write your own client, [the protocol](../reference/protocol#lockstep) has the frames.

## Making the simulation deterministic

Every client must compute exactly the same thing from the same turns. In practice:

- **Take randomness only from `seededRandom(seed)`**, never from `Math.random()`. Create one generator in `create` and keep it in the simulation.
- **Don't read the clock.** Time is the turn number.
- **Prefer whole numbers.** `+ - * /` and `Math.sqrt` give the same result everywhere. `Math.sin`, `Math.cos` and other transcendental functions are not guaranteed to, across browsers and machines.
- **Iterate in a fixed order.** Object keys keep insertion order, which is the same on every client because joins arrive in the same order. Don't iterate a `Set` of things that were added in different orders on different clients.
- **Keep rendering out of `step`.** Draw from `onTurn`, and interpolate between turns for smooth motion.

## Replays

Every turn in which something happened is stored in the room. The recording is served at `/rooms/<id>/replay`, behind the same `authenticate` as the WebSocket, and `runReplay` plays one back with the same simulation:

```ts
import { runReplay, type Replay } from "tickflare/client";

const replay = (await (await fetch(`/rooms/${id}/replay?token=${token}`)).json()) as Replay<Order>;
const world = runReplay(replay, { create, step });            // the end of the match
const halfway = runReplay(replay, { create, step }, Math.floor(replay.turn / 2));
```

When the match ends, call `this.finishMatch(result)` from a hook. With `matchBucket` set, the recording is stored in R2 as the match's replay. See [Match results and replays](./match-results).

## What is not there yet

- A reconnecting client replays the whole recording from turn 1. There are no snapshots to shorten a long match.
- A desync tells you that and when two simulations differed, not which player is wrong.
- A lockstep client doesn't follow a [handover](./worlds) to another room.
