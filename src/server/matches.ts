import type { MatchResult } from "../protocol.js";

/** A finished match as stored in D1. */
export interface MatchRecord {
  id: string;
  room: string | null;
  endedAt: number;
  players: string[];
  result: Record<string, unknown>;
  replayKey: string | null;
}

/** The table `recordMatches` writes to. It creates it on first use; this is here if you prefer migrations. */
export const MATCHES_SCHEMA = `
CREATE TABLE IF NOT EXISTS tickflare_matches (
  id TEXT PRIMARY KEY,
  room TEXT,
  ended_at INTEGER NOT NULL,
  players TEXT NOT NULL,
  result TEXT NOT NULL,
  replay_key TEXT
);
CREATE INDEX IF NOT EXISTS tickflare_matches_ended_at ON tickflare_matches (ended_at DESC);
`;

const ready = new WeakSet<D1Database>();

async function ensureSchema(db: D1Database): Promise<void> {
  if (ready.has(db)) return;
  const statements = MATCHES_SCHEMA.split(";")
    .map((sql) => sql.trim())
    .filter(Boolean)
    .map((sql) => db.prepare(sql));
  await db.batch(statements);
  ready.add(db);
}

/**
 * Queue consumer: stores finished matches in D1. Use it as your Worker's
 * `queue` handler, or call it from one:
 *
 *     async queue(batch, env) {
 *       await recordMatches(batch, env.DB);
 *     }
 *
 * A match is stored once however often its message is delivered.
 */
export async function recordMatches(batch: MessageBatch<MatchResult>, db: D1Database): Promise<void> {
  await ensureSchema(db);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO tickflare_matches (id, room, ended_at, players, result, replay_key)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  );
  for (const message of batch.messages) {
    const match = message.body;
    try {
      await insert
        .bind(
          match.id,
          match.room,
          match.endedAt,
          JSON.stringify(match.players),
          JSON.stringify(match.result),
          match.replayKey ?? null,
        )
        .run();
      message.ack();
    } catch (err) {
      console.error("[tickflare] could not store a match:", err);
      message.retry();
    }
  }
}

/** The most recently finished matches, newest first. */
export async function recentMatches(db: D1Database, limit = 20): Promise<MatchRecord[]> {
  await ensureSchema(db);
  const { results } = await db
    .prepare(
      `SELECT id, room, ended_at, players, result, replay_key
       FROM tickflare_matches ORDER BY ended_at DESC LIMIT ?1`,
    )
    .bind(Math.max(1, Math.min(100, Math.floor(limit))))
    .all<{ id: string; room: string | null; ended_at: number; players: string; result: string; replay_key: string | null }>();
  return results.map((row) => ({
    id: row.id,
    room: row.room,
    endedAt: row.ended_at,
    players: JSON.parse(row.players) as string[],
    result: JSON.parse(row.result) as Record<string, unknown>,
    replayKey: row.replay_key,
  }));
}
