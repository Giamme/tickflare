import { Room, reject, routeToRoom, type Player } from "../src/server/index.js";

export interface TestState {
  total: number;
  /** Hook calls, in order, so tests can see what the kernel invoked. */
  log: string[];
  /** One private value per player; `view` hides everyone else's. */
  secrets: Record<string, string>;
  /** While true, `onLeave` refuses. */
  locked: boolean;
}

export type TestCommand =
  | { type: "add"; n: number }
  | { type: "secret"; value: string }
  | { type: "noop" }
  | { type: "half" }
  | { type: "boom" }
  | { type: "async" }
  | { type: "timer"; name: string; ms: number }
  | { type: "timerThenReject"; name: string; ms: number }
  | { type: "cancel"; name: string }
  | { type: "kick"; id: string }
  | { type: "kickThenReject"; id: string }
  | { type: "lock" };

const COMMANDS = [
  "add", "secret", "noop", "half", "boom", "async",
  "timer", "timerThenReject", "cancel", "kick", "kickThenReject", "lock",
];

/** A room that exercises every kernel feature; not a game. */
export class TestRoom extends Room<TestState, TestCommand> {
  protected override maxPlayers = 2;
  protected override maxMessageLength = 256;

  protected initialState(): TestState {
    return { total: 0, log: [], secrets: {}, locked: false };
  }

  protected parseCommand(raw: unknown): TestCommand {
    const input = raw as { type?: unknown; n?: unknown; value?: unknown } | null;
    if (typeof input?.type !== "string" || !COMMANDS.includes(input.type)) {
      throw new Error("unknown command");
    }
    if (input.type === "add" && typeof input.n !== "number") reject("n_must_be_a_number");
    if (input.type === "secret" && typeof input.value !== "string") reject("value_must_be_a_string");
    return input as TestCommand;
  }

  protected override onJoin(player: Player): void {
    if (player.id === "banned") reject("not_welcome");
    this.state.log.push(`join:${player.id}`);
  }

  protected override onDisconnect(player: Player): void {
    this.state.log.push(`leave:${player.id}`);
  }

  protected override onReconnect(player: Player): void {
    this.state.log.push(`back:${player.id}`);
  }

  protected override onLeave(player: Player): void {
    if (this.state.locked) reject("locked");
    this.state.log.push(`left:${player.id}`);
  }

  protected override onTimer(name: string): void {
    this.state.log.push(`timer:${name}`);
    if (name === "boom") throw new TypeError("kaboom");
    if (name === "relay") this.setTimer("relayed", 20);
  }

  protected onCommand(player: Player, command: TestCommand): void | Promise<void> {
    switch (command.type) {
      case "add":
        this.state.total += command.n;
        return;
      case "secret":
        this.state.secrets[player.id] = command.value;
        return;
      case "noop":
        return;
      case "half":
        this.state.total += 1000;
        reject("changed_my_mind");
      case "boom":
        this.state.total += 1000;
        throw new TypeError("kaboom");
      case "async":
        return Promise.resolve().then(() => {
          this.state.total += 1000;
        });
      case "timer":
        this.setTimer(command.name, command.ms);
        return;
      case "timerThenReject":
        this.setTimer(command.name, command.ms);
        reject("changed_my_mind");
      case "cancel":
        this.clearTimer(command.name);
        return;
      case "kick":
        this.removePlayer(command.id, "kicked");
        return;
      case "kickThenReject":
        this.removePlayer(command.id, "kicked");
        reject("changed_my_mind");
      case "lock":
        this.state.locked = true;
        return;
    }
  }

  protected override view(player: Player): unknown {
    const mine = this.state.secrets[player.id];
    return { ...this.state, secrets: mine === undefined ? {} : { [player.id]: mine } };
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const response = await routeToRoom(request, {
      rooms: env.ROOMS,
      authenticate(req) {
        const player = new URL(req.url).searchParams.get("player");
        return player ?? new Response("Who are you?", { status: 401 });
      },
    });
    return response ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Cloudflare.Env>;
