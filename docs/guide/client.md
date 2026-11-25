# Connecting from the client

`tickflare/client` is a small library for the other end of the WebSocket. It works in browsers, in Node 22 and later, and anywhere else with a global `WebSocket` and `fetch`.

| Class or function | For |
| --- | --- |
| `RoomClient` | Event mode and state sync rooms |
| `LockstepClient` | [Lockstep](./lockstep) rooms |
| `findMatch` | Waiting in a [matchmaking](./matchmaking) queue |
| `AccountClient` | [Accounts](./accounts): guests, sign-up, data, leaderboards |
| `Interpolator`, `BufferedInterpolator` | Smoothing positions between ticks: see [which to use](./state-sync#smoothing-on-the-client) |

The client keeps no secrets from the server and enforces no rules. It shows what the room sends and asks the room to do things.

## RoomClient

```ts
import { RoomClient, type CommandRejected } from "tickflare/client";
import type { Command, View } from "../src/game"; // share your types with the server

const room = new RoomClient<View, Command>(`wss://${location.host}/rooms/table-7`, {
  token: accounts.tokenSource,
});

room.on("state", (view, seq) => render(view));
room.on("presence", (players) => renderPlayers(players));
room.on("message", (message) => showToast(message));
room.on("status", (status, detail) => renderConnection(status, detail));
```

The constructor connects at once. Everything it reports is also an option (`onState`, `onPresence`, `onMessage`, `onStatus`, `onMoved`), if you prefer to pass callbacks up front. `on()` returns a function that stops listening.

What it holds, all read-only:

| Property | Meaning |
| --- | --- |
| `state` | The latest view the room sent. Undefined until the first arrives |
| `seq` | The room's change counter |
| `players` | Everyone with a seat, in join order, with `connected` flags |
| `you` | This player's id, once connected |
| `status` | `connecting`, `open` or `closed` |
| `tick`, `tickRate` | Ticks run so far, and ticks a second (0 in event mode) |
| `patchRate` | Patches a second while the room ticks: `tickRate`, unless the room [sends less often than it ticks](./state-sync#sending-less-often-than-you-simulate) |
| `serverTick()` | The tick the room is on right now, by estimate, fraction included: see [keeping time](./state-sync#keeping-time). Undefined in event mode |
| `rtt` | The round trip to the room in milliseconds, smoothed. Measured every few seconds while the room ticks, otherwise with the keepalive |
| `unconfirmed` | The commands sent that `state` does not show yet, oldest first |

### Sending commands

```ts
try {
  await room.send({ type: "place", cell: 4 });
} catch (error) {
  if ((error as CommandRejected).reason === "not_your_turn") shake();
}
```

`send()` resolves once the room has applied the command and `room.state` shows the result: at once in event mode, with the next tick in a room that is ticking. Until then the command is in `room.unconfirmed`, and [`Predictor`](./state-sync#showing-a-player-s-own-moves-at-once) can show its effect before the room does. It rejects with a `CommandRejected` whose `reason` is what the room passed to `reject()`, or:

- `invalid_command`: `parseCommand` threw something other than `reject()`. From a room that [checks commands with a schema](./rooms#checking-commands-with-a-schema) it is followed by what was wrong: `invalid_command: Expected number (at x)`;
- `internal_error`: a hook threw;
- `rate_limited`: the player sent too much;
- `not_connected`: the command never left the client. There was no connection, and none came in time. It was not applied;
- `disconnected`: the command was sent, the connection dropped, and the client could not find out what became of it. It may or may not have been applied.

### When the connection drops

A dropped connection does not lose a command, and does not apply one twice. You do nothing for this: the promise `send()` gave you settles as if the connection had held.

- **A command on its way when the connection drops** is kept. When the client is back, the room tells it which of its commands it handled. Those settle at once: `state` already shows them, and one the room refused rejects with the room's reason. The others never arrived, so the client sends them again, in the order you sent them.
- **A command sent while there is no connection** waits for one: while the client is reconnecting, and also before the first `welcome`, so you can call `send()` straight after `new RoomClient()`.
- **Either kind stays in `unconfirmed`** while it waits, so a [`Predictor`](./state-sync#showing-a-player-s-own-moves-at-once) goes on showing it.

A command waits for at most `keepCommandsMs`, ten seconds by default, counted from when it began to wait. Then the client gives it up, with `not_connected` if it was never sent and `disconnected` if it was, and does not send it later. Choose it for your game: a move in a card game is as good a minute late, a shot in an arena is not. With `keepCommandsMs: 0` nothing waits: `send()` rejects at once without a connection, and whatever is in flight when one drops rejects with `disconnected`.

The room does its half by remembering, for each seat, how far it got with the commands of the client that holds it. It saves that in the same write as the state, so a room that [restarts](./limits#restarts-and-deploys) knows exactly which commands its state holds. There are cases where the room cannot say, and the client then gives up what it had sent, with `disconnected`, as it would without any of this:

- the seat is not the one the commands were sent to: the player was away longer than `seatTimeoutMs`, or was removed;
- the same player connected from another tab or device in between. The room remembers one client a seat;
- the room handed the player to [another room](./worlds). Nothing is carried over, and what was waiting to be sent is given up too;
- the room is a [lockstep](./lockstep) room, or has `rememberCommands` off;
- the client is the [Godot or Unity](./engines) one, which do not do this yet.

And one where it cannot say of a single command, which then rejects with `disconnected` while the others settle: the room refused it, its answer was lost on the way, and the room slept before it wrote anything again. A refusal changes nothing in the state, so it costs no write, and the room that wakes up has forgotten it. It does know that it has, and says so rather than count the command as applied.

One thing can still happen twice. A command that changed nothing in the state costs no write, so if the room sleeps before its answer arrives and the client then sends it again, the room handles it again. The state is none the worse, but a message the hook sent with `send()` or `broadcast()` goes out a second time.

### Leaving and closing

- `room.leave()` gives up the seat. The room runs `onLeave`, then closes the connection, and `status` becomes `closed`. It rejects if `onLeave` called `reject()`.
- `room.close()` closes the connection for good but keeps the seat, as if the tab were closed. No reconnect follows.

### Reconnecting

The client reconnects by itself when a connection drops unexpectedly: after 125 to 250 milliseconds, then backing off up to 5 seconds between attempts. Each failed attempt reports `connecting` with the close code. On reconnect the room sends the current state in its first frame, so there is nothing to replay, and says which commands it handled, so that [none is lost or applied twice](#when-the-connection-drops).

It stops, with `closed`, after the close codes that mean trying again won't help: replaced by a newer connection, room full, refused by `onJoin`, or seat removed. See [Close codes](./players#close-codes). Pass `reconnect: false` to stop after any close.

`binary: true` asks the room for its patches [in binary](../reference/protocol#binary-patches). Leave it off in a browser and in Node: the connection is compressed there, so it saves little, and JSON frames can be read in the developer tools. It exists for clients in engines whose WebSocket does not compress, and this client is how the format is tested.

A keepalive goes out every 25 seconds (`pingIntervalMs`). Keep it well under the room's `silentAfterMs`, two minutes by default: a ticking room [closes a connection](./players) it has heard nothing from for that long. A connection that goes a whole interval without hearing anything back is taken for dead and replaced, so a phone that changed networks reconnects in seconds instead of minutes.

### Tokens

`token` is a function that returns a join token, or a promise of one. It is called before every connection attempt, with the id of the room being connected to: the first, every reconnect, and after a [handover](./worlds). Return the token you have while it's still good, and get a new one when it isn't. `AccountClient.tokenSource` is one ready-made. See [Identity and join tokens](./identity#join-tokens).

A client that keeps reporting `connecting` while the network is fine is being turned away before it reaches the room, most often because its token has expired. If `token` throws, the attempt fails with the reason `token_failed` and is retried like any other.

### Handovers

When a room [hands the player to another room](./worlds), the client reconnects to the new room by itself and reports `moved(roomId)`. `state` then carries the new room's view.

## Using it with a UI framework

`on()` returns its unsubscribe function, which fits the way frameworks subscribe. In React:

```tsx
import { useEffect, useState } from "react";
import { RoomClient } from "tickflare/client";

function useRoom<View>(room: RoomClient<View>) {
  const [view, setView] = useState(room.state);
  const [status, setStatus] = useState(room.status);
  useEffect(() => room.on("state", (next) => setView(next)), [room]);
  useEffect(() => room.on("status", (next) => setStatus(next)), [room]);
  return { view, status };
}
```

Unchanged parts of the view keep their identity from one state to the next, so `React.memo` and selectors that compare by reference skip work for parts that didn't change.

## In Node

Node 22 and later have a global `WebSocket`, so the client works unchanged in scripts, bots and load tests:

```ts
import { RoomClient } from "tickflare/client";

const room = new RoomClient("wss://my-game.example/rooms/lobby?token=" + token);
room.on("state", (view) => console.log(view));
```

`AccountClient` uses bearer sessions outside browsers. Pass `session` and `onSession` to keep a bot signed in between runs.

## Sharing types with the server

The room's `view()` and the client's `RoomClient<View, Command>` describe the same data. Put the `View` and `Command` types in a module both sides import, and the compiler checks that the page sends commands the room understands.
