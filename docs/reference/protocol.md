# Wire protocol

Rooms and clients talk over one WebSocket per player, in JSON text frames. `tickflare/client` speaks this protocol for you; this page is for writing a client in another language, and for reading frames in your browser's developer tools.

The protocol is at version 2. A client says which version it speaks with `v` in the query when it connects, `?v=2`, and the room's `welcome` frame says which one it will use on that connection: the one asked for, or its own latest if that is older. A client that does not say is spoken to in version 1, so a client written for version 1 goes on working. Version 2 added [array patches](#patches).

Offer `permessage-deflate` when you connect, as browsers do. Cloudflare then compresses the frames, which makes patches of rounded numbers four to five times smaller on the wire; a client that does not offer it is sent them as they are. If your WebSocket library cannot do that, ask for [binary patches](#binary-patches) instead, which are a little over a third of the size of the JSON ones.

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
| `{ "t": "patch", "seq", "tick", "from"?, "c"?, "p" }` | The state changed: only the difference from what this player last received |
| `{ "t": "state", "seq", "tick", "c"?, "state" }` | The state changed, and this is the player's whole view: the room does not know what they hold, or the view is not an object |
| `{ "t": "presence", "players" }` | Someone joined, dropped or came back |
| `{ "t": "ack", "id", "seq", "tick"? }` | The command or leave with this `id` was applied, and the view the player holds shows it |
| `{ "t": "reject", "id", "reason" }` | The command or leave with this `id` was refused; nothing changed |
| `{ "t": "msg", "d" }` | A message the room sent with `send` or `broadcast` |
| `{ "t": "error", "reason" }` | The room couldn't read a frame at all |

Fields:

- `you` is this player's id. `players` is everyone with a seat, in join order: `[{ "id": "…", "connected": true }]`.
- `seq` counts changes to the state. A `state` or `patch` carries the `seq` of the change it brings the player up to. That need not be the next one: a ticking room sends one patch for all the changes since the last tick, and a change that leaves a player's view as it was is not sent to them at all.
- `from`, on a patch sent outside a simulation, is the `seq` of the view the patch is a patch of. A client whose view is of another `seq` has missed something. It must not apply the patch; the way back is to reconnect, which begins with a `welcome` and the whole view. A ticking room leaves `from` out.
- `tick` and `tickRate` are the ticks run so far and the ticks a second; both 0 in event mode.
- An `ack` means that the view the player holds shows the command. In event mode it comes straight after the `patch` or `state` frame the command caused. In a room that is ticking, a command's effect is sent with the next tick, and so is its `ack`, after that tick's `patch`; the `ack` then carries the `tick` the view is of, since a tick that leaves a player's view as it was sends them no patch. A `leave` is always answered at once, after any acks still owed.
- `c`, on a `patch` or `state`, is the `id` of the latest of this player's own commands that the frame is the first to show. That command and every earlier one have been applied; their `ack` frames follow. A client that draws its own commands ahead of the room drops them at this frame, in the same step as it takes the new state, so that none is shown twice or not at all.
- A `welcome` can arrive on a connection that is already open. The room was taken out of memory in the middle of a simulation and has resumed from its last save: take the whole view from it, and give up the commands you were waiting to hear about.
- `reject` reasons are what the room passed to `reject()`, or `invalid_command`, `internal_error` or `rate_limited`.
- `error` reasons are `invalid_json`, `invalid_message`, `message_too_large`, `binary_not_supported` or `rate_limited`.

The TypeScript types for every frame are exported from `tickflare` as `ClientMessage`, `ServerMessage` and the individual frame types (`WelcomeFrame`, `PatchFrame`, …).

## Patches

A patch mirrors the shape of the view it changes. For each key it holds one of:

- a nested patch object: go into that key and apply it there;
- `[value]`, a one-element array: set the key to `value`;
- `[changes, length]`, a two-element array, in version 2 only: the key holds an array. `length` is how long it now is: drop what is past it. `changes` is an object that has, by index, what to do with each element that changed, in one of these same three forms. An element is never deleted from the middle: an array whose elements shifted is sent whole, as `[value]`;
- `0`: delete the key.

```json
{ "units": { "u7": { "x": [12.5] }, "u3": 0 }, "phase": ["over"], "path": [{ "2": [9] }, 3] }
```

This patch moves unit `u7`, removes unit `u3`, sets `phase`, and makes `path` three long with 9 as its last element. A client in version 1 is sent the same change with the whole of `path` in it: `"path": [[4, 7, 9]]`. Apply patches in order to the last view you have. `applyPatch` and `diff` are exported from `tickflare` if you want the reference implementation.

## Binary patches

A client can ask for its patches in binary: add `patches=b1` to the query when it connects, `wss://my-game.example/rooms/lobby?token=<token>&v=2&patches=b1`. Every `patch` frame then arrives as a binary WebSocket message in the format below. Everything else stays as it is: `welcome`, `state`, `presence`, `ack`, `reject`, `msg` and `error` are JSON text messages, and so is everything the client sends. A patch that cannot be said in binary is sent as JSON, so read whichever arrives: a text message is JSON, a binary message is a patch.

It is for clients whose WebSocket is not compressed. Compressed, the JSON is already smaller than these frames are uncompressed; [the measurements](../guide/limits#bandwidth) are in the guide. `RoomClient` asks for binary with its `binary` option, and `decodePatchFrame`, exported from `tickflare` and `tickflare/client`, is the reference decoder.

**Whole numbers** are written as varints: seven bits to a byte, the lowest seven first, and the top bit of every byte but the last set. 300 is `ac 02`. They go up to 2^53 - 1, in at most eight bytes.

**A string** is its length in bytes as a varint, then its UTF-8.

**A frame** is, in order:

| Bytes | What |
| --- | --- |
| `b1` | Says that this is a patch in this format |
| one byte of flags | 1: `from` follows. 2: `c` follows. 4: forget the keys you know |
| varint | `seq` |
| varint | `tick` |
| varint | `from`, if its flag is set |
| varint | `c`, if its flag is set |
| varint, then that many strings | Key definitions |
| a patch | As below |

`seq`, `tick`, `from` and `c` mean what they mean in a JSON `patch` frame.

**Keys.** A name used as a key is sent once and by its number after that. Keep a list of keys for the connection, empty when it opens. For each frame: if the forget flag is set, empty the list; then append the frame's definitions to it, in order. A key's number is its place in the list, from 0. The first frame on a connection always has the flag set, and so does the first after the room has slept or started its numbering again, which it does when it has given out 8,192 numbers. A frame may define keys it does not use: the numbers are the room's, the same for every player in it.

In a patch or an object, **a key** is a varint: 0 means the name follows as a string, for this once, without a number; anything else is a key's number plus one. Names longer than 64 UTF-16 code units are always sent this way.

**A patch** is a varint count, then that many entries: a key, then one byte.

| Byte | The key's entry |
| --- | --- |
| `0d` | Delete the key |
| `0e` | A patch follows: apply it to what the key holds |
| `0f` | The key holds an array. A varint, its new length; a varint count; then that many pairs of a varint index and what to do with that element: `0e` and a patch, `0f` and an array's changes, or a value. Sent only to a client that asked for version 2 |
| anything else | It is the first byte of a value: set the key to that value |

**A value** is one byte that says what it is, then:

| Byte | Value |
| --- | --- |
| `00` | `null` |
| `01`, `02` | `false`, `true` |
| `03` | A whole number, zero or more: a varint |
| `04` | A whole number below zero: a varint of its size |
| `05`, `06` | A number with one decimal place, positive or negative: a varint of ten times its size. Divide by 10 |
| `07`, `08` | A number with two decimal places, positive or negative: a varint of a hundred times its size. Divide by 100 |
| `09` | Any other number: eight bytes, an IEEE 754 double, big-endian |
| `0a` | A string |
| `0b` | An array: a varint count, then that many values |
| `0c` | An object: a varint count, then that many pairs of a key and a value |

The room uses `05` to `08` only when dividing gives back exactly the double it had, so do the division in double precision and you hold the same number the room does.

An example, two frames on a new connection. The first sets `score` to 7:

```
b1  04  01  01  01 05 73 63 6f 72 65  01  01 03 07
│   │   │   │   │                     │   │  └ a whole number: 7
│   │   │   │   │                     │   └ key number 0, plus one
│   │   │   │   │                     └ a patch of one entry
│   │   │   │   └ one definition: a string of 5 bytes, "score". It is key 0
│   │   │   └ tick 1
│   │   └ seq 1
│   └ flags: forget the keys you know
└ a patch in this format
```

The second sets it to 8, in nine bytes where the JSON is 48: `b1 00 02 02 00 01 01 03 08`. No flags, `seq` 2, `tick` 2, no definitions, one entry, key 0, the whole number 8.

If a frame does not read as this format, or uses a key number you have no name for, you are out of step with the room: close the connection and connect again.

[Test vectors](https://github.com/Giamme/tickflare/blob/main/test/vectors/binary-patches.json) are in the repository: connections as lists of frames, each as hex, with the frame it stands for as JSON and the list of keys the client holds after it. A decoder that agrees with all of them reads what a room sends.

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

A [lockstep](../guide/lockstep) room uses the same frames. Its view is `{ seed, turn, entries, desync, snapshotEvery }`, delivered as patches, one per turn. Inputs are commands of the form `{ "k": "i", "d": <input> }`; simulation hashes are `{ "k": "h", "n": <turn>, "h": "<hash>" }`, where the hash is at most 64 characters. `LockstepClient` sends the first 32 hex digits of the SHA-256 of the saved simulation's JSON, unless the game gives a hash of its own. The recording is a JSON `Replay` served at `/rooms/<roomId>/replay`.

**Catching up.** A client that is catching up adds `since=<turn>` to that request: the turn its own simulation is at, or 0. The answer is then a `CatchUp`, a `Replay` with three more fields. `epoch` names the run of the room that answered; send it back as `epoch=<epoch>` with your next `since`, and if the room has not restarted since, it answers with `from: <since>` and only the turns after it. Add `snapshot=0` if you can load snapshots: when the room has one that is more than a snapshot interval ahead of you, or you have nothing, the answer has `snapshot: { turn, hash, data }`, `from` equal to its turn, and the turns after it. `data` is JSON text. Load it, hash the result as you hash your own simulation, and if the hash is not `hash`, ask again with `snapshot=<turn>`, which says that no snapshot of that turn or before is of use. Without `since` the answer is the whole recording, as it always was.

**Snapshots.** A room that keeps them says how often in its view, `"snapshotEvery": <turns>`. At every turn that is a multiple of it, report your hash, whatever your `hashEvery`. If your player's id sorts first among the connected players, also send the simulation: `POST /rooms/<roomId>/snapshot?turn=<turn>&hash=<hash>` with the saved simulation as the body, authenticated like the WebSocket. The room answers 201 when it kept the snapshot, 202 when it holds it until the other connected players have reported the same hash, 409 when it has no use for it (the turn is too old, not reached, or no newer than the snapshot it has; the hash is not the one already reported; the match has desynced), 413 when it is longer than the room accepts, 403 to anyone who is not a connected player of the room, and 404 when the room keeps no snapshots.

A room with [`turnClock = "players"`](../guide/lockstep#letting-the-room-sleep-between-turns) says so in its view, `{ seed, turn, entries, desync, "clock": "players" }`, and works differently in two ways:

- **It closes turns when asked.** A client asks with the command `{ "k": "t" }`. The room closes the turns that are due by its own clock, which may be none, and acks the command either way. Ask once a turn while your requests are the ones being answered; otherwise ask when no turns have arrived for a turn and a half, plus four tenths of a turn for each connected player whose id sorts before yours.
- **Turns arrive as messages**, not in the view: `{ "t": "msg", "d": { "tickflare": "turns", "n": <first turn>, "c": <how many>, "e": [<entries>], "b": "<player>" } }`. Turns `n` to `n + c - 1` are closed; all are empty but the last, which has the entries `e`. `b` is the player whose request closed them, and is missing when they were closed for a player coming or going. A message may overlap turns you already have: apply the ones after your latest. If `n` is past the turn after your latest, load the recording again. State frames from such a room carry a turn number that is a checkpoint; take turns only from messages.
