# Connecting from the client

`tickflare/client` is a small library for the other end of the WebSocket. It works in browsers, in Node 22 and later, and anywhere else with a global `WebSocket` and `fetch`.

| Class or function | For |
| --- | --- |
| `RoomClient` | Event mode and state sync rooms |
| `LockstepClient` | [Lockstep](./lockstep) rooms |
| `findMatch` | Waiting in a [matchmaking](./matchmaking) queue |
| `AccountClient` | [Accounts](./accounts): guests, sign-up, data, leaderboards |
| `Interpolator` | Smoothing positions between ticks |

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

- `invalid_command`: `parseCommand` threw something other than `reject()`;
- `internal_error`: a hook threw;
- `rate_limited`: the player sent too much;
- `not_connected`: the client wasn't connected when you called it;
- `disconnected`: the connection dropped before the answer came.

A command sent just before a disconnect may or may not have been applied. If that matters, make commands safe to repeat, or check the state after reconnecting.

### Leaving and closing

- `room.leave()` gives up the seat. The room runs `onLeave`, then closes the connection, and `status` becomes `closed`. It rejects if `onLeave` called `reject()`.
- `room.close()` closes the connection for good but keeps the seat, as if the tab were closed. No reconnect follows.

### Reconnecting

The client reconnects by itself when a connection drops unexpectedly: after 125 to 250 milliseconds, then backing off up to 5 seconds between attempts. Each failed attempt reports `connecting` with the close code. On reconnect the room sends the current state in its first frame, so there is nothing to replay.

It stops, with `closed`, after the close codes that mean trying again won't help: replaced by a newer connection, room full, refused by `onJoin`, or seat removed. See [Close codes](./players#close-codes). Pass `reconnect: false` to stop after any close.

`binary: true` asks the room for its patches [in binary](../reference/protocol#binary-patches). Leave it off in a browser and in Node: the connection is compressed there, so it saves little, and JSON frames can be read in the developer tools. It exists for clients in engines whose WebSocket does not compress, and this client is how the format is tested.

A keepalive goes out every 25 seconds (`pingIntervalMs`). A connection that goes a whole interval without hearing anything back is taken for dead and replaced, so a phone that changed networks reconnects in seconds instead of minutes.

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
