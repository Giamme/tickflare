# Wire protocol

Rooms and clients talk over one WebSocket per player, in JSON text frames. `tickflare/client` speaks this protocol for you; this page is for writing a client in another language, and for reading frames in your browser's developer tools.

The protocol version is 1. Rooms announce it in their `welcome` frame.

## Connecting

Open a WebSocket to `/rooms/<roomId>` on your Worker, with whatever your gateway's `authenticate` expects, usually a join token: `wss://my-game.example/rooms/lobby?token=<token>`. If the gateway turns the request away, the upgrade fails with its HTTP status (401, 400). If the room turns the player away, the socket opens and is closed at once with one of the [close codes](#close-codes).

The room's first frame on every connection, reconnects included, is `welcome`.

## Client to room

| Frame | Meaning |
| --- | --- |
| `{ "t": "cmd", "id": 1, "data": … }` | A command. `data` is what `parseCommand` receives. `id` is any number unique on this connection, echoed in the answer |
| `{ "t": "leave", "id": 2 }` | Give up the seat. Answered like a command; on `ack` the room closes the connection |
| `ping` | A plain text keepalive. The runtime answers `pong` without waking the room |

Send a `ping` every 25 seconds or so. A connection that hears nothing back for a whole interval is best treated as dead.

## Room to client

| Frame | Meaning |
| --- | --- |
| `{ "t": "welcome", "v", "you", "seq", "tick", "tickRate", "state", "players" }` | First frame on every connection |
| `{ "t": "patch", "seq", "tick", "from"?, "p" }` | The state changed: only the difference from what this player last received |
| `{ "t": "state", "seq", "tick", "state" }` | The state changed, and this is the player's whole view: the room does not know what they hold, or the view is not an object |
| `{ "t": "presence", "players" }` | Someone joined, dropped or came back |
| `{ "t": "ack", "id", "seq" }` | The command or leave with this `id` was applied |
| `{ "t": "reject", "id", "reason" }` | The command or leave with this `id` was refused; nothing changed |
| `{ "t": "msg", "d" }` | A message the room sent with `send` or `broadcast` |
| `{ "t": "error", "reason" }` | The room couldn't read a frame at all |

Fields:

- `you` is this player's id. `players` is everyone with a seat, in join order: `[{ "id": "…", "connected": true }]`.
- `seq` counts changes to the state. A `state` or `patch` carries the `seq` of the change it brings the player up to. That need not be the next one: a ticking room sends one patch for all the changes since the last tick, and a change that leaves a player's view as it was is not sent to them at all.
- `from`, on a patch sent outside a simulation, is the `seq` of the view the patch is a patch of. A client whose view is of another `seq` has missed something. It must not apply the patch; the way back is to reconnect, which begins with a `welcome` and the whole view. A ticking room leaves `from` out.
- `tick` and `tickRate` are the ticks run so far and the ticks a second; both 0 in event mode.
- In event mode, the `ack` for a command comes after the `patch` or `state` frame it caused.
- `reject` reasons are what the room passed to `reject()`, or `invalid_command`, `internal_error` or `rate_limited`.
- `error` reasons are `invalid_json`, `invalid_message`, `message_too_large`, `binary_not_supported` or `rate_limited`.

The TypeScript types for every frame are exported from `tickflare` as `ClientMessage`, `ServerMessage` and the individual frame types (`WelcomeFrame`, `PatchFrame`, …).

## Patches

A patch mirrors the shape of the view it changes. For each key it holds one of:

- a nested patch object: go into that key and apply it there;
- `[value]`, a one-element array: set the key to `value`;
- `0`: delete the key.

Only plain objects are patched key by key. Arrays and other values are replaced whole.

```json
{ "units": { "u7": { "x": [12.5] }, "u3": 0 }, "phase": ["over"] }
```

This patch moves unit `u7`, removes unit `u3`, and sets `phase`. Apply patches in order to the last view you have. `applyPatch` and `diff` are exported from `tickflare` if you want the reference implementation.

## Close codes

| Code | Meaning | Reconnect? |
| --- | --- | --- |
| 4000 | Replaced: the same player opened a newer connection | no |
| 4001 | Room full | no |
| 4002 | Join refused by `onJoin`, or `not_invited` to a reserved room. The reason says why | no |
| 4003 | The seat is gone: `left`, `away`, or the reason given to `removePlayer` | no |
| 4004 | Moved to another room, whose id is the close reason | yes, to that room |

Any other close is unexpected: reconnect with a backoff. Codes 4000 to 4099 are reserved for the room.

## Matchmaking

A queue is a WebSocket to `/matchmaking/<queue>`, authenticated like a room. The client sends only `ping`s. When a match is ready the matchmaker sends

```json
{ "t": "match", "room": "6f1c…", "players": ["ada", "grace"] }
```

and closes the socket with code 1000. Connect to `/rooms/<room>` next.

## Lockstep

A [lockstep](../guide/lockstep) room uses the same frames. Its view is `{ seed, turn, entries, desync }`, delivered as patches, one per turn. Inputs are commands of the form `{ "k": "i", "d": <input> }`; simulation hashes are `{ "k": "h", "n": <turn>, "h": "<hash>" }`. The recording is a JSON `Replay` served at `/rooms/<roomId>/replay`.

A room with [`turnClock = "players"`](../guide/lockstep#letting-the-room-sleep-between-turns) says so in its view, `{ seed, turn, entries, desync, "clock": "players" }`, and works differently in two ways:

- **It closes turns when asked.** A client asks with the command `{ "k": "t" }`. The room closes the turns that are due by its own clock, which may be none, and acks the command either way. Ask once a turn while your requests are the ones being answered; otherwise ask when no turns have arrived for a turn and a half, plus four tenths of a turn for each connected player whose id sorts before yours.
- **Turns arrive as messages**, not in the view: `{ "t": "msg", "d": { "tickflare": "turns", "n": <first turn>, "c": <how many>, "e": [<entries>], "b": "<player>" } }`. Turns `n` to `n + c - 1` are closed; all are empty but the last, which has the entries `e`. `b` is the player whose request closed them, and is missing when they were closed for a player coming or going. A message may overlap turns you already have: apply the ones after your latest. If `n` is past the turn after your latest, load the recording again. State frames from such a room carry a turn number that is a checkpoint; take turns only from messages.
