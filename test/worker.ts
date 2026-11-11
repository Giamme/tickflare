import {
  LockstepRoom,
  Matchmaker,
  Room,
  recentMatches,
  recordMatches,
  reject,
  routeToMatchmaker,
  routeToRoom,
  tokenAuth,
  type Player,
} from "../src/server/index.js";

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
  | { type: "lock" }
  | { type: "finish" }
  | { type: "finishThenReject" }
  | { type: "move"; to: string; gold: number }
  | { type: "moveThenReject"; to: string };

const COMMANDS = [
  "add", "secret", "noop", "half", "boom", "async",
  "timer", "timerThenReject", "cancel", "kick", "kickThenReject", "lock",
  "finish", "finishThenReject", "move", "moveThenReject",
];

/** A room that exercises every kernel feature; not a game. */
export class TestRoom extends Room<TestState, TestCommand> {
  protected override maxPlayers = 2;
  protected override matchQueue = this.env.MATCHES;
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
      case "finish":
        this.finishMatch({ winner: player.id, total: this.state.total });
        return;
      case "finishThenReject":
        this.finishMatch({ winner: player.id });
        reject("changed_my_mind");
      case "move":
        this.movePlayer(player.id, command.to, { from: this.roomId, gold: command.gold });
        return;
      case "moveThenReject":
        this.movePlayer(player.id, command.to);
        reject("changed_my_mind");
    }
  }

  protected override async handOver(roomId: string, playerId: string, carry: unknown): Promise<void> {
    const rooms = this.env.ROOMS;
    await rooms.get(rooms.idFromName(roomId)).arrive(roomId, playerId, carry);
  }

  protected override onArrive(player: Player, carry: unknown): void {
    this.state.log.push(`arrive:${player.id}:${JSON.stringify(carry)}`);
  }

  protected override view(player: Player): unknown {
    const mine = this.state.secrets[player.id];
    return { ...this.state, secrets: mine === undefined ? {} : { [player.id]: mine } };
  }
}

export interface TickState {
  phase: "lobby" | "playing";
  /** Goes up by one per tick. */
  count: number;
  /** Per player, `count` times their seat number. `view` hides everyone else's. */
  secrets: Record<string, number>;
  /** Never changes: there to show that patches leave it out. */
  ballast: Record<string, string>;
  bumps: number;
  broken: boolean;
  log: string[];
}

export type TickCommand =
  | { type: "start" | "stop" | "bump" | "half" | "break" | "fix" }
  | { type: "timer"; ms: number };

/** A ticking room: 50 ticks a second while `phase` is "playing". */
export class TickRoom extends Room<TickState, TickCommand> {
  protected override tickRate = 50;
  protected override saveIntervalMs = 100;

  protected initialState(): TickState {
    const ballast: Record<string, string> = {};
    for (let i = 0; i < 50; i++) ballast[`k${i}`] = "x".repeat(20);
    return { phase: "playing", count: 0, secrets: {}, ballast, bumps: 0, broken: false, log: [] };
  }

  protected parseCommand(raw: unknown): TickCommand {
    return raw as TickCommand;
  }

  protected override shouldTick(): boolean {
    return this.state.phase === "playing";
  }

  protected override onTick(): void {
    if (this.state.broken) throw new TypeError("tick kaboom");
    this.state.count += 1;
    this.players.forEach((player, seat) => {
      this.state.secrets[player.id] = this.state.count * (seat + 1);
    });
  }

  protected onCommand(_player: Player, command: TickCommand): void {
    switch (command.type) {
      case "start":
        this.state.phase = "playing";
        return;
      case "stop":
        this.state.phase = "lobby";
        return;
      case "bump":
        this.state.bumps += 1;
        return;
      case "half":
        this.state.count += 1000;
        reject("changed_my_mind");
      case "break":
        this.state.broken = true;
        return;
      case "fix":
        this.state.broken = false;
        return;
      case "timer":
        this.setTimer("bell", command.ms);
        return;
    }
  }

  protected override onTimer(name: string): void {
    this.state.log.push(`timer:${name}`);
  }

  protected override view(player: Player): unknown {
    const mine = this.state.secrets[player.id];
    return { ...this.state, secrets: mine === undefined ? {} : { [player.id]: mine } };
  }
}

export type TurnInput = { type: "add"; n: number };

/** A lockstep room at 50 turns a second. */
export class TurnRoom extends LockstepRoom<TurnInput> {
  protected override tickRate = 50;
  protected override maxInputsPerTurn = 3;
  protected override matchQueue = this.env.MATCHES;
  protected override matchBucket = this.env.REPLAYS;

  // The match is over when the last player gives up their seat.
  protected override onLeave(player: Player): void {
    super.onLeave(player);
    if (this.players.length === 1) this.finishMatch({ reason: "everyone_left" });
  }

  protected parseInput(raw: unknown): TurnInput {
    const input = raw as { type?: unknown; n?: unknown } | null;
    if (input?.type !== "add" || typeof input.n !== "number") reject("bad_input");
    return { type: "add", n: input.n };
  }
}

/** Pairs players and reserves a TestRoom for each pair. */
export class TestMatchmaker extends Matchmaker {
  protected async reserveRoom(
    roomId: string,
    players: string[],
    locationHint: DurableObjectLocationHint | undefined,
  ): Promise<void> {
    const rooms = this.env.ROOMS;
    await rooms.get(rooms.idFromName(roomId), { locationHint }).reserve(roomId, players);
  }
}

/** Signs the join tokens accepted under /secure. */
export const TEST_SECRET = "test-secret-0123456789";

function whoIs(request: Request): string | Response {
  const player = new URL(request.url).searchParams.get("player");
  return player ?? new Response("Who are you?", { status: 401 });
}

export default {
  async fetch(request, env): Promise<Response> {
    const response =
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.TICKS, prefix: "/ticks", authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.TURNS, prefix: "/turns", authenticate: whoIs })) ??
      (await routeToMatchmaker(request, { matchmaker: env.MATCHMAKER, authenticate: whoIs })) ??
      (await routeToRoom(request, {
        rooms: env.ROOMS,
        prefix: "/secure",
        authenticate: tokenAuth({ secret: TEST_SECRET }),
      }));
    if (response) return response;
    if (new URL(request.url).pathname === "/matches") {
      return Response.json(await recentMatches(env.DB, 100));
    }
    return new Response("Not found", { status: 404 });
  },

  async queue(batch, env): Promise<void> {
    await recordMatches(batch, env.DB);
  },
} satisfies ExportedHandler<Cloudflare.Env, import("../src/protocol.js").MatchResult>;
