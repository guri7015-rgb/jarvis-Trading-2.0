import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import type { TokenCreatedEvent } from "../src/core/types.ts";
import { TokenRegistry } from "../src/discovery/registry.ts";
import { CallBudget } from "../src/solana/rpc.ts";
import { openDb } from "../src/storage/db.ts";
import { budgetStore, SessionStore } from "../src/storage/sessions.ts";
import { PUMP_MINT } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmpDb = () => {
  const d = mkdtempSync(join(tmpdir(), "solbot-"));
  dirs.push(d);
  return join(d, "state.sqlite");
};

const ev: TokenCreatedEvent = {
  kind: "token_created",
  provider: "pumpportal",
  providerEventId: "create:sigA",
  dedupeKey: `create:${PUMP_MINT}`,
  receivedAt: 1_800_000_000_000,
  evidence: "PROVIDER_REPORTED",
  mint: PUMP_MINT,
  venue: "pump_curve",
  venueRaw: "pump",
};

describe("restart and recovery", () => {
  it("after a crash, records the downtime as a gap and keeps dedupe state", () => {
    const path = tmpDb();
    let db = openDb(path);
    let sessions = new SessionStore(db);
    sessions.start(1000);
    sessions.heartbeat(5000);
    new TokenRegistry(db).ingest(ev);
    db.close(); // crash: no sessions.end()

    db = openDb(path);
    sessions = new SessionStore(db);
    const gap = sessions.start(65_000);
    expect(gap).toEqual({ provider: "all", from_ms: 5000, to_ms: 65_000, reason: "previous run stopped without clean shutdown" });
    const reg = new TokenRegistry(db);
    expect(reg.ingest(ev).duplicate).toBe(true);
    expect(reg.count()).toBe(1);
    db.close();
  });

  it("after a clean stop, records the time the process wasn't running", () => {
    const path = tmpDb();
    let db = openDb(path);
    new SessionStore(db).start(1000);
    const s = new SessionStore(db);
    s.start(2000);
    s.end(3000);
    db.close();
    db = openDb(path);
    const gap = new SessionStore(db).start(10_000);
    expect(gap).toMatchObject({ from_ms: 3000, to_ms: 10_000, reason: "process not running" });
    db.close();
  });

  it("persists the daily RPC budget across restarts and resets at UTC midnight", async () => {
    const path = tmpDb();
    const clock = new FakeClock(Date.parse("2026-10-26T23:59:00Z"));
    let db = openDb(path);
    let b = new CallBudget(10, clock, budgetStore(db));
    for (let i = 0; i < 7; i++) expect(b.tryConsume()).toBe(true);
    db.close();
    db = openDb(path);
    b = new CallBudget(10, clock, budgetStore(db));
    expect(b.usedToday).toBe(7);
    expect(b.tryConsume(4)).toBe(false); // would exceed; nothing reserved
    expect(b.tryConsume(3)).toBe(true);
    expect(b.tryConsume()).toBe(false);
    await clock.advance(2 * 60_000);
    expect(b.tryConsume()).toBe(true);
    db.close();
  });

  it("upgrades an old database and re-applies the conflict rule to rows confirmed before it", () => {
    const path = tmpDb();
    let db = openDb(path);
    new TokenRegistry(db).ingest(ev);
    // Simulate a row confirmed by the v1 code: curve mismatch but still CONFIRMED.
    db.exec(`UPDATE tokens SET confirm_status='CONFIRMED', curve_key_matches=0, confirm_note=NULL`);
    // Make it look like a real v2 database: later tables don't exist yet.
    db.exec("DROP TABLE assessments; DROP TABLE trades; DROP TABLE decisions; DROP TABLE risk_state; DROP TABLE positions; DROP TABLE orders; DROP TABLE equity_snapshots; DROP TABLE paper_account; UPDATE schema_version SET version = 2");
    db.close();
    db = openDb(path);
    const t = new TokenRegistry(db).get(PUMP_MINT)!;
    expect(t.confirm_status).toBe("CONFLICT");
    expect(t.created_at).toBeNull();
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it("refuses to open a database written by a newer schema", () => {
    const path = tmpDb();
    const db = openDb(path);
    db.exec("UPDATE schema_version SET version = 99");
    db.close();
    expect(() => openDb(path)).toThrow(/newer than this code/);
  });
});
