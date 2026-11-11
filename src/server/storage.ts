import type { MatchResult } from "../protocol.js";

/** The room as last saved. `state` and `roster` are JSON. */
export interface StoredRoom {
  seq: number;
  state: string;
  roster: string;
}

/** Something a committed hook promised to deliver: a finished match, or a player handed to another room. */
export type OutboxEntry =
  | { message: MatchResult; replay?: string; move?: undefined }
  | { move: { player: string; to: string; carry: unknown } };

/**
 * Everything a room keeps in its Durable Object's SQLite database, in one
 * place. Calls are synchronous; writes made within one event are committed
 * together by the runtime.
 *
 * Tables:
 *   tickflare_room      one row: seq, state, seats
 *   tickflare_timers    named timers and when they fire
 *   tickflare_meta      small values by key (tick, room id, invited players)
 *   tickflare_outbox    deliveries that are owed (finished matches, handovers)
 *   tickflare_arrivals  players another room has handed over, until they connect
 */
export class RoomStorage {
  readonly #sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.#sql = sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS tickflare_room (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         seq INTEGER NOT NULL,
         state TEXT NOT NULL,
         players TEXT NOT NULL
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS tickflare_timers (
         name TEXT PRIMARY KEY,
         fire_at INTEGER NOT NULL
       )`,
    );
    sql.exec("CREATE TABLE IF NOT EXISTS tickflare_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS tickflare_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL)");
    sql.exec("CREATE TABLE IF NOT EXISTS tickflare_arrivals (player TEXT PRIMARY KEY, carry TEXT NOT NULL)");
  }

  room(): StoredRoom | undefined {
    const row = this.#sql
      .exec<{ seq: number; state: string; players: string }>(
        "SELECT seq, state, players FROM tickflare_room WHERE id = 1",
      )
      .toArray()[0];
    return row && { seq: row.seq, state: row.state, roster: row.players };
  }

  writeRoom(room: StoredRoom): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO tickflare_room (id, seq, state, players) VALUES (1, ?, ?, ?)",
      room.seq,
      room.state,
      room.roster,
    );
  }

  /** Timer names and when they fire, ordered by name. */
  timers(): [name: string, firesAt: number][] {
    return this.#sql
      .exec<{ name: string; fire_at: number }>("SELECT name, fire_at FROM tickflare_timers ORDER BY name")
      .toArray()
      .map((timer) => [timer.name, timer.fire_at]);
  }

  replaceTimers(timers: Iterable<[name: string, firesAt: number]>): void {
    this.#sql.exec("DELETE FROM tickflare_timers");
    for (const [name, firesAt] of timers) {
      this.#sql.exec("INSERT INTO tickflare_timers (name, fire_at) VALUES (?, ?)", name, firesAt);
    }
  }

  meta(): Map<string, string> {
    return new Map(
      this.#sql
        .exec<{ key: string; value: string }>("SELECT key, value FROM tickflare_meta")
        .toArray()
        .map((row) => [row.key, row.value]),
    );
  }

  setMeta(key: string, value: string): void {
    this.#sql.exec("INSERT OR REPLACE INTO tickflare_meta (key, value) VALUES (?, ?)", key, value);
  }

  hasOutbox(): boolean {
    return this.#sql.exec("SELECT 1 FROM tickflare_outbox LIMIT 1").toArray().length > 0;
  }

  /** What is owed, oldest first. */
  outbox(): { id: number; entry: OutboxEntry }[] {
    return this.#sql
      .exec<{ id: number; body: string }>("SELECT id, body FROM tickflare_outbox ORDER BY id")
      .toArray()
      .map((row) => ({ id: row.id, entry: JSON.parse(row.body) as OutboxEntry }));
  }

  addToOutbox(entry: OutboxEntry): void {
    this.#sql.exec("INSERT INTO tickflare_outbox (body) VALUES (?)", JSON.stringify(entry));
  }

  removeFromOutbox(id: number): void {
    this.#sql.exec("DELETE FROM tickflare_outbox WHERE id = ?", id);
  }

  /** What a player handed over by another room carries, as JSON, or undefined if they were not handed over. */
  arrival(player: string): string | undefined {
    return this.#sql
      .exec<{ carry: string }>("SELECT carry FROM tickflare_arrivals WHERE player = ?", player)
      .toArray()[0]?.carry;
  }

  putArrival(player: string, carry: unknown): void {
    this.#sql.exec(
      "INSERT OR REPLACE INTO tickflare_arrivals (player, carry) VALUES (?, ?)",
      player,
      JSON.stringify(carry ?? null),
    );
  }

  removeArrival(player: string): void {
    this.#sql.exec("DELETE FROM tickflare_arrivals WHERE player = ?", player);
  }
}
