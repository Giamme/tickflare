# Timers, messages and async work

Hooks are synchronous and only change the state. This page covers the tools for everything else: doing something later, telling a player something once, talking to the outside world, and answering HTTP requests.

## Timers

`this.setTimer(name, delayMs)` runs `onTimer(name)` once, `delayMs` from now. It returns the time it will fire, in epoch milliseconds, which you can put in the state so clients can show a countdown.

```ts
protected override onJoin(player: Player): void {
  if (this.players.length === 2) {
    this.state.turnEndsAt = this.setTimer("turn", 30_000);
  }
}

protected override onTimer(name: string): void {
  if (name === "turn") {
    this.state.winner = this.otherPlayer(this.state.turn);
    this.state.turnEndsAt = null;
  }
}
```

- Setting a timer with a name that is already set replaces it. `this.clearTimer(name)` cancels one.
- Timers are saved with the room, so they survive hibernation, eviction and redeploys. A timer that came due while the room was down fires when it comes back.
- Any number of timers share the Durable Object's single alarm.
- Each timer fires once. If its hook throws or calls `reject()`, it is spent, not retried.
- Like every other change, setting or clearing a timer is undone if the hook that did it is refused.
- Names that start with `tickflare:` belong to the room itself (seat timeouts use them). Use any other name.

## Messages

The state is what everyone sees, all the time. Some things aren't state: an event a player should hear about once ("you were hit"), a result with more in it than an acknowledgement, or a stream you keep in step yourself. For those, send a message:

```ts
this.send(target.id, { type: "hit", by: player.id, damage: 12 });
this.broadcast({ type: "chat", from: player.name, text });
```

The client receives it in the `message` event:

```ts
room.on("message", (message) => showToast(message));
```

How messages behave:

- They go out when the event that sent them is over, in the order they were sent. In event mode that is after the patch the event caused; in a ticking room, after the tick's patch. A message sent while handling a command in a ticking room can arrive before the next tick shows the command's effect.
- A message to a player who isn't connected is dropped. Nothing is sent again on reconnect, unlike the state: send what a returning player needs from `onReconnect`.
- Everything a hook sent is dropped if that hook is refused.
- A player the same hook removes still hears the messages before their connection closes, so a "you were kicked because..." arrives.
- `broadcast` also reaches [spectators](./spectators), as late as the room keeps them. `send` is for one player, and no spectator hears it.

## Async work

Hooks can't wait for anything, because the room has to be able to save or roll back what they did the moment they return. Work that waits on the outside world (writing to D1, calling another Durable Object, `fetch`) goes in `this.defer(task)`. It runs once the event is over:

```ts
protected override onLeave(player: Player): void {
  const score = this.state.scores[player.id] ?? 0;
  this.defer(async () => {
    await this.env.DB.prepare("INSERT INTO scores (player, score) VALUES (?, ?)")
      .bind(player.id, score)
      .run();
  });
}
```

- A deferred task is dropped if the hook that deferred it is refused.
- Nothing waits for it, and it isn't retried: failures are logged.
- It isn't saved. If it must happen even across a restart, keep what is still owed in the state and set a timer that tries again.

To change the state with what came back, run a hook from the task with `this.act(hook)`. It behaves like any other hook: its changes are saved and sent, or all undone if it throws or calls `reject()`. It resolves to `{ ok: true }` or `{ ok: false, reason }`.

```ts
protected override onCommand(player: Player, command: Command): void {
  if (command.type === "lookup") {
    this.state.pending[player.id] = command.word;
    this.defer(async () => {
      const found = await isAWord(command.word);
      await this.act(() => {
        delete this.state.pending[player.id];
        if (found) this.state.words.push(command.word);
      });
    });
  }
}
```

`act` also works from RPC methods of your own, so another Worker or Durable Object can change a room's state:

```ts
export class Table extends Room<State, Command, Env> {
  // Called as env.ROOMS.get(id).announce("Doors close in five minutes").
  async announce(text: string): Promise<void> {
    await this.act(() => this.broadcast({ type: "announcement", text }));
  }
}
```

## HTTP requests

A plain HTTP request to `/rooms/<id>/<anything>` reaches the room's `onHttp(request, player)` hook, after the gateway has authenticated it like a WebSocket. Use it to read from a room without connecting: a scoreboard, a spectator snapshot, a replay.

```ts
protected override onHttp(request: Request, player: Player): Response {
  const { pathname } = new URL(request.url);
  if (pathname.endsWith("/scores")) return Response.json(this.state.scores);
  return new Response("Not found", { status: 404 });
}
```

`onHttp` is for reading. Whatever it changes in `this.state` is discarded. To change the state from outside, send a command over a WebSocket, or use an RPC method with `act` as above.

## Saving while ticking

Outside a simulation every change is written to storage at once. While a room is [ticking](./state-sync), the state is written every `saveIntervalMs` instead. If a hook also writes to the room's own SQLite database (`this.ctx.storage.sql`), call `this.saveNow()` in it, so the state is written in the same transaction and the two can't come apart. That matters twice over in `onCommand`: the room also saves [which commands it has handled](./client#when-the-connection-drops) with the state, and a command your table has but the save does not would be sent again after a restart and written twice.
