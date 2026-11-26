---
type: added
breaking: false
audience: user
commits: 
---
`parseWith(schema, raw)` checks a command against a schema from any library that implements Standard Schema, such as Zod, Valibot or ArkType: `protected parseCommand(raw: unknown) { return parseWith(Command, raw); }`. The room gets what the schema gives back, and what does not fit is refused with the first thing the schema found wrong and where, as `invalid_command: Expected number (at x)`. It works for `parseInput` in a lockstep room too, and Tickflare depends on none of the libraries. See [Checking commands with a schema](https://tickflare.gridpaper.dev/guide/rooms#checking-commands-with-a-schema).
