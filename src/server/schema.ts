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
    /** The version of the specification the schema implements. */
    readonly version: 1;
    /** The library the schema comes from, such as `zod`. */
    readonly vendor: string;
    /** Checks a value. A schema with asynchronous checks returns a promise, which `parseWith` does not take. */
    readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    /** Never there at run time: it carries the types a schema takes and gives, for TypeScript to infer from. */
    readonly types?:
      | {
          /** What the schema takes. */
          readonly input: Input;
          /** What it gives back. */
          readonly output: Output;
        }
      | undefined;
  };
}

/** What a Standard Schema makes of a value: the value as it should be, or what is wrong with it. */
export type StandardSchemaResult<Output> =
  | {
      /** The value as the schema gives it back: checked, and changed where the schema changes things. */
      readonly value: Output;
      /** Absent when the value fits. */
      readonly issues?: undefined;
    }
  | {
      /** What is wrong with the value, the first thing first. */
      readonly issues: ReadonlyArray<StandardSchemaIssue>;
    };

/** One thing a Standard Schema found wrong, and where. */
export interface StandardSchemaIssue {
  /** What is wrong, in the library's words. */
  readonly message: string;
  /** Where in the value: the keys that lead there, each as it is or as `{ key }`. */
  readonly path?:
    | ReadonlyArray<
        | PropertyKey
        | {
            /** One key on the way. */
            readonly key: PropertyKey;
          }
      >
    | undefined;
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
