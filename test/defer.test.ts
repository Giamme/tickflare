import { describe, expect, it } from "vitest";
import { connect, freshRoom } from "./helpers.js";

async function stateWith(conn: Awaited<ReturnType<typeof connect>>, entry: string) {
  for (;;) {
    const frame = await conn.any();
    if (frame.t === "state" && frame.state.log.includes(entry)) return frame.state;
  }
}

describe("defer and act", () => {
  it("run work after the event and bring its result back in as a hook", async () => {
    const p1 = await connect(freshRoom(), "p1", {}, "/edge");
    await p1.next("welcome");
    p1.command({ type: "edge:later" } as never);
    const state = await stateWith(p1, "outcome:true");
    expect(state.log.slice(-3)).toEqual(["asked", "later", "outcome:true"]);
  });

  it("drop deferred work when the hook that asked for it is refused", async () => {
    const p1 = await connect(freshRoom(), "p1", {}, "/edge");
    await p1.next("welcome");
    p1.command({ type: "edge:laterThenReject" } as never);
    await p1.next("reject");
    p1.command({ type: "edge:later" } as never);
    const state = await stateWith(p1, "outcome:true");
    expect(state.log).not.toContain("never");
  });

  it("report a refused act and take back what it changed", async () => {
    const p1 = await connect(freshRoom(), "p1", {}, "/edge");
    await p1.next("welcome");
    p1.command({ type: "edge:actRejects" } as never);
    const state = await stateWith(p1, "refused:not_now");
    expect(state.total).toBe(0);
  });
});
