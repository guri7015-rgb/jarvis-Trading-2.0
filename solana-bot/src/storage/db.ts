/**
 * SQLite state store (node:sqlite, built into Node >= 22.13).
 *
 * The database is the source of truth, so a restart resumes with the same
 * dedupe keys, token registry, gap history and RPC budget usage.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 1;

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY,
    started_at INTEGER NOT NULL,
    last_heartbeat INTEGER NOT NULL,
    ended_at INTEGER,
    clean_shutdown INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    mint TEXT NOT NULL,
    venue TEXT NOT NULL,
    venue_raw TEXT NOT NULL,
    evidence TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    payload TEXT NOT NULL,
    UNIQUE (provider, provider_event_id)
  );
  CREATE INDEX events_mint ON events (mint);
  CREATE INDEX events_dedupe ON events (dedupe_key);
  CREATE INDEX events_received ON events (received_at);

  CREATE TABLE tokens (
    mint TEXT PRIMARY KEY,
    first_observed_at INTEGER NOT NULL,
    first_source TEXT NOT NULL,
    created_at INTEGER,
    created_at_evidence TEXT,
    created_at_source TEXT,
    launch_venue TEXT,
    stage TEXT NOT NULL DEFAULT 'UNKNOWN',
    stage_evidence TEXT,
    confirm_status TEXT NOT NULL DEFAULT 'PENDING',
    confirm_attempts INTEGER NOT NULL DEFAULT 0,
    confirmed_at INTEGER,
    confirmed_slot INTEGER,
    mint_program TEXT,
    mint_authority TEXT,
    freeze_authority TEXT,
    decimals INTEGER,
    supply TEXT,
    extensions TEXT,
    creator TEXT,
    creator_evidence TEXT,
    provider_curve TEXT,
    curve_key_matches INTEGER,
    curve_complete INTEGER,
    curve_virtual_quote TEXT,
    curve_virtual_token TEXT,
    curve_real_quote TEXT,
    curve_quote_mint TEXT,
    curve_quote_mint_assumed INTEGER,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX tokens_confirm ON tokens (confirm_status, first_observed_at);
  CREATE INDEX tokens_first_observed ON tokens (first_observed_at);

  CREATE TABLE token_sources (
    mint TEXT NOT NULL,
    provider TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    events INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (mint, provider)
  );

  CREATE TABLE pools (
    pool TEXT PRIMARY KEY,
    mint TEXT NOT NULL,
    venue TEXT NOT NULL,
    venue_raw TEXT NOT NULL,
    first_source TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    pool_created_at INTEGER
  );
  CREATE INDEX pools_mint ON pools (mint);

  CREATE TABLE gaps (
    id INTEGER PRIMARY KEY,
    provider TEXT NOT NULL,
    from_ms INTEGER NOT NULL,
    to_ms INTEGER NOT NULL,
    reason TEXT NOT NULL
  );

  CREATE TABLE rpc_budget (day TEXT PRIMARY KEY, used INTEGER NOT NULL);

  CREATE TABLE provider_stats (
    provider TEXT NOT NULL,
    day TEXT NOT NULL,
    duplicates INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (provider, day)
  );
  `,
  // 2: why a token's confirmation failed or conflicted (e.g. provider sent the quote mint as the mint).
  `ALTER TABLE tokens ADD COLUMN confirm_note TEXT;`,
];

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let current = row?.version ?? 0;
  if (current > MIGRATIONS.length) throw new Error(`database schema ${current} is newer than this code (${MIGRATIONS.length})`);
  while (current < MIGRATIONS.length) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[current]!);
      current++;
      db.exec("DELETE FROM schema_version");
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(current);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}

/** Run `fn` in a transaction. */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
