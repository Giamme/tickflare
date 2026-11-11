import { describe, expect, it } from "vitest";
import { Interpolator } from "../src/client/interpolate.js";
import { connect, freshRoom, sleep, twoPlayers } from "./helpers.js";

describe("signal", () => {
  it("reaches another room's onSignal after the hook commits", async () => {
    const { room, p1 } = await twoPlayers();
    const other = await twoPlayers();
    p1.command({ type: "signal", to: other.room, text: "hello" });
    await p1.next("ack");

    expect((await other.p1.next("state")).state.log.slice(-1)).toEqual([`heard:${room}:hello`]);
  });

  it("is not sent when the hook rejects afterwards", async () => {
    const { p1 } = await twoPlayers();
    const other = await twoPlayers();
    p1.command({ type: "signalThenReject", to: other.room });
    await p1.next("reject");
    await sleep(100);

    other.p1.command({ type: "add", n: 1 });
    expect((await other.p1.next("state")).state.log).toEqual(["join:p1", "join:p2"]);
  });

  it("leaves a room nobody is watching alone after the first try", async () => {
    const { room, p1 } = await twoPlayers();
    const empty = freshRoom();
    for (const text of ["one", "two", "three"]) {
      p1.command({ type: "signal", to: empty, text, quiet: true });
      await p1.next("ack");
      await sleep(30);
    }

    // The first found the room empty; the others were held back.
    const visitor = await connect(empty, "p9");
    expect((await visitor.next("welcome")).state.log).toEqual([`heard:${room}:one`, "join:p9"]);

    // Without `onlyIfWatched` every signal goes out.
    p1.command({ type: "signal", to: empty, text: "four" });
    expect((await visitor.next("state")).state.log.slice(-1)).toEqual([`heard:${room}:four`]);
  });
});

describe("Interpolator", () => {
  it("glides from what is on screen to the latest value over one duration", () => {
    const glide = new Interpolator(100, ["x", "y"]);
    glide.update({ a: { x: 0, y: 0 } }, 1000);
    expect(glide.at("a", 1000)).toEqual({ x: 0, y: 0 });

    glide.update({ a: { x: 10, y: 20 } }, 1100);
    expect(glide.at("a", 1100)).toEqual({ x: 0, y: 0 });
    expect(glide.at("a", 1150)).toEqual({ x: 5, y: 10 });
    expect(glide.at("a", 1200)).toEqual({ x: 10, y: 20 });
    expect(glide.at("a", 5000)).toEqual({ x: 10, y: 20 });
  });

  it("bends towards a new target from where it is, instead of jumping", () => {
    const glide = new Interpolator(100, ["x"]);
    glide.update({ a: { x: 0 } }, 0);
    glide.update({ a: { x: 100 } }, 0);
    // Halfway there, a new target arrives early.
    glide.update({ a: { x: 0 } }, 50);
    expect(glide.at("a", 50)).toEqual({ x: 50 });
    expect(glide.at("a", 100)).toEqual({ x: 25 });
  });

  it("only keeps the fields it was asked for, and forgets ids that are gone", () => {
    const glide = new Interpolator(100, ["x"]);
    glide.update({ a: { x: 1, score: 7 } as { x: number }, b: { x: 2 } }, 0);
    expect(glide.at("a", 0)).toEqual({ x: 1 });

    glide.update({ b: { x: 3 } }, 10);
    expect(glide.at("a", 10)).toBeUndefined();
    glide.clear();
    expect(glide.at("b", 10)).toBeUndefined();
  });
});
