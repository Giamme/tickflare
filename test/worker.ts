import {
  Accounts,
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
  | { type: "moveThenReject"; to: string }
  | { type: "signal"; to: string; text: string; quiet?: boolean }
  | { type: "signalThenReject"; to: string }
  | { type: "tell"; to: string; text: string }
  | { type: "shout"; text: string }
  | { type: "tellThenReject"; to: string }
  | { type: "kickWithNote"; id: string }
  | { type: "delete" }
  | { type: "deleteThenReject" }
  | { type: "finishAndDelete" };

const COMMANDS = [
  "add", "secret", "noop", "half", "boom", "async",
  "timer", "timerThenReject", "cancel", "kick", "kickThenReject", "lock",
  "finish", "finishThenReject", "move", "moveThenReject", "signal", "signalThenReject",
  "tell", "shout", "tellThenReject", "kickWithNote", "delete", "deleteThenReject", "finishAndDelete",
];

/** A room that exercises every kernel feature; not a game. */
export class TestRoom extends Room<TestState, TestCommand> {
  protected override maxPlayers = 2;
  protected override matchQueue = this.env.MATCHES;
  protected override rooms = this.env.ROOMS;
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
    if (this.invited) this.state.log.push(`invited:${this.invited.join(",")}`);
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
    if (name === "close") this.deleteRoom();
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
      case "signal":
        this.signal(command.to, { text: command.text }, { onlyIfWatched: command.quiet });
        return;
      case "signalThenReject":
        this.signal(command.to, { text: "never sent" });
        reject("changed_my_mind");
      case "tell":
        this.state.total += 1;
        this.send(command.to, { from: player.id, text: command.text });
        return;
      case "shout":
        this.broadcast({ from: player.id, text: command.text });
        return;
      case "tellThenReject":
        this.send(command.to, { text: "never sent" });
        reject("changed_my_mind");
      case "kickWithNote":
        this.send(command.id, { text: "you are out" });
        this.removePlayer(command.id, "kicked");
        return;
      case "delete":
        this.deleteRoom();
        return;
      case "deleteThenReject":
        this.deleteRoom();
        reject("changed_my_mind");
      case "finishAndDelete":
        this.finishMatch({ winner: player.id });
        this.deleteRoom();
        return;
    }
  }

  protected override onSignal(fromRoomId: string, data: unknown): void {
    this.state.log.push(`heard:${fromRoomId}:${(data as { text: string }).text}`);
  }


  protected override onArrive(player: Player, carry: unknown): void {
    this.state.log.push(`arrive:${player.id}:${JSON.stringify(carry)}`);
  }

  protected override view(player: Player): unknown {
    const mine = this.state.secrets[player.id];
    return { ...this.state, secrets: mine === undefined ? {} : { [player.id]: mine } };
  }
}

/** TestRoom, except that a player who stays away for 150 ms loses their seat. */
export class AwayRoom extends TestRoom {
  protected override seatTimeoutMs = 150;
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

/** A lockstep room that sleeps between turns: 20 a second, asked for by its players. */
export class AskedTurnRoom extends LockstepRoom<TurnInput> {
  protected override tickRate = 20;
  protected override turnClock = "players" as const;
  protected override saveIntervalMs = 500; // a checkpoint every ten turns
  protected override seatTimeoutMs = 400;

  protected parseInput(raw: unknown): TurnInput {
    const input = raw as { type?: unknown; n?: unknown } | null;
    if (input?.type !== "add" || typeof input.n !== "number") reject("bad_input");
    return { type: "add", n: input.n };
  }
}

/** A lockstep room at 50 turns a second. */
export class TurnRoom extends LockstepRoom<TurnInput> {
  protected override tickRate = 50;
  protected override maxInputsPerTurn = 3;
  protected override seatTimeoutMs = 400;
  protected override matchQueue = this.env.MATCHES;
  protected override matchBucket = this.env.REPLAYS;

  // The match is over when the last player gives up their seat.
  protected override onLeave(player: Player): void {
    if (this.players.length === 1) {
      this.finishMatch({ reason: "everyone_left" });
      // Rooms named "once-…" are for one match, and delete themselves when it is over.
      if (this.roomId?.startsWith("once-")) this.deleteRoom();
    }
  }

  protected parseInput(raw: unknown): TurnInput {
    const input = raw as { type?: unknown; n?: unknown } | null;
    if (input?.type !== "add" || typeof input.n !== "number") reject("bad_input");
    return { type: "add", n: input.n };
  }
}

/** Pairs players and reserves a TestRoom for each pair. */
export class TestMatchmaker extends Matchmaker {
  protected override rooms = this.env.ROOMS;
}

/** Waits for four players, but starts with two or more once the first has waited 150 ms. */
export class PatientMatchmaker extends TestMatchmaker {
  protected override matchSize = 4;
  protected override minPlayers = 2;
  protected override maxWaitMs = 150;
}

/** Signs the join tokens accepted under /secure. */
export const TEST_SECRET = "test-secret-0123456789";

/** TestRoom that writes down the names its players come with. */
export class NameRoom extends TestRoom {
  protected override onJoin(player: Player): void {
    this.state.log.push(`join:${player.id}:${player.name ?? "-"}`);
    this.send(player.id, { hello: player.name ?? player.id });
  }

  protected override onReconnect(player: Player): void {
    this.state.log.push(`back:${player.id}:${player.name ?? "-"}`);
  }

  protected override onHttp(_request: Request, player: Player): Response {
    return Response.json({ id: player.id, name: player.name ?? null });
  }
}

export function testAccounts(env: Cloudflare.Env): Accounts {
  return new Accounts(env.DB, {
    secret: TEST_SECRET,
    allowedOrigins: ["https://allowed.test"],
    data: {
      avatar: { read: "public", write: "owner" },
      settings: { write: "owner" },
      rating: { read: "public" },
    },
    maxDataKeys: 4,
    maxDataBytes: 1024,
    // Accounts brought over from elsewhere carry "plain:<password>", which nobody should ever do.
    verifyImportedPassword: (hash, password) => hash === `plain:${password}`,
  });
}

function whoIs(request: Request): string | Response {
  const player = new URL(request.url).searchParams.get("player");
  return player ?? new Response("Who are you?", { status: 401 });
}

// ---------------------------------------------------------------------------
// Fixtures for the awkward cases: slow deliveries, restarts mid-simulation, values that cannot be saved.
// ---------------------------------------------------------------------------

/**
 * TestRoom with a handover that takes 100 ms, as an RPC to a cold room might,
 * that fails for rooms called "nowhere-...", and a few extra commands.
 */
export class EdgeRoom extends TestRoom {
  protected override maxPlayers = 4;
  protected override matchBucket = this.env.REPLAYS;
  protected override rooms = this.env.EDGE;

  protected override parseCommand(raw: unknown): TestCommand {
    const type = (raw as { type?: unknown } | null)?.type;
    if (typeof type === "string" && type.startsWith("edge:")) return raw as TestCommand;
    return super.parseCommand(raw);
  }

  protected override onJoin(player: Player): void {
    const me = this.players.find((p) => p.id === player.id);
    this.state.log.push(`join:${player.id}:${me?.connected}`);
  }

  protected override onCommand(player: Player, command: TestCommand): void | Promise<void> {
    const c = command as unknown as { type: string; id?: string; to?: string };
    switch (c.type) {
      case "edge:finishBig":
        this.state.total += 5;
        this.finishMatch({ n: BigInt(1) as unknown as number });
        return;
      case "edge:moveAndDelete":
        this.movePlayer(player.id, c.to!, { gold: 7 });
        this.deleteRoom();
        return;
      case "edge:scribbleAndDelete":
        this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (text TEXT NOT NULL)");
        this.ctx.storage.sql.exec("INSERT INTO notes (text) VALUES ('goes with the room')");
        this.deleteRoom();
        return;
      case "edge:tellThenDelete":
        // What a room does to take itself off a list somewhere before it goes.
        this.defer(async () => {
          await scheduler.wait(150);
          await this.env.REPLAYS.put(`farewell/${this.roomId}`, "gone");
        });
        this.deleteRoom();
        return;
      case "edge:moveOther":
        this.movePlayer(c.id!, c.to!, { gold: 7 });
        return;
      case "edge:carryBad":
        this.state.total += 5;
        this.movePlayer(player.id, c.to!, { n: BigInt(1) });
        return;
      case "edge:later":
        this.state.log.push("asked");
        this.defer(async () => {
          await scheduler.wait(20);
          const outcome = await this.act(() => {
            this.state.log.push("later");
          });
          await this.act(() => {
            this.state.log.push(`outcome:${outcome.ok}`);
          });
        });
        return;
      case "edge:laterThenReject":
        this.defer(() => this.act(() => void this.state.log.push("never")));
        return reject("changed_my_mind");
      case "edge:actRejects":
        this.defer(async () => {
          const outcome = await this.act(() => {
            this.state.total += 1000;
            reject("not_now");
          });
          await this.act(() => void this.state.log.push(`refused:${outcome.ok ? "" : outcome.reason}`));
        });
        return;
      case "edge:scribble": {
        // A hook that keeps something in the room's database itself, then changes its mind.
        const sql = this.ctx.storage.sql;
        sql.exec("CREATE TABLE IF NOT EXISTS notes (text TEXT NOT NULL)");
        sql.exec("INSERT INTO notes (text) VALUES ('written by a hook that failed')");
        return reject("changed_my_mind");
      }
    }
    return super.onCommand(player, command);
  }

  /** Reading is all onHttp is for. This one changes the state anyway. */
  protected override onHttp(): Response {
    this.state.total += 1000;
    return new Response("poked");
  }

  protected override async handOver(roomId: string, playerId: string, carry: unknown): Promise<void> {
    await scheduler.wait(100);
    if (roomId.startsWith("nowhere-")) throw new Error("that room cannot be reached");
    await super.handOver(roomId, playerId, carry);
  }
}

/** TickRoom that never reaches its save interval during a test, and can finish a match. */
export class LazyTickRoom extends TickRoom {
  protected override saveIntervalMs = 60_000;
  protected override matchQueue = this.env.MATCHES;

  protected override onCommand(player: Player, command: TickCommand): void {
    if ((command as { type: string }).type === "win") {
      this.state.bumps = 99;
      this.finishMatch({ winner: player.id });
      return;
    }
    super.onCommand(player, command);
  }
}

/** One command every two seconds. */
export class HalfRate extends TestRoom {
  protected override maxCommandsPerSecond = 0.5;
}

/** A matchmaker whose reservation takes 100 ms and is written down. */
export class SlowLobby extends TestMatchmaker {
  protected override async reserveRoom(
    roomId: string,
    players: string[],
    locationHint: DurableObjectLocationHint | undefined,
  ): Promise<void> {
    await scheduler.wait(100);
    await this.ctx.storage.put(`reserved:${roomId}`, players);
    await super.reserveRoom(roomId, players, locationHint);
  }
}

/** A matchmaker whose first reservation fails. */
export class FlakyLobby extends TestMatchmaker {
  #failed = false;

  protected override async reserveRoom(
    roomId: string,
    players: string[],
    locationHint: DurableObjectLocationHint | undefined,
  ): Promise<void> {
    if (!this.#failed) {
      this.#failed = true;
      throw new Error("no room to be had");
    }
    await super.reserveRoom(roomId, players, locationHint);
  }
}

export default {
  async fetch(request, env): Promise<Response> {
    const accounts = testAccounts(env);
    const response =
      (await accounts.route(request)) ??
      (await routeToRoom(request, { rooms: env.NAMES, prefix: "/named", authenticate: accounts.authenticate })) ??
      (await routeToRoom(request, { rooms: env.NAMES, prefix: "/members", authenticate: accounts.requireAccount })) ??
      (await routeToRoom(request, { rooms: env.NAMES, prefix: "/tokens", authenticate: tokenAuth({ secret: TEST_SECRET }) })) ??
      (await routeToRoom(request, { rooms: env.NAMES, prefix: "/greet", authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.ROOMS, authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.TICKS, prefix: "/ticks", authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.TURNS, prefix: "/turns", authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.ASKED, prefix: "/asked", authenticate: whoIs })) ??
      (await routeToMatchmaker(request, { matchmakers: env.MATCHMAKER, authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.AWAY, prefix: "/away", authenticate: whoIs })) ??
      (await routeToMatchmaker(request, { matchmakers: env.PATIENT, prefix: "/patient", authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.EDGE, prefix: "/edge", authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.LAZY, prefix: "/lazy", authenticate: whoIs })) ??
      (await routeToRoom(request, { rooms: env.HALF, prefix: "/half", authenticate: whoIs })) ??
      (await routeToMatchmaker(request, { matchmakers: env.SLOW, prefix: "/slow", authenticate: whoIs })) ??
      (await routeToMatchmaker(request, { matchmakers: env.FLAKY, prefix: "/flaky", authenticate: whoIs })) ??
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
