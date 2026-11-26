import { abortAllDurableObjects, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandRejected, RoomClient } from "../src/client/index.js";
import { seededRandom, type SeededRandom } from "../src/lockstep.js";
import { applyPatch } from "../src/patch.js";
import type { ServerMessage, WelcomeFrame } from "../src/protocol.js";
import { freshRoom, sleep, until, upgrade } from "./helpers.js";
import { WorkerSocket } from "./worker-socket.js";
import type { LedgerCommand, LedgerState } from "./worker.js";

/**
 * Tests that nobody thought of: connections are dropped, cut in one
 * direction, replaced and reloaded, and rooms are put to sleep and
 * restarted, in an order drawn from a seed. The room writes down every
 * command it applies (`LedgerRoom`), so a command that was lost shows as a
 * key that is missing and one applied twice as a count of two.
 *
 * Two layers. The first speaks the protocol itself, as a client that follows
 * the rules of version 5 to the letter, and checks every frame against what
 * the protocol promises. It needs no waiting, so it gets through many steps.
 * The second is the real `RoomClient` over a network that fails, and checks
 * what its promises said against what the room ended up with.
 *
 * A run that fails prints its seed and the steps that led there. To run
 * that one again: `RANDOM_SEEDS=72 npx vitest run test/random.test.ts`, with
 * `RANDOM_TRACE=200` for every step. To search further, with the seeds from
 * 1 to 200: `RANDOM_RUNS=200 npx vitest run test/random.test.ts`.
 */
const RUNS = Number(env.RANDOM_RUNS || 0);
const CHOSEN = env.RANDOM_SEEDS.split(/\D+/).filter(Boolean).map(Number);
/**
 * The last three are runs that found something: a refusal the room forgot
 * in its sleep and then counted as applied (29 and 39), and a page that
 * closed with commands on their way, which were applied a second time (72).
 */
const SEEDS = CHOSEN.length > 0 ? CHOSEN : RUNS > 0 ? Array.from({ length: RUNS }, (_, n) => n + 1) : [1, 2, 3, 29, 39, 72];
/** The runs with the real client wait for its reconnects, so by default there are fewer of them. */
const CLIENT_SEEDS = RUNS > 0 || CHOSEN.length > 0 ? SEEDS : SEEDS.slice(0, 3);
const STEPS = 90;
/** How many of the steps before a fault are printed with it. */
const TRACE = Number(env.RANDOM_TRACE || 15);

type Kind = LedgerCommand["type"];
type Fate = "applied" | "refused" | "unknown";

interface Sent {
  id: number;
  key: string;
  kind: Kind;
  /** Written to a connection, whether or not it got anywhere. */
  written: boolean;
}

interface Link {
  ws: WebSocket;
  /** What this end sends still arrives. */
  up: boolean;
  /** What the room sends is still read. */
  down: boolean;
  welcomes: number;
  closed: boolean;
}

const opened: WebSocket[] = [];
afterEach(() => {
  for (const ws of opened.splice(0)) {
    try {
      ws.close(1000, "test_done");
    } catch {
      // Already closed.
    }
  }
});

/** One run: the room, what was sent to it, and everything that went against the rules. */
class World {
  readonly room = freshRoom();
  /** What became of each command, as its client was told. */
  readonly fates = new Map<string, Fate>();
  readonly kinds = new Map<string, Kind>();
  readonly faults: string[] = [];
  readonly trace: string[] = [];

  constructor(
    readonly prefix: "/ledger" | "/tickledger",
    readonly seed: number,
  ) {}

  get ticking(): boolean {
    return this.prefix === "/tickledger";
  }

  get stub(): DurableObjectStub {
    const rooms: DurableObjectNamespace = this.ticking ? env.TICKLEDGER : env.LEDGER;
    return rooms.get(rooms.idFromName(this.room));
  }

  note(line: string): void {
    this.trace.push(line);
  }

  fault(what: string): void {
    // The first says how the run got there. The ones after it are mostly its consequences.
    if (this.faults.length === 0) this.faults.push(`${what}\n  after:\n    ${this.trace.slice(-TRACE).join("\n    ")}`);
    else if (this.faults.length < 4) this.faults.push(what);
  }

  /** A state someone was sent, or the one in storage: no command may show in it twice. */
  look(state: LedgerState, where: string): void {
    for (const [key, count] of Object.entries(state.seen)) {
      if (count !== 1) this.fault(`${where}: ${key} was applied ${count} times`);
      if (this.kinds.get(key) !== "mark") this.fault(`${where}: ${key} shows, and it was ${this.kinds.get(key) ?? "never sent"}`);
    }
    // One client's commands are applied in the order it numbered them.
    const latest = new Map<string, number>();
    for (const key of state.order) {
      const [player, generation, id] = key.split("/");
      const client = `${player}/${generation}`;
      if (Number(id) <= (latest.get(client) ?? 0)) this.fault(`${where}: ${key} was applied after a later command of the same client`);
      latest.set(client, Number(id));
    }
  }

  /** The state as it is in storage. */
  stored(): Promise<LedgerState> {
    return runInDurableObject(this.stub, (_instance, state) => JSON.parse(state.storage.sql.exec<{ state: string }>("SELECT state FROM tickflare_room").one().state) as LedgerState);
  }

  passed(): void {
    expect(this.faults, `seed ${this.seed}, room ${this.room}`).toEqual([]);
  }
}

/**
 * A client of version 5 that does exactly what the protocol says and no
 * more, and holds the room to its side of it.
 */
class Reference {
  generation = 0;
  name = "";
  nextId = 1;
  /** From this id on, the room's count of this client's commands is one to go by. */
  floor = 1;
  /** Every command of this generation, by id. */
  all = new Map<number, Sent>();
  /** Those not answered yet, in the order of their ids. */
  waiting = new Map<number, Sent>();
  /** Answered as applied, and then gone with a restart: a ticking room goes back to its last save. */
  undone = new Set<number>();
  link: Link | undefined;
  view: LedgerState | undefined;

  constructor(
    readonly world: World,
    readonly player: string,
  ) {
    this.reload();
  }

  /** Whether this client believes it has a connection. */
  get online(): boolean {
    return this.link !== undefined && !this.link.closed;
  }

  /** The page was loaded again: a client with another name, that counts from 1. */
  reload(): void {
    this.hangUp();
    for (const sent of this.waiting.values()) if (sent.written) this.#fate(sent.key, "unknown");
    this.generation += 1;
    this.name = `g${this.generation}`;
    this.nextId = 1;
    this.floor = 1;
    this.all = new Map();
    this.waiting = new Map();
    this.undone = new Set();
  }

  async connect(closeOld = true): Promise<void> {
    const old = this.link;
    if (old) {
      // Whatever still arrives on the old one is not read, and nothing more is sent on it.
      old.up = false;
      old.down = false;
      if (closeOld) this.hangUp();
    }
    const { prefix, room } = this.world;
    const response = await upgrade(`${prefix}/${room}?player=${this.player}&v=5&client=${this.name}`);
    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    const link: Link = { ws, up: true, down: true, welcomes: 0, closed: false };
    ws.addEventListener("message", (event) => {
      if (link.down && this.link === link) this.#hear(link, JSON.parse(event.data as string) as ServerMessage<LedgerState>);
    });
    ws.addEventListener("close", () => {
      link.closed = true;
    });
    ws.accept();
    opened.push(ws);
    this.link = link;
    await until(() => link.welcomes > 0 || link.closed, `a welcome for ${this.player}`);
  }

  /** The connection is closed from this end. */
  hangUp(): void {
    const link = this.link;
    if (!link) return;
    link.up = false;
    link.down = false;
    link.closed = true;
    try {
      link.ws.close(1000, "dropped");
    } catch {
      // Already closed.
    }
  }

  /** Sends a new command, or holds it for the next connection. */
  send(kind: Kind): void {
    const id = this.nextId++;
    const sent: Sent = { id, key: `${this.player}/${this.name}/${id}`, kind, written: false };
    this.world.kinds.set(sent.key, kind);
    this.all.set(id, sent);
    this.waiting.set(id, sent);
    if (this.online) this.#write(sent);
  }

  /** Sends again a command the room has answered as applied. It must be answered so again, and not applied. */
  repeat(random: SeededRandom): boolean {
    const answered = [...this.all.values()].filter(
      (sent) => sent.id >= this.floor && !this.waiting.has(sent.id) && !this.undone.has(sent.id) && this.world.fates.get(sent.key) === "applied",
    );
    if (answered.length === 0 || !this.online) return false;
    this.#write(answered[Math.floor(random() * answered.length)]!);
    return true;
  }

  #write(sent: Sent): void {
    sent.written = true;
    const link = this.link;
    if (!link || !link.up || link.closed) return;
    try {
      link.ws.send(JSON.stringify({ t: "cmd", id: sent.id, data: { type: sent.kind, key: sent.key } }));
    } catch {
      // Closed under us: lost on the way, as far as anyone can tell.
    }
  }

  #fate(key: string, fate: Fate): void {
    const before = this.world.fates.get(key);
    if (before !== undefined && before !== "unknown" && before !== fate) this.world.fault(`${key} was answered as ${before} and then as ${fate}`);
    this.world.fates.set(key, fate);
  }

  #hear(link: Link, frame: ServerMessage<LedgerState>): void {
    const who = `${this.player}/${this.name}`;
    switch (frame.t) {
      case "welcome":
        link.welcomes += 1;
        this.view = frame.state;
        this.#welcomed(frame, link.welcomes > 1);
        break;
      case "state":
        this.view = frame.state;
        this.#shown(frame.c);
        break;
      case "patch":
        this.view = applyPatch(this.view!, frame.p);
        this.#shown(frame.c);
        break;
      case "ack": {
        const sent = this.waiting.get(frame.id);
        if (sent) this.#applied(sent, "an ack");
        break;
      }
      case "reject": {
        const sent = this.waiting.get(frame.id) ?? this.all.get(frame.id);
        if (!sent) break;
        this.waiting.delete(frame.id);
        if (sent.kind !== "refuse" || frame.reason !== "no") this.world.fault(`${who}: ${sent.key} was refused with ${frame.reason}`);
        this.#fate(sent.key, "refused");
        break;
      }
      case "error":
        this.world.fault(`${who}: the room could not read a frame: ${frame.reason}`);
        break;
    }
    if (this.view) this.world.look(this.view, `the view of ${who}`);
  }

  /** The room says `sent` was applied: the view this client holds has to show it. */
  #applied(sent: Sent, by: string): void {
    this.waiting.delete(sent.id);
    if (sent.kind === "refuse") this.world.fault(`${by} says ${sent.key} was applied, and it was one to refuse`);
    else if (this.view?.seen[sent.key] !== 1) this.world.fault(`${by} says ${sent.key} was applied, and the view does not show it`);
    this.#fate(sent.key, "applied");
  }

  /** A `state` or `patch` that says which of this client's commands it shows. */
  #shown(c: number | undefined): void {
    if (c === undefined) return;
    for (const sent of [...this.waiting.values()]) {
      if (sent.id <= c) this.#applied(sent, `a frame with c=${c}`);
    }
  }

  #welcomed(frame: WelcomeFrame<LedgerState>, again: boolean): void {
    const { world } = this;
    const who = `${this.player}/${this.name}`;
    const seen = frame.state.seen;
    if (frame.c === undefined) {
      // The room knows nothing of what was sent: it is given up, and never sent again.
      for (const sent of [...this.waiting.values()]) {
        if (!sent.written) continue;
        this.waiting.delete(sent.id);
        this.#fate(sent.key, "unknown");
      }
      this.floor = this.waiting.keys().next().value ?? this.nextId;
      world.note(`${who} welcomed, told nothing`);
      for (const sent of this.waiting.values()) this.#write(sent);
      return;
    }
    const c = frame.c;
    const from = frame.from ?? 0;
    world.note(`${who} welcomed, c=${c}${from > 0 ? `, from=${from}` : ""}`);
    if (again) world.fault(`${who}: a welcome on a connection that was open said how far the room got`);
    if (from > c) world.fault(`${who}: the room says it can tell from ${from}, which is past the ${c} it got to`);
    const refused = new Map(frame.refused ?? []);

    // Up to `from` the room cannot say what became of a command: it is given up, and held to nothing.
    for (const sent of [...this.waiting.values()]) {
      if (sent.id > from) continue;
      if (!sent.written) world.fault(`${who}: the room counted past ${sent.key}, which was never sent`);
      this.waiting.delete(sent.id);
      this.#fate(sent.key, "unknown");
    }
    this.floor = Math.max(this.floor, from + 1);

    // What the room says it handled is what its state shows: the two are saved together.
    for (const sent of this.all.values()) {
      if (sent.id < this.floor || sent.kind !== "mark") continue;
      const shows = seen[sent.key] !== undefined;
      const answered = !this.waiting.has(sent.id) && world.fates.get(sent.key) === "applied";
      if (sent.id <= c && !shows && !this.undone.has(sent.id)) {
        world.fault(`${who}: the room says it handled ${sent.key}, and its state does not show it`);
      } else if (sent.id > c && shows) {
        world.fault(`${who}: the state shows ${sent.key}, which the room says it has not handled`);
      } else if (sent.id > c && answered && !this.undone.has(sent.id)) {
        // Answered, and gone again: the room went back to a save from before it.
        if (!world.ticking) world.fault(`${who}: ${sent.key} was answered as applied, and is gone`);
        this.undone.add(sent.id);
      }
    }

    for (const sent of [...this.waiting.values()]) {
      if (sent.id > c) {
        // Not handled: sent again, or for the first time, in order and before anything new.
        this.#write(sent);
        continue;
      }
      if (!sent.written) world.fault(`${who}: the room says it handled ${sent.key}, which was never sent`);
      this.waiting.delete(sent.id);
      if (refused.has(sent.id)) {
        if (sent.kind !== "refuse") world.fault(`${who}: the welcome says ${sent.key} was refused`);
        this.#fate(sent.key, "refused");
      } else {
        if (sent.kind === "refuse") world.fault(`${who}: the welcome says ${sent.key} was applied, and it was one to refuse`);
        this.#fate(sent.key, "applied");
      }
    }
  }
}

/** Puts the room to sleep, as Cloudflare does with one that has nothing to do. */
async function asleep(world: World): Promise<void> {
  try {
    await evictDurableObject(world.stub);
  } catch (err) {
    // A room that was restarted and not reached since is not running: there is nothing to put to sleep.
    if (!String(err).includes("not currently running")) throw err;
  }
}

/** Runs `STEPS` random steps against one room, with two players. */
async function wander(world: World): Promise<Reference[]> {
  const random = seededRandom(world.seed);
  const players = [new Reference(world, "p1"), new Reference(world, "p2")];
  for (const player of players) await player.connect();

  for (let step = 0; step < STEPS && world.faults.length === 0; step++) {
    const who = players[Math.floor(random() * players.length)]!;
    const roll = random();
    const name = `${who.player}/${who.name}`;
    if (!who.online) {
      if (roll < 0.2 && who.waiting.size < 6) {
        world.note(`${name} sends while it has no connection`);
        who.send(random() < 0.8 ? "mark" : "refuse");
      } else if (roll < 0.3) {
        world.note(`${who.player} loads the page again`);
        who.reload();
        await who.connect();
      } else {
        world.note(`${name} connects`);
        await who.connect();
      }
    } else if (roll < 0.45) {
      if (who.waiting.size < 6) {
        const kind = random() < 0.8 ? "mark" : "refuse";
        world.note(`${name} sends ${kind} ${who.nextId}`);
        who.send(kind);
      }
    } else if (roll < 0.52) {
      world.note(`${name}: what it sends no longer arrives`);
      who.link!.up = false;
    } else if (roll < 0.57) {
      world.note(`${name}: what the room sends no longer arrives`);
      who.link!.down = false;
    } else if (roll < 0.67) {
      world.note(`${name} loses its connection`);
      who.hangUp();
    } else if (roll < 0.72) {
      world.note(`${name} connects again while the room still has the old connection`);
      await who.connect(false);
    } else if (roll < 0.77) {
      if (who.repeat(random)) world.note(`${name} sends an answered command again`);
    } else if (roll < 0.82 && !world.ticking) {
      // A ticking room is never asleep with its players connected.
      world.note("the room is put to sleep");
      await asleep(world);
    } else if (roll < 0.87) {
      world.note("the room is restarted");
      await abortAllDurableObjects();
      // Every connection went with it, as each client finds out in its own time.
      for (const player of players) player.hangUp();
    } else {
      // Time for answers to arrive, and in a ticking room for a save to happen or not.
      await sleep(Math.floor(random() * (world.ticking ? 60 : 4)));
    }
    if (random() < 0.5) await sleep(0);
  }

  // Everyone comes back on a connection that works, and waits for every answer.
  for (const player of players) {
    await player.connect();
    await until(() => player.waiting.size === 0 || world.faults.length > 0, `the answers ${player.player} is owed`);
  }
  return players;
}

describe("a room, against a client that keeps to the protocol while everything fails at random", () => {
  it.each(SEEDS)("loses no command and applies none twice (seed %i)", async (seed) => {
    const world = new World("/ledger", seed);
    await wander(world);
    world.passed();

    // Outside a simulation every change is saved before it is answered: storage is the truth.
    const stored = await world.stored();
    world.look(stored, "storage");
    for (const [key, fate] of world.fates) {
      const count = stored.seen[key];
      if (fate === "applied" && count !== 1) world.fault(`${key} was answered as applied, and storage has it ${count ?? 0} times`);
      if (fate === "refused" && count !== undefined) world.fault(`${key} was refused, and storage has it`);
    }
    world.passed();
    // Enough happened for the run to mean something.
    expect(Object.keys(stored.seen).length).toBeGreaterThan(5);
  });

  it.each(SEEDS)("does the same while it ticks, where a restart goes back to the last save (seed %i)", async (seed) => {
    const world = new World("/tickledger", seed);
    const players = await wander(world);
    world.passed();

    for (const player of players) {
      const view = player.view!;
      world.look(view, `the last view of ${player.player}`);
      for (const sent of player.all.values()) {
        // What this client's count covers, and no restart undid, is there.
        if (sent.id < player.floor || player.undone.has(sent.id) || world.fates.get(sent.key) !== "applied") continue;
        if (view.seen[sent.key] !== 1) world.fault(`${sent.key} was answered as applied, and the last view has it ${view.seen[sent.key] ?? 0} times`);
      }
    }
    world.passed();
  });
});

describe("RoomClient and a room, while the network and the room fail at random", () => {
  beforeEach(() => {
    WorkerSocket.all = [];
    vi.stubGlobal("WebSocket", WorkerSocket);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** What each promise of `send` came to: "applied", or the reason it was rejected with. */
  async function play(prefix: "/ledger" | "/tickledger", seed: number, steps: number) {
    const world = new World(prefix, seed);
    const random = seededRandom(seed);
    const client = new RoomClient<LedgerState, LedgerCommand>(`wss://tickflare.test${prefix}/${world.room}?player=p1`, { keepCommandsMs: 60_000 });
    const outcomes = new Map<string, string>();
    const promises: Promise<void>[] = [];
    /** Sent since the room was last restarted: nothing can have undone these. */
    let sinceRestart = new Set<string>();
    client.on("state", (state) => world.look(state, "the client's state"));
    // The latest connection of this client, and of no client an earlier test left behind.
    const socket = () => WorkerSocket.all.filter((ws) => ws.url.includes(world.room)).at(-1)!;
    let next = 1;
    let refusals = 0;

    for (let step = 0; step < steps; step++) {
      const roll = random();
      if (roll < 0.5) {
        // The room remembers eight refusals of a client. With a ninth still unanswered it says of
        // the earliest that it cannot tell, which the layer above covers. Here no run gets that
        // far, so that every answer can be held to what the command was.
        const kind: Kind = refusals < 8 && random() >= 0.8 ? "refuse" : "mark";
        if (kind === "refuse") refusals += 1;
        const key = `p1/c/${next++}`;
        world.kinds.set(key, kind);
        sinceRestart.add(key);
        world.note(`sends ${kind} ${key} while ${client.status}`);
        promises.push(
          client.send({ type: kind, key }).then(
            () => void outcomes.set(key, "applied"),
            (err: unknown) => void outcomes.set(key, err instanceof CommandRejected ? err.reason : String(err)),
          ),
        );
      } else if (roll < 0.6) {
        world.note("what the client sends no longer arrives");
        socket().send = () => {};
      } else if (roll < 0.75) {
        world.note("the connection drops");
        socket().drop();
      } else if (roll < 0.82) {
        world.note("the room is restarted");
        await abortAllDurableObjects();
        sinceRestart = new Set();
      } else if (roll < 0.87 && !world.ticking) {
        world.note("the room is put to sleep");
        await asleep(world);
      } else {
        await sleep(Math.floor(random() * 40));
      }
      if (random() < 0.5) await sleep(0);
    }

    // The network comes back for good: a connection that swallowed what it was sent is of no use.
    socket().drop();
    await Promise.all(promises);
    await until(() => client.status === "open", "the last connection");
    world.note("settled");
    return { world, client, outcomes, sinceRestart };
  }

  it.each(CLIENT_SEEDS)("resolves what was applied and rejects what was refused, each once (seed %i)", async (seed) => {
    const { world, client, outcomes } = await play("/ledger", seed, 45);
    world.passed();
    const stored = await world.stored();
    world.look(stored, "storage");
    for (const [key, kind] of world.kinds) {
      // Nothing is given up: the room always knows this client, and says what became of each.
      expect(outcomes.get(key), `${key}, seed ${seed}`).toBe(kind === "mark" ? "applied" : "no");
      expect(stored.seen[key], `${key}, seed ${seed}`).toBe(kind === "mark" ? 1 : undefined);
    }
    world.passed();
    expect(client.unconfirmed).toEqual([]);
    expect(client.state).toEqual(stored);
    client.close();
  });

  it.each(CLIENT_SEEDS)("does the same against a room that ticks (seed %i)", async (seed) => {
    const { world, client, outcomes, sinceRestart } = await play("/tickledger", seed, 45);
    world.passed();
    // One more command, so that the state the client holds is of after everything else.
    world.kinds.set("p1/c/last", "mark");
    await client.send({ type: "mark", key: "p1/c/last" });
    const state = client.state!;
    world.look(state, "the client's last state");
    for (const [key, kind] of world.kinds) {
      if (key === "p1/c/last") continue;
      expect(outcomes.get(key), `${key}, seed ${seed}`).toBe(kind === "mark" ? "applied" : "no");
      if (kind === "refuse") expect(state.seen[key], `${key}, seed ${seed}`).toBeUndefined();
      // A restart may have taken back what was answered before it, and nothing since.
      else if (sinceRestart.has(key)) expect(state.seen[key], `${key}, seed ${seed}`).toBe(1);
    }
    world.passed();
    expect(client.unconfirmed).toEqual([]);
    client.close();
  });
});
