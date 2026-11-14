import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { LockstepView, Replay, TurnsMessage } from "../src/lockstep.js";
import { follow, freshRoom, sleep, until } from "./helpers.js";
import type { TurnInput } from "./worker.js";

/**
 * A lockstep room with `turnClock = "players"`: it has no timer of its own.
 * It closes turns when a player asks, as many as its clock says are due.
 * The test room runs at 20 turns a second: a turn is 50 ms.
 */
type View = LockstepView<TurnInput>;
type Turns = TurnsMessage<TurnInput>;
type Seat = Awaited<ReturnType<typeof join>>;

const join = (room: string, player: string) => follow<View>("/asked", room, player);
const ask = { k: "t" };
const order = (n: number) => ({ k: "i", d: { type: "add", n } });
const closed = (seat: Seat) =>
  seat.of("msg").map((frame) => frame.d as Turns).filter((message) => message?.tickflare === "turns");
const latest = (seat: Seat) => closed(seat).reduce((turn, message) => Math.max(turn, message.n + message.c - 1), 0);
const what = (entries: Turns["e"]) => entries.map((entry) => `${entry.player}:${entry.event ?? entry.input?.n}`);

async function replayOf(room: string): Promise<Replay<TurnInput>> {
  const response = await exports.default.fetch(`https://tickflare.test/asked/${room}/replay?player=p1`);
  expect(response.status).toBe(200);
  return response.json();
}

describe("a lockstep room whose players ask for the turns", () => {
  it("says so, and puts a player's arrival in a turn without being asked", async () => {
    const p1 = await join(freshRoom(), "p1");
    expect(p1.state).toMatchObject({ clock: "players" });
    await until(() => closed(p1).length === 1, "the turn p1 arrived in");
    expect(closed(p1)[0]).toEqual({ tickflare: "turns", n: 1, c: 1, e: [{ player: "p1", event: "join" }] });
  });

  it("does nothing between requests, then closes as many turns as its clock says are due", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => latest(p1) === 1);
    await sleep(170); // three turns and a bit, with nobody asking
    expect(latest(p1)).toBe(1);

    p1.send(ask);
    await until(() => closed(p1).length === 2, "the turns that were due");
    const due = closed(p1)[1]!;
    expect(due).toMatchObject({ n: 2, e: [], b: "p1" });
    expect(due.c).toBeGreaterThanOrEqual(2);
    expect(due.c).toBeLessThanOrEqual(5);

    // Asked again at once: nothing is due, so nothing is closed and nothing is sent.
    p1.send(ask);
    await sleep(15);
    expect(closed(p1)).toHaveLength(2);
  });

  it("cannot be hurried: asking more often does not close more turns", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => latest(p1) === 1);
    const started = Date.now();
    for (let n = 0; n < 40; n++) {
      p1.send(ask);
      await sleep(5);
    }
    await sleep(30);
    const allowed = (Date.now() - started) / 50 + 2;
    expect(latest(p1) - 1).toBeLessThanOrEqual(allowed);
    expect(latest(p1) - 1).toBeGreaterThanOrEqual(2);
  });

  it("puts an order in the next turn closed, for everyone, and writes one row for it", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const p2 = await join(room, "p2");
    await until(() => latest(p2) >= 2, "both arrivals");
    const stub = env.ASKED.get(env.ASKED.idFromName(room));
    const seq = () => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<{ seq: number }>("SELECT seq FROM tickflare_room").one().seq);
    const before = await seq();

    p1.send(order(7));
    await sleep(60);
    expect(what(closed(p2).flatMap((message) => message.e))).not.toContain("p1:7"); // waiting: nobody has asked
    p2.send(ask);
    await until(() => what(closed(p1).flatMap((message) => message.e)).includes("p1:7"), "the order's turn");

    const mine = closed(p1).find((message) => what(message.e).includes("p1:7"))!;
    const theirs = closed(p2).find((message) => what(message.e).includes("p1:7"))!;
    expect(theirs).toEqual(mine);
    expect(mine.b).toBe("p2");

    const at = mine.n + mine.c - 1;
    const replay = await replayOf(room);
    expect(replay.turns.filter(([, entries]) => what(entries).includes("p1:7")).map(([turn]) => turn)).toEqual([at]);
    expect(replay.turn).toBe(latest(p1));
    // The room's own row was not written for the order or its turn.
    expect(await seq()).toBe(before);
  });

  it("stands still while nobody asks", async () => {
    const p1 = await join(freshRoom(), "p1");
    await until(() => latest(p1) === 1);
    await sleep(2200); // 44 turns' worth
    p1.send(ask);
    await until(() => closed(p1).length === 2);
    const at = Date.now();
    expect(closed(p1)[1]!.c).toBe(30);

    // The clock starts again from here: the time it stood still is not owed.
    p1.send(ask);
    await sleep(15);
    // A turn is 50 ms. On a machine so busy that this much has gone by already, the next turn is
    // due and says nothing about the one before.
    if (Date.now() - at < 40) expect(closed(p1)).toHaveLength(2);
  });

  it("checkpoints the turn counter in the room's row, not every turn", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    const stub = env.ASKED.get(env.ASKED.idFromName(room));
    const saved = () =>
      runInDurableObject(stub, (_instance, state) => {
        const row = state.storage.sql.exec<{ seq: number; state: string }>("SELECT seq, state FROM tickflare_room").one();
        return { seq: row.seq, turn: (JSON.parse(row.state) as { turn: number }).turn };
      });
    const start = await saved();
    for (let n = 0; n < 16; n++) {
      await sleep(50);
      p1.send(ask);
    }
    await until(() => latest(p1) >= 14, "a second's worth of turns");
    const end = await saved();
    expect(end.turn).toBeGreaterThanOrEqual(10);
    expect(end.turn).toBeLessThanOrEqual(latest(p1));
    // Fourteen or more turns, one or two writes.
    expect(end.seq - start.seq).toBeLessThanOrEqual(2);
  });

  it("never uses a turn number twice after a restart, and leaves no gap for players who stayed", async () => {
    const room = freshRoom();
    const p1 = await join(room, "p1");
    p1.send(order(1));
    for (let n = 0; n < 14; n++) {
      await sleep(50);
      p1.send(ask);
    }
    await until(() => latest(p1) >= 12);
    const seen = latest(p1);

    await abortAllDurableObjects();
    const back = await join(room, "p1");
    await until(() => closed(back).length >= 1, "the turn p1 came back in");
    const resumed = closed(back)[0]!;
    // It starts at or before the turn after the last one anybody saw, and ends past it.
    expect(resumed.n).toBeLessThanOrEqual(seen + 1);
    expect(resumed.n + resumed.c - 1).toBeGreaterThan(seen);
    expect(what(resumed.e)).toEqual(["p1:reconnect"]);

    // And the clock carries on from there: the turns passed over are not owed back.
    const from = latest(back);
    for (let n = 0; n < 6; n++) {
      await sleep(50);
      back.send(ask);
    }
    await until(() => latest(back) >= from + 4, "turns after the restart");

    const replay = await replayOf(room);
    const numbers = replay.turns.map(([turn]) => turn);
    expect(numbers).toEqual([...new Set(numbers)].sort((a, b) => a - b));
    expect(replay.turns.flatMap(([, entries]) => what(entries))).toEqual(["p1:join", "p1:1", "p1:reconnect"]);
    expect(replay.turn).toBe(latest(back));
  });
});
