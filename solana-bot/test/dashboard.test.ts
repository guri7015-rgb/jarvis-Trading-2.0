import { afterAll, describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import { silentLogger } from "../src/core/log.ts";
import { dashboardState } from "../src/dashboard/state.ts";
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

  it("serves the page and the state, binds to localhost, and the halt only blocks entries", async () => {
    if (!server.listening) await new Promise((r) => server.once("listening", r));
    expect((server.address() as { address: string }).address).toBe("127.0.0.1");
    const page = await fetch(`${base()}/`).then((r) => r.text());
    expect(page).toContain("<title>Solana Paper Desk</title>");
    const state = await fetch(`${base()}/api/state`).then((r) => r.json() as Promise<{ risk: { day: { haltedReason: string | null } } }>);
    expect(state.risk.day.haltedReason).toBeNull();
    await fetch(`${base()}/api/halt`, { method: "POST" });
    expect(d.riskState.today().haltedReason).toMatch(/^KILL: manual stop/);
    expect(d.ledger.open()).toHaveLength(0); // halting closes nothing
    expect((await fetch(`${base()}/api/anything`)).status).toBe(404);
  });
});
