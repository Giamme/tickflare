import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Predictor, RoomClient } from "../src/client/index.js";
import { freshRoom, until } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";
import type { TickCommand, TickState } from "./worker.js";

const rooms: RoomClient<TickState, TickCommand>[] = [];

/** The real client in a room of the worker under test, with a predictor for the one command these tests send. */
function play(prefix: string, room: string) {
  const client = new RoomClient<TickState, TickCommand>(`wss://tickflare.test${prefix}/${room}?player=p1`);
  rooms.push(client);
  /** Every value of `bumps` the player was shown, in order. */
  const shown: number[] = [];
  const predicted = new Predictor(client, {
    apply(state, command) {
      if (command.type === "bump") state.bumps += 1;
    },
    onState: (state) => shown.push(state.bumps),
  });
  return { client, predicted, shown };
}

describe("a predictor in a real room", () => {
  beforeEach(() => {
    WorkerSocket.all = [];
    vi.stubGlobal("WebSocket", WorkerSocket);
  });
  afterEach(() => {
    for (const room of rooms.splice(0)) room.close();
    vi.unstubAllGlobals();
  });

  it.each([
    ["that is ticking", "/ticks", ""],
    ["whose ticks change nothing", "/ticks", "still-"],
    ["in event mode", "/ticks", "lobby-"],
  ])("shows a command at once in a room %s, and never anything but its effect afterwards", async (_kind, prefix, name) => {
    const { client, predicted, shown } = play(prefix, `${name}${freshRoom()}`);
    await until(() => client.state !== undefined, "the welcome");
    if (name === "lobby-") {
      // Stop the simulation: the room now answers each command as it comes.
      await client.send({ type: "stop" });
      expect(client.state!.phase).toBe("lobby");
    }
    shown.length = 0;

    const sent = predicted.send({ type: "bump" });
    expect(predicted.state!.bumps).toBe(1);
    expect(client.state!.bumps).toBe(0);
    await sent;
    // By the time the command is answered, the room's own state has its effect.
    expect(client.state!.bumps).toBe(1);
    expect(client.unconfirmed).toEqual([]);

    await predicted.send({ type: "bump" });
    await predicted.send({ type: "bump" });
    const seq = client.seq;
    if (name === "") await until(() => client.seq > seq + 2, "a few more ticks");
    // Shown one after the other, each once it was sent: never a bump too many, never one taken back.
    expect([...new Set(shown)]).toEqual([1, 2, 3]);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    expect(predicted.state).toBe(client.state);
  });

  it("takes back a command the room refuses", async () => {
    const { client, predicted, shown } = play("/ticks", freshRoom());
    await until(() => client.state !== undefined, "the welcome");
    const predictedHalf = new Predictor(client, {
      apply(state, command) {
        if (command.type === "half") state.bumps += 100;
      },
    });
    const refused = predictedHalf.send({ type: "half" });
    expect(predictedHalf.state!.bumps).toBe(100);
    await expect(refused).rejects.toMatchObject({ reason: "changed_my_mind" });
    expect(predictedHalf.state!.bumps).toBe(0);
    expect(predicted.state!.bumps).toBe(0);
    expect(shown.every((bumps) => bumps === 0)).toBe(true);
  });
});
