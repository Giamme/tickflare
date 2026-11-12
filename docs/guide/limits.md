# Limits and known gaps

## Limits that come from Cloudflare

A room is one Durable Object, so it inherits their limits. The ones that matter most for games:

- **One thread per room.** A room handles one event at a time. That is what makes hooks simple and safe, and it also caps how much one room can do. A busy room spends its time in your hooks and in `view()`; keep them cheap.
- **2 MB of state.** The state is stored in one SQLite row, which Cloudflare limits to 2 MB. So is a replay, which passes through the room's database on its way to R2.
- **Memory.** An object has about 128 MB. Very large worlds belong [across several rooms](./worlds).
- **WebSockets, not UDP.** Every message is delivered in order, at the cost of head-of-line blocking on a bad connection. Fine for everything Tickflare aims at; not for shooters or fighting games.
- **Placement.** A Durable Object stays where it was created. Players far from a room have more latency.

Cloudflare's [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) page has the current numbers.

## Known gaps

These are things Tickflare doesn't do yet.

**State sync**
- There are no client-side prediction helpers: a player sees their own input one round trip later.
- When a tick runs late, the simulation slows down instead of catching up.
- In event mode the whole view is sent on every change, not a patch.

**Lockstep**
- A reconnecting client replays the whole recording from turn 1. There are no snapshots to shorten a long match.
- A desync tells you when two simulations differed, not which player is wrong.
- Anyone the gateway lets through can read a room's recording, seated or not.
- A lockstep client doesn't follow a handover to another room.

**Matchmaking and results**
- The matchmaker is first come, first served, with no skill ratings.
- Match history is one table keyed by match, without a per-player index.

**Accounts**
- There is no email verification and no password reset.

**Rooms and delivery**
- What a room owes (a finished match, a handover) and couldn't deliver is retried on the room's next event, not on a timer of its own.
- Delivery of match results and handovers is at least once: after a crash at the wrong moment, one can arrive twice.
- Rooms are never deleted. A room's storage, a lockstep recording included, stays until you remove it.
- Players dropped by a deploy are not reported: `onDisconnect` isn't called for them, though their seat timeout still starts.
- A join token scoped to a name opens both the room and the matchmaking queue of that name.

**Worlds**
- Seeing across a border is a recipe built on `signal`, not something a room does by itself, and a room can't act on a neighbour's units.
