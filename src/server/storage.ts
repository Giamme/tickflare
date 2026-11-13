import type { MatchResult } from "../protocol.js";

/** The room as last saved. `state` and `roster` are JSON. */
export interface StoredRoom {
  seq: number;
  state: string;
  roster: string;
  /** How many times the simulation has ticked. 0 in a room that does not tick. */
  tick: number;
}

/** Something a committed hook promised to deliver: a finished match, or a player handed to another room. */
export type OutboxEntry =
  | { message: MatchResult; replay?: string; move?: undefined }
  | { move: { player: string; to: string; carry: unknown } };

/** Where a player who was handed to another room has gone. */
export interface Forward {
  room: string;
  /** The other room has accepted them. */
  delivered: boolean;
  /** When this stops being followed, in epoch milliseconds. Null until the player has been told. */
  expires: number | null;
}

/**
 * Everything a room keeps in its Durable Object's SQLite database, in one
 * place. Calls are synchronous; writes made within one event are committed
 * together by the runtime.
 *
 * Nothing is written, not even the tables, until the room has something to
 * keep. A Durable Object that never wrote does not exist once it shuts down,
 * so a room that was only looked at, or that refused whoever came, leaves
 * nothing behind.
 *
 * Tables:
 *   tickflare_room      one row: seq, state, seats, tick counter
 *   tickflare_timers    named timers and when they fire
 *   tickflare_meta      small values by key (room id, invited players)
 *   tickflare_outbox    deliveries that are owed (finished matches, handovers)
 *   tickflare_arrivals  players another room has handed over, until they connect
 *   tickflare_forwards  players handed to another room, and where they went
 */
export class RoomStorage {
  readonly #storage: DurableObjectStorage;
  readonly #sql: SqlStorage;
  /** The tables are there. */
  #made: boolean;
  /** The id the room is reached under, to be written with the first thing that is. */
  #roomId: string | undefined;

  constructor(storage: DurableObjectStorage) {
    this.#storage = storage;
    const sql = (this.#sql = storage.sql);
    this.#made = this.#exists();
    if (!this.#made) return;
    // The tick counter used to be a row of its own in tickflare_meta, which made every save of a
    // ticking room two rows. A room that was created before has no column for it yet.
    try {
      sql.exec("SELECT tick FROM tickflare_room LIMIT 0");
    } catch {
      sql.exec("ALTER TABLE tickflare_room ADD COLUMN tick INTEGER NOT NULL DEFAULT 0");
    }
  }

  /** Creates the tables, before the first thing is written. */
  #make(): void {
    if (this.#made) return;
    const sql = this.#sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS tickflare_room (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         seq INTEGER NOT NULL,
         state TEXT NOT NULL,
         players TEXT NOT NULL,
         tick INTEGER NOT NULL DEFAULT 0
       )`,
    );
    // WITHOUT ROWID: a table keyed by text otherwise keeps a second index, and every write to it is
    // billed as two rows. These two are written on every save and every timer.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS tickflare_timers (
         name TEXT PRIMARY KEY,
         fire_at INTEGER NOT NULL
       ) WITHOUT ROWID`,
    );
    sql.exec("CREATE TABLE IF NOT EXISTS tickflare_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    sql.exec("CREATE TABLE IF NOT EXISTS tickflare_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS tickflare_arrivals (player TEXT PRIMARY KEY, carry TEXT NOT NULL)");
    sql.exec(
      `CREATE TABLE IF NOT EXISTS tickflare_forwards (
         player TEXT PRIMARY KEY,
         room TEXT NOT NULL,
         delivered INTEGER NOT NULL DEFAULT 0,
         expires INTEGER
       )`,
    );
    this.#made = true;
    if (this.#roomId !== undefined) this.setMeta("room", this.#roomId);
  }

  /** Whether the room has stored anything at all. */
  get stored(): boolean {
    return this.#made;
  }

  /**
   * The id the room is reached under. Kept with the room once the room has
   * anything else to keep: knowing its name is no reason for a room to exist.
   */
  rememberRoomId(roomId: string): void {
    this.#roomId = roomId;
    if (this.#made) this.setMeta("room", roomId);
  }

  /**
   * Runs `work` so that everything it writes to the database is kept
   * together or, if it throws, not at all. Returns what `work` returns.
   */
  atomically<T>(work: () => T): T {
    try {
      return this.#storage.transactionSync(work);
    } catch (error) {
      // What was undone may include the tables themselves, if this was the first thing written.
      this.#made = this.#exists();
      throw error;
    }
  }

  #exists(): boolean {
    return this.#sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tickflare_room'").toArray().length > 0;
  }

  room(): StoredRoom | undefined {
    if (!this.#made) return undefined;
    const row = this.#sql
      .exec<{ seq: number; state: string; players: string; tick: number }>(
        "SELECT seq, state, players, tick FROM tickflare_room WHERE id = 1",
      )
      .toArray()[0];
    return row && { seq: row.seq, state: row.state, roster: row.players, tick: row.tick };
  }

  /** One row, whatever changed: this is what a save costs. */
  writeRoom(room: StoredRoom): void {
    this.#make();
    this.#sql.exec(
      "INSERT OR REPLACE INTO tickflare_room (id, seq, state, players, tick) VALUES (1, ?, ?, ?, ?)",
      room.seq,
      room.state,
      room.roster,
      room.tick,
    );
  }

  /** Timer names and when they fire, ordered by name. */
  timers(): [name: string, firesAt: number][] {
    if (!this.#made) return [];
    return this.#sql
      .exec<{ name: string; fire_at: number }>("SELECT name, fire_at FROM tickflare_timers ORDER BY name")
      .toArray()
      .map((timer) => [timer.name, timer.fire_at]);
  }

  /** Makes the stored timers match `timers`, writing only the ones that differ: reads are all but free, rows written are not. */
  replaceTimers(timers: Iterable<[name: string, firesAt: number]>): void {
    const wanted = new Map(timers);
    if (wanted.size === 0 && !this.#made) return;
    this.#make();
    for (const [name, firesAt] of this.timers()) {
      if (!wanted.has(name)) this.#sql.exec("DELETE FROM tickflare_timers WHERE name = ?", name);
      else if (wanted.get(name) === firesAt) wanted.delete(name);
    }
    for (const [name, firesAt] of wanted) {
      this.#sql.exec("INSERT OR REPLACE INTO tickflare_timers (name, fire_at) VALUES (?, ?)", name, firesAt);
    }
  }

  meta(): Map<string, string> {
    if (!this.#made) return new Map();
    return new Map(
      this.#sql
        .exec<{ key: string; value: string }>("SELECT key, value FROM tickflare_meta")
        .toArray()
        .map((row) => [row.key, row.value]),
    );
  }

  setMeta(key: string, value: string): void {
    this.#make();
    this.#sql.exec("INSERT OR REPLACE INTO tickflare_meta (key, value) VALUES (?, ?)", key, value);
  }

  hasOutbox(): boolean {
    if (!this.#made) return false;
    return this.#sql.exec("SELECT 1 FROM tickflare_outbox LIMIT 1").toArray().length > 0;
  }

  /**
   * The oldest thing owed that was added after entry `id`, or undefined when
   * there is none. Entries are numbered in the order they were added, so
   * walking the outbox with this also finds what is added along the way.
   */
  nextInOutbox(after: number): { id: number; entry: OutboxEntry } | undefined {
    if (!this.#made) return undefined;
    const row = this.#sql
      .exec<{ id: number; body: string }>(
        "SELECT id, body FROM tickflare_outbox WHERE id > ? ORDER BY id LIMIT 1",
        after,
      )
      .toArray()[0];
    return row && { id: row.id, entry: JSON.parse(row.body) as OutboxEntry };
  }

  /** `body` is an `OutboxEntry` as JSON. */
  addToOutbox(body: string): void {
    this.#make();
    this.#sql.exec("INSERT INTO tickflare_outbox (body) VALUES (?)", body);
  }

  removeFromOutbox(id: number): void {
    if (!this.#made) return;
    this.#sql.exec("DELETE FROM tickflare_outbox WHERE id = ?", id);
  }

  /** What a player handed over by another room carries, as JSON, or undefined if they were not handed over. */
  arrival(player: string): string | undefined {
    if (!this.#made) return undefined;
    return this.#sql
      .exec<{ carry: string }>("SELECT carry FROM tickflare_arrivals WHERE player = ?", player)
      .toArray()[0]?.carry;
  }

  putArrival(player: string, carry: unknown): void {
    this.#make();
    this.#sql.exec(
      "INSERT OR REPLACE INTO tickflare_arrivals (player, carry) VALUES (?, ?)",
      player,
      JSON.stringify(carry ?? null),
    );
  }

  removeArrival(player: string): void {
    if (!this.#made) return;
    this.#sql.exec("DELETE FROM tickflare_arrivals WHERE player = ?", player);
  }

  /** Where `player` was handed to, if they were. */
  forward(player: string): Forward | undefined {
    if (!this.#made) return undefined;
    const row = this.#sql
      .exec<{ room: string; delivered: number; expires: number | null }>(
        "SELECT room, delivered, expires FROM tickflare_forwards WHERE player = ?",
        player,
      )
      .toArray()[0];
    return row && { room: row.room, delivered: row.delivered === 1, expires: row.expires };
  }

  /** `player` is being handed to `room`. */
  putForward(player: string, room: string): void {
    this.#make();
    this.#sql.exec(
      "INSERT OR REPLACE INTO tickflare_forwards (player, room, delivered, expires) VALUES (?, ?, 0, NULL)",
      player,
      room,
    );
  }

  /** `room` has accepted `player`. */
  deliverForward(player: string, room: string, expires: number | null): void {
    if (!this.#made) return;
    this.#sql.exec(
      "UPDATE tickflare_forwards SET delivered = 1, expires = ? WHERE player = ? AND room = ?",
      expires,
      player,
      room,
    );
  }

  expireForward(player: string, expires: number): void {
    if (!this.#made) return;
    this.#sql.exec("UPDATE tickflare_forwards SET expires = ? WHERE player = ?", expires, player);
  }

  removeForward(player: string): void {
    if (!this.#made) return;
    this.#sql.exec("DELETE FROM tickflare_forwards WHERE player = ?", player);
  }

  /** Drops the forwards that ran out before `now`. */
  purgeForwards(now: number): void {
    if (!this.#made) return;
    this.#sql.exec("DELETE FROM tickflare_forwards WHERE expires IS NOT NULL AND expires <= ?", now);
  }
}
