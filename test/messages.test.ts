import { describe, expect, it } from "vitest";
import { CloseCode } from "../src/protocol.js";
import { connect, freshRoom, twoPlayers } from "./helpers.js";

describe("messages", () => {
  it("reach only the player they are for, after the state change of the same event", async () => {
    const { p1, p2 } = await twoPlayers();
    const id = p1.command({ type: "tell", to: "p2", text: "psst" });
    await p1.next("state");
    expect(await p1.next("ack")).toMatchObject({ id });

    await p2.next("state");
    expect(await p2.next("msg")).toEqual({ t: "msg", d: { from: "p1", text: "psst" } });
  });

  it("go to everyone when broadcast", async () => {
    const { p1, p2 } = await twoPlayers();
    p1.command({ type: "shout", text: "hello all" });
    await p1.next("ack");
    expect(await p1.next("msg")).toMatchObject({ d: { text: "hello all" } });
    expect(await p2.next("msg")).toMatchObject({ d: { from: "p1", text: "hello all" } });
  });

  it("are dropped with everything else when the hook that sent them is refused", async () => {
    const { p1, p2 } = await twoPlayers();
    p1.command({ type: "tellThenReject", to: "p2" });
    await p1.next("reject");
    p1.command({ type: "tell", to: "p2", text: "second" });
    await p1.next("state");
    await p1.next("ack");
    await p2.next("state");
    expect(await p2.next("msg")).toMatchObject({ d: { text: "second" } });
  });

  it("sent while a player joins arrive right after their welcome", async () => {
    const room = freshRoom();
    const p1 = await connect(room, "p1", {}, "/greet");
    await p1.next("welcome");
    expect(await p1.next("msg")).toEqual({ t: "msg", d: { hello: "p1" } });
  });

  it("reach a player the same hook removes before their connection is closed", async () => {
    const { p1, p2 } = await twoPlayers();
    p1.command({ type: "kickWithNote", id: "p2" });
    expect(await p2.next("msg")).toMatchObject({ d: { text: "you are out" } });
    expect(await p2.closed).toMatchObject({ code: CloseCode.Removed, reason: "kicked" });
  });

  it("to someone who is not connected are dropped without fuss", async () => {
    const { p1, p2 } = await twoPlayers();
    p2.ws.close(1000, "bye");
    await p1.next("state");
    await p1.next("presence");
    p1.command({ type: "tell", to: "p2", text: "anyone?" });
    await p1.next("state");
    await p1.next("ack");
    p1.command({ type: "tell", to: "nobody-here", text: "anyone?" });
    await p1.next("state");
    await p1.next("ack");
  });
});
