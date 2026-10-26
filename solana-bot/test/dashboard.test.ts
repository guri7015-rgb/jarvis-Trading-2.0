import { afterAll, describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import { silentLogger } from "../src/core/log.ts";
import { dashboardState } from "../src/dashboard/state.ts";
import { TokenRegistry } from "../src/discovery/registry.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { HealthMonitor } from "../src/health/monitor.ts";
import { Ledger } from "../src/paper/ledger.ts";
import { DEFAULT_LIMITS } from "../src/risk/limits.ts";
import { RiskStateStore } from "../src/risk/riskState.ts";
import { openDb } from "../src/storage/db.ts";
import { PUMP_MINT } from "./helpers.ts";

const T = Date.parse("2026-10-26T12:00:00Z");
function deps() {
  const clock = new FakeClock(T);
  const db = openDb(":memory:");
  const health = new HealthMonitor(clock);
  health.register("pumpportal", { kind: "stream", maxSilenceMs: 60_000, required: false });
  const ledger = new Ledger(db, () => clock.now());
  ledger.initAccount(500, 140);
  const riskState = new RiskStateStore(db, () => clock.now());
  return { db, health, riskState, limits: DEFAULT_LIMITS, limitsRefused: [], ledger, now: () => clock.now(), clock };
}

describe("dashboard state", () => {
  it("reports paper mode, live trading off, and every breaker", () => {
    const s = dashboardState(deps());
    expect(s.mode).toBe("PAPER");
    expect(s.liveTradingEnabled).toBe(false);
    expect(s.breakers.map((b) => b.name)).toEqual(["Live trading", "Manual halt", "Daily loss", "Entries today", "Losing streak", "Open positions", "Unconfirmed limit increases", "Discovery gate", "Stale data"]);
    expect(s.breakers.find((b) => b.name === "Discovery gate")!.ok).toBe(false); // nothing is up yet: fail closed
    expect(s.pnl.startingCad).toBe(500);
  });

  it("shows an open position with its net exit mark and the day's drawdown", () => {
    const d = deps();
    d.ledger.propose({ id: "p1", mint: PUMP_MINT, venue: "pumpswap", strategy: "A_continuation", decimals: 6, plannedSizeLamports: 200_000_000n, plannedLossCad: 2.5, invalidationPrice: 1, targetPrice: 2, timeStopMs: 1000, solCad: 140, fxJson: "{}" });
    d.ledger.recordEntryFill("p1", { quoteIn: 200_000_000n, quoteOut: 1000n, quoteImpactPct: 1, quoteRoute: "x", quoteAt: T, simLatencyMs: 1, baseFee: 5000n, priorityFee: 2000n, rent: 2_074_080n, fillIn: 200_000_000n, fillOut: 1000n }, 1);
    d.ledger.snapshot(new Map([["p1", 190_000_000n]]), 140);
    const s = dashboardState({ ...d, marks: () => new Map([["p1", 190_000_000n]]) });
    expect(s.positions).toHaveLength(1);
    expect(s.positions[0]!.unrealizedSol).toBeCloseTo((190_000_000 - 200_007_000) / 1e9, 9);
    expect(s.breakers.find((b) => b.name === "Open positions")!.ok).toBe(false);
  });
});

describe("dashboard server", () => {
  const d = deps();
  const server = startDashboard(d, silentLogger, 0);
  afterAll(() => server.close());
  const base = () => `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  it("serves the page and the state, binds to localhost, and refuses a halt that did not come from the page", async () => {
    if (!server.listening) await new Promise((r) => server.once("listening", r));
    expect((server.address() as { address: string }).address).toBe("127.0.0.1");
    const page = await fetch(`${base()}/`).then((r) => r.text());
    expect(page).toContain("<title>Solana Paper Desk</title>");
    const token = /data-halt-token="([0-9a-f]{32})"/.exec(page)?.[1];
    expect(token).toBeTruthy();
    const state = await fetch(`${base()}/api/state`).then((r) => r.json() as Promise<{ risk: { day: { haltedReason: string | null } }; meta: Record<string, unknown> }>);
    expect(state.risk.day.haltedReason).toBeNull();
    expect(state.meta).toEqual({});

    // A cross-site form post: wrong origin, no token.
    const csrf = await fetch(`${base()}/api/halt`, { method: "POST", headers: { origin: "https://evil.example" } });
    expect(csrf.status).toBe(403);
    // Right origin, no token.
    expect((await fetch(`${base()}/api/halt`, { method: "POST", headers: { origin: base() } })).status).toBe(403);
    expect(d.riskState.today().haltedReason).toBeNull();

    // The page's own request.
    const ok = await fetch(`${base()}/api/halt`, { method: "POST", headers: { origin: base(), "x-halt-token": token! } });
    expect(ok.status).toBe(200);
    expect(d.riskState.today().haltedReason).toMatch(/^KILL: manual stop/);
    expect((await fetch(`${base()}/api/anything`)).status).toBe(404);
  });

  it("shows names and logos for tokens on screen, https only", () => {
    const d2 = deps();
    const reg = new TokenRegistry(d2.db);
    reg.ingest({ kind: "token_created", provider: "pumpportal", providerEventId: "c1", dedupeKey: `create:${PUMP_MINT}`, receivedAt: T, evidence: "PROVIDER_REPORTED", mint: PUMP_MINT, venue: "pump_curve", venueRaw: "pump", name: "Test Coin", symbol: "TEST" });
    reg.setMeta({ mint: PUMP_MINT, iconUrl: "http://insecure.example/x.png" }, "test", T);
    expect(dashboardState(d2).meta[PUMP_MINT]).toEqual({ name: "Test Coin", symbol: "TEST", icon: null });
    reg.setMeta({ mint: PUMP_MINT, name: "Other", iconUrl: "https://cdn.example/x.png" }, "test", T);
    const m = dashboardState(d2).meta[PUMP_MINT]!;
    expect(m.name).toBe("Test Coin"); // first value wins
    expect(m.icon).toBe("https://cdn.example/x.png"); // the http URL was never stored, so the https one fills the blank
    expect(reg.missingIcons([PUMP_MINT, "other"])).toEqual(["other"]);
  });
});
