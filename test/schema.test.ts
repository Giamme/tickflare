import { describe, expect, it, vi } from "vitest";
import { Rejection, parseWith, type StandardSchemaIssue, type StandardSchemaV1 } from "../src/server/index.js";
import { follow, freshRoom, until } from "./helpers.js";
import type { PacedState } from "./worker.js";

/**
 * `parseWith`: commands checked by a schema from any library that implements
 * Standard Schema. The schemas here are written by hand to the
 * specification, so that the tests need none of the libraries; the helper
 * was also run against Zod, Valibot and ArkType when it was written.
 */
const schema = <Output>(validate: StandardSchemaV1<unknown, Output>["~standard"]["validate"]): StandardSchemaV1<unknown, Output> => ({
  "~standard": { version: 1, vendor: "test", validate },
});
const failing = (...issues: StandardSchemaIssue[]) => schema<never>(() => ({ issues }));
const reasonOf = (run: () => unknown): string => {
  try {
    run();
  } catch (err) {
    if (err instanceof Rejection) return err.reason;
    throw err;
  }
  throw new Error("nothing was refused");
};

describe("parseWith", () => {
  it("gives back what the schema makes of the value, not the value", () => {
    const trimmed = schema((value) => ({ value: { text: String((value as { text: unknown }).text).trim() } }));
    expect(parseWith(trimmed, { text: "  hi  ", extra: 1 })).toEqual({ text: "hi" });
  });

  it("refuses what does not fit, with the first thing the schema found wrong and where", () => {
    expect(reasonOf(() => parseWith(failing({ message: "Expected number", path: ["x"] }, { message: "Too long", path: ["text"] }), {}))).toBe(
      "invalid_command: Expected number (at x)",
    );
    // A path can go through arrays, and a library may give its parts as objects.
    expect(reasonOf(() => parseWith(failing({ message: "Expected string", path: ["units", 3, { key: "name" }] }), {}))).toBe(
      "invalid_command: Expected string (at units.3.name)",
    );
    // Wrong at the top: there is no path to give.
    expect(reasonOf(() => parseWith(failing({ message: "Expected object" }), null))).toBe("invalid_command: Expected object");
    expect(reasonOf(() => parseWith(failing({ message: "Expected object", path: [] }), null))).toBe("invalid_command: Expected object");
    expect(reasonOf(() => parseWith(failing(), null))).toBe("invalid_command: does not fit the schema");
  });

  it("cuts the reason to what the room remembers of one", () => {
    const reason = reasonOf(() => parseWith(failing({ message: "x".repeat(500) }), {}));
    expect(reason).toHaveLength(120);
    expect(reason.startsWith("invalid_command: xxx")).toBe(true);
  });

  it("will not use a schema that checks asynchronously, and says so in the log", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => parseWith(schema(async () => ({ value: 1 })), 1)).toThrow(TypeError);
      // A check that fails later is nobody's unhandled rejection.
      expect(() => parseWith(schema(() => Promise.reject(new Error("late"))), 1)).toThrow(TypeError);
      expect(log.mock.calls[0]![0]).toContain("asynchronously");
    } finally {
      log.mockRestore();
    }
  });
});

describe("a room that checks its commands with a schema", () => {
  it("applies what the schema gives back, and refuses the rest with the schema's reason", async () => {
    const p1 = await follow<PacedState>("/paced", freshRoom(), "p1");
    // The schema turns a number sent as text into one: the room gets the number.
    p1.send({ type: "add", n: "4" });
    await until(() => p1.state!.sums.p1 === 4, "the command");

    const id = p1.frames.length + 1;
    p1.send({ type: "add", n: "four" });
    await until(() => p1.of("reject").length > 0, "the refusal");
    expect(p1.of("reject")[0]).toEqual({ t: "reject", id, reason: "invalid_command: Expected a number (at n)" });
    p1.send({ type: "dance" });
    await until(() => p1.of("reject").length > 1, "the second refusal");
    expect(p1.of("reject")[1]!.reason).toBe("invalid_command: Unknown command (at type)");
    expect(p1.state!.sums.p1).toBe(4);
  });
});
