# Testing your rooms

Rooms are Durable Objects, so test them where they run: inside workerd, Cloudflare's runtime, with `@cloudflare/vitest-plugin`. Your tests open real WebSockets to your real Worker, with local Durable Objects, D1, R2 and Queues. That is how Tickflare tests itself.

## Setting up

```sh
npm install --save-dev vitest @cloudflare/vitest-plugin
```

```ts
// vitest.config.ts
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
```

Tests can now reach your Worker as `exports.default` and its bindings as `env`, both from `cloudflare:workers`.

## Connecting as a player

Players need an identity to get through the gateway. In tests, sign join tokens with the secret from your test configuration:

```ts
// test/helpers.ts
import { env, exports } from "cloudflare:workers";
import { createJoinToken, type ServerMessage } from "tickflare";

export async function connect(roomId: string, player: string) {
  const token = await createJoinToken(env.JOIN_SECRET, { player });
  const response = await exports.default.fetch(`https://game.test/rooms/${roomId}?token=${token}`, {
    headers: { Upgrade: "websocket" },
  });
  const ws = response.webSocket!;
  const inbox: ServerMessage[] = [];
  const waiting: ((frame: ServerMessage) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const frame = JSON.parse(event.data as string) as ServerMessage;
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else inbox.push(frame);
  });
  ws.accept();
  return {
    ws,
    next: () => Promise.resolve(inbox.shift() ?? new Promise<ServerMessage>((resolve) => waiting.push(resolve))),
    send: (data: unknown, id = 1) => ws.send(JSON.stringify({ t: "cmd", id, data })),
  };
}
```

Then drive the room frame by frame. Give each test a room id of its own so tests don't share state:

```ts
// test/counter.test.ts
import { expect, it } from "vitest";
import { connect } from "./helpers";

it("refuses a second increment in a row", async () => {
  const room = `counter-${crypto.randomUUID()}`;
  const ada = await connect(room, "ada");
  expect(await ada.next()).toMatchObject({ t: "welcome", state: { count: 0 } });

  ada.send({ type: "increment" }, 1);
  expect(await ada.next()).toMatchObject({ t: "state", state: { count: 1, lastBy: "ada" } });
  expect(await ada.next()).toMatchObject({ t: "ack", id: 1 });

  ada.send({ type: "increment" }, 2);
  expect(await ada.next()).toMatchObject({ t: "reject", id: 2, reason: "wait_for_someone_else" });
});
```

The [wire protocol](../reference/protocol) lists every frame a room can send.

## Timers without waiting

`runDurableObjectAlarm(stub)` from `cloudflare:test` fires a room's earliest pending timer straight away, so a 30-second turn clock doesn't take 30 seconds to test:

```ts
import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";

await runDurableObjectAlarm(env.ROOMS.get(env.ROOMS.idFromName(room)));
```

## Restarts

`evictDurableObject(stub)` from `cloudflare:test` throws a room out of memory with its sockets still open, as a deploy or an eviction would. The next event rebuilds it from storage. Use it to check that your room survives with its state, seats and timers intact.
