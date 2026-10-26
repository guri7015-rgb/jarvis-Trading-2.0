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
  // 3: apply the conflict rule to rows confirmed before it existed.
  `
  UPDATE tokens SET confirm_status = 'CONFLICT',
    confirm_note = CASE WHEN curve_key_matches = 0 THEN 'provider curve address does not derive from this mint'
                        ELSE 'no pump.fun bonding curve at the address derived from this mint' END,
    created_at = CASE WHEN created_at_source LIKE '%:create_received' THEN NULL ELSE created_at END,
    created_at_evidence = CASE WHEN created_at_source LIKE '%:create_received' THEN NULL ELSE created_at_evidence END,
    created_at_source = CASE WHEN created_at_source LIKE '%:create_received' THEN NULL ELSE created_at_source END
  WHERE confirm_status = 'CONFIRMED'
    AND (curve_key_matches = 0 OR (launch_venue = 'pump_curve' AND curve_virtual_quote IS NULL));
  `,
  // 4: Phase 3 tradability assessments. Amounts are integer strings (lamports / token atoms).
  `
  CREATE TABLE assessments (
    id INTEGER PRIMARY KEY,
    mint TEXT NOT NULL,
    at INTEGER NOT NULL,
    verdict TEXT NOT NULL,
    rejects TEXT NOT NULL,
    flags TEXT NOT NULL,
    recheck_after INTEGER NOT NULL,
    candidate_source TEXT,
    liquidity_usd_reported REAL,
    stage TEXT,
    mint_program TEXT,
    size_cad REAL,
    sol_cad REAL,
    fx_json TEXT,
    size_lamports TEXT,
    buy_out TEXT,
    sell_out TEXT,
    buy_impact_pct REAL,
    sell_impact_pct REAL,
    buy_route TEXT,
    sell_route TEXT,
    quote_gap_ms INTEGER,
    quote_round_trip_bps INTEGER,
    network_fee_lamports TEXT,
    rent_lamports TEXT,
    total_cost_bps INTEGER,
    break_even_pct REAL,
    priority_micro_lamports INTEGER,
    implied_buy_fee_bps INTEGER,
    implied_sell_fee_bps INTEGER,
    top10_wallet_pct REAL,
    largest_wallet_pct REAL,
    creator_pct REAL,
    pool_pct REAL,
    holders_slot INTEGER,
    accounts_slot INTEGER,
    duration_ms INTEGER
  );
  CREATE INDEX assessments_mint ON assessments (mint, at);
  CREATE INDEX assessments_at ON assessments (at);
  `,
  // 5: the curve decoder used to reject the oldest 49-byte curve layout, which made
  // those tokens look like they had no curve. Send them back for confirmation.
  `
  UPDATE tokens SET confirm_status = 'PENDING', confirm_note = NULL, confirm_attempts = 0
  WHERE confirm_status = 'CONFLICT' AND confirm_note = 'no pump.fun bonding curve at the address derived from this mint';
  `,
  // 6: Phase 4 trade tape (on-chain events from logs) and strategy/risk decisions.
  `
  CREATE TABLE trades (
    id INTEGER PRIMARY KEY,
    mint TEXT NOT NULL,
    venue TEXT NOT NULL,
    signature TEXT NOT NULL,
    event_index INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    block_time_ms INTEGER NOT NULL,
    received_at INTEGER NOT NULL,
    side TEXT NOT NULL,
    wallet TEXT NOT NULL,
    quote_amount TEXT NOT NULL,
    token_amount TEXT NOT NULL,
    price_sol REAL NOT NULL,
    real_quote_reserves TEXT,
    UNIQUE (signature, event_index, mint)
  );
  CREATE INDEX trades_mint_time ON trades (mint, block_time_ms);

  CREATE TABLE decisions (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    mint TEXT NOT NULL,
    strategy TEXT NOT NULL,
    action TEXT NOT NULL,
    reasons TEXT NOT NULL,
    signal_json TEXT,
    risk_json TEXT,
    features_json TEXT
  );
  CREATE INDEX decisions_at ON decisions (at);
  CREATE INDEX decisions_mint ON decisions (mint, at);

  CREATE TABLE risk_state (
    day TEXT PRIMARY KEY,
    realized_loss_cad REAL NOT NULL DEFAULT 0,
    entries INTEGER NOT NULL DEFAULT 0,
    consecutive_losses INTEGER NOT NULL DEFAULT 0,
    halted_reason TEXT,
    updated_at INTEGER NOT NULL
  );
  `,
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
