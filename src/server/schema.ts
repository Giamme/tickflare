import { reject } from "./room.js";

/**
 * A schema from any library that implements Standard Schema
 * (https://standardschema.dev): Zod, Valibot, ArkType and others. This is
 * the part of that specification Tickflare reads, written out here so that
 * it depends on none of them.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** What the specification asks a schema to carry. */
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output } | undefined;
  };
}

/** What a Standard Schema makes of a value: the value as it should be, or what is wrong with it. */
export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

/** One thing a Standard Schema found wrong, and where. */
export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
}

/** As much of a reason as the room remembers for a client that comes back: see `WelcomeFrame.refused`. */
const REASON_LENGTH = 120;

/**
 * Checks what a client sent against a schema, and gives back what the
 * schema makes of it. For `parseCommand`, and for `parseInput` in a
 * lockstep room, with a schema from any library that implements Standard
 * Schema:
 *
 *     const Command = z.discriminatedUnion("type", [
 *       z.object({ type: z.literal("move"), x: z.number(), y: z.number() }),
 *       z.object({ type: z.literal("say"), text: z.string().max(200) }),
 *     ]);
 *
 *     export class Game extends Room<State, z.infer<typeof Command>> {
 *       protected parseCommand(raw: unknown) {
 *         return parseWith(Command, raw);
 *       }
 *     }
 *
 * What does not fit is refused, as by `reject()`, with the first thing the
 * schema found wrong: `invalid_command: Expected number (at x)`, cut to 120
 * characters. A schema whose checks are asynchronous cannot be used: a hook
 * cannot wait.
 */
export function parseWith<Output>(schema: StandardSchemaV1<unknown, Output>, raw: unknown): Output {
  const result = schema["~standard"].validate(raw);
  if (typeof (result as PromiseLike<unknown>).then === "function") {
    // Whatever it comes to, nobody is waiting for it.
    (result as Promise<unknown>).then(undefined, () => {});
    const problem = "parseWith: this schema validates asynchronously, and a hook cannot wait for it. Use one without asynchronous checks.";
    // Thrown from `parseCommand` it reaches the client as `invalid_command`, which says nothing of this.
    console.error(`[tickflare] ${problem}`);
    throw new TypeError(problem);
  }
  const { issues } = result as StandardSchemaResult<Output>;
  if (issues) {
    const first = issues[0];
    const path = (first?.path ?? []).map((part) => String(typeof part === "object" ? part.key : part)).join(".");
    reject(`invalid_command: ${first?.message ?? "does not fit the schema"}${path ? ` (at ${path})` : ""}`.slice(0, REASON_LENGTH));
  }
  return (result as { value: Output }).value;
}
