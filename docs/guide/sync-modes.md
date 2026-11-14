# Choosing a mode

Every Tickflare room keeps its players in sync in one of three ways. The room kernel underneath is the same: seats, timers, persistence, identity, matchmaking and results work identically in all three. What differs is when the room runs your code and what it sends.

## Event mode

The default. The room has no loop: it runs a hook when something happens (a command, a join, a timer) and sleeps in between. After each change it sends every player what changed in their view.

**Pick it for** turn-based games, card and board games, word games, lobbies, and anything asynchronous. The room costs nothing while it waits, so a game played over a week is as cheap to host as one played in ten minutes.

**Real-time without a loop** works too, if the game advances on timers: a quiz that moves to the next question every 15 seconds, an auction with a closing time.

## State sync

Set `tickRate` and the room calls `onTick(dt)` that many times a second while players are connected. After each tick it sends each player a patch with only what changed in their view.

**Pick it for** action games, co-op, `.io`-style games, and anything where the server must simulate continuously and hide information (fog of war). The server is the only one running the game, so clients can't cheat on its rules.

**Costs**: the room is awake for as long as the simulation runs, and bandwidth grows with how much changes per tick. Up to a few hundred moving things per room works well. A player's own move shows a round trip later, unless you [predict it](./state-sync#showing-a-player-s-own-moves-at-once).

See [State sync](./state-sync).

## Lockstep

Extend `LockstepRoom`. The room doesn't run the game at all: it checks inputs, cuts them into numbered turns, and sends the same turns to everyone. Each client runs the same deterministic simulation over them.

**Pick it for** real-time strategy and other games with thousands of units, where sending the state would cost too much. Bandwidth depends on how often players act, not on how big the game is. Matches are recorded for free as their input log, so replays come with it.

**Costs**: your simulation must be bit-for-bit deterministic on every client. Every client sees everything, so there is no hidden information unless you build it into the client. A player who joins late starts from a snapshot that the other players' clients made, so your simulation has to be able to save and load itself; without that, they replay the match from the start.

See [Lockstep](./lockstep).

## At a glance

| | Event mode | State sync | Lockstep |
| --- | --- | --- | --- |
| Game runs on | the server, per event | the server, per tick | every client |
| Sent to players | patch per change | patch per tick | inputs per turn |
| Hidden information | yes, with `view()` | yes, with `view()` | no |
| Room sleeps | between events | when the simulation stops | never while players are connected, or [between turns](./lockstep#letting-the-room-sleep-between-turns) if players keep time |
| Scales with | how often things happen | how much changes per tick | how often players act |
| Typical rate | — | 10–30 ticks a second | 5–15 turns a second |

## Switching within a match

`shouldTick()` lets one room be in event mode in the lobby and in state sync during the match:

```ts
protected override tickRate = 20;

protected override shouldTick(): boolean {
  return this.state.phase === "playing";
}
```

While it returns false the room behaves exactly as in event mode, and can sleep.
