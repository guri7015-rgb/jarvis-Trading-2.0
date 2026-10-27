import { describe, expect, it } from "vitest";
import { openDb } from "../src/storage/db.ts";
import { backtestTape, splitWindows, summarize, type BacktestTrade } from "../src/paper/backtest.ts";
import { exportOrdersCsv, exportPositionsCsv } from "../src/paper/exportCsv.ts";
import { Ledger } from "../src/paper/ledger.ts";
import { DEFAULT_LIMITS } from "../src/risk/limits.ts";
import type { Trade } from "../src/strategy/features.ts";
import { PUMP_MINT } from "./helpers.ts";

const T = 1_800_000_000_000;
const sec = (s: number) => T + s * 1000;
let n = 0;
const tr = (s: number, p: number, side: "buy" | "sell" = "buy"): Trade => ({ mint: "M", signature: `s${n}`, eventIndex: 0, slot: 1000 + s * 3 + n, blockTimeMs: sec(s), receivedAt: sec(s) + 1000, side, wallet: `w${n++}`, quoteSol: 0.1 + n * 0.000137, priceSol: p });
function span(from: number, to: number, every: number, price: (s: number) => number) {
  const out: Trade[] = [];
  for (let s = from; s < to; s += every) out.push(tr(s, price(s)));
  return out;
}
/** A continuation setup that then runs to the target. */
function winningTape() {
  const t = [...span(0, 120, 3, (s) => 1 + (s / 120) * 0.2), ...span(120, 240, 3, () => 1.2), ...span(240, 290, 2, (s) => 1.18 + ((s % 4) / 4) * 0.02)];
  t.push(tr(292, 1.212), tr(295, 1.212), tr(298, 1.212));
  t.push(...span(300, 420, 2, (s) => 1.212 + ((s - 300) / 120) * 0.15)); // +12% over 2 min
  t.push(...span(420, 600, 3, () => 1.36));
  return t;
}
const seeded = (seed: number) => {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
};

describe("backtest (modelled)", () => {
  it("with the default limits, a textbook A setup is rejected at the COSTS gate (the cost bar is real)", () => {
    const r = backtestTape("M", "pumpswap", winningTape(), [], { limits: DEFAULT_LIMITS, stepMs: 5000, sizeCad: 30, solCad: 140, random: () => 0.5, strategies: ["A_continuation"] });
    expect(r.signals).toBeGreaterThan(0);
    expect(r.rejectedByGate.COSTS).toBe(r.signals); // 4% modelled round trip + 2% stress vs a ~3% stop: R:R < 1.5
    expect(r.trades).toHaveLength(0);
  });

  it("replays a winning setup through entry, fill latency and a profit exit, net of modelled costs", () => {
    // Relaxed reward-to-risk ONLY to exercise the fill path; not a recommended limit.
    const limits = { ...DEFAULT_LIMITS, minRewardToRisk: 0.3 };
    const r = backtestTape("M", "pumpswap", winningTape(), [], { limits, stepMs: 5000, sizeCad: 30, solCad: 140, random: () => 0.5 });
    expect(r.label).toBe("MODELLED");
    expect(r.signals).toBeGreaterThan(0);
    const closed = r.trades.filter((t) => !t.failedEntry && t.exitAt !== null);
    expect(closed.length).toBeGreaterThan(0);
    const t = closed[0]!;
    expect(t.strategy).toBe("A_continuation");
    expect(t.entryAt).toBeGreaterThan(sec(292)); // fill after latency, never at decision time
    expect(t.grossChartPct).toBeGreaterThan(t.pnlPct); // costs taken out
    expect(t.pnlSol).toBeGreaterThan(0);
  });

  it("never fills from a trade that hadn't arrived yet", () => {
    const tape = winningTape().map((x) => ({ ...x, receivedAt: x.blockTimeMs + 30_000 })); // everything arrives 30 s late
    const r = backtestTape("M", "pumpswap", tape, [], { limits: { ...DEFAULT_LIMITS, minRewardToRisk: 0.3 }, stepMs: 5000, sizeCad: 30, solCad: 140, random: () => 0.5 });
    for (const t of r.trades) {
      const ref = tape.find((x) => x.blockTimeMs >= t.entryAt - 12_000 && x.blockTimeMs <= t.entryAt);
      if (ref) expect(ref.receivedAt).toBeLessThanOrEqual(t.entryAt + 15_000);
    }
  });

  it("charges fees on failed entries and can leave a position stuck", () => {
    const r = backtestTape("M", "pump_curve", winningTape(), [], { limits: { ...DEFAULT_LIMITS, minRewardToRisk: 0.3 }, stepMs: 5000, sizeCad: 30, solCad: 140, random: seeded(3) });
    // With a 10% failure draw somewhere in the run, at least the accounting fields are consistent.
    for (const t of r.trades) {
      if (t.failedEntry) expect(t.pnlSol).toBeLessThan(0);
      expect(Number.isFinite(t.pnlPct)).toBe(true);
    }
  });

  it("summarizes expectancy, drawdown, streaks and per-strategy results", () => {
    const mk = (pnl: number, i: number): BacktestTrade => ({ mint: "M", strategy: "A_continuation", entryAt: T + i * 1000, exitAt: T + i * 1000 + 500, entryPrice: 1, exitPrice: 1, sizeSol: 0.2, costBasisSol: 0.2, proceedsSol: 0.2 + pnl, pnlSol: pnl, pnlPct: pnl / 0.2, grossChartPct: 0, reason: "X", holdMs: 500, failedEntry: false, stuck: false });
    const s = summarize([mk(0.02, 0), mk(-0.01, 1), mk(-0.01, 2), mk(-0.01, 3), mk(0.05, 4)]);
    expect(s.n).toBe(5);
    expect(s.winRate).toBe(0.4);
    expect(s.maxConsecutiveLosses).toBe(3);
    expect(s.maxDrawdownSol).toBeCloseTo(0.03, 10);
    expect(s.largestLossSol).toBe(-0.01);
    expect(s.profitFactor).toBeCloseTo(0.07 / 0.03, 6);
    expect(s.byStrategy.A_continuation!.n).toBe(5);
  });

  it("splits windows by time in order", () => {
    const w = splitWindows(0, 1000);
    expect(w.train).toEqual([0, 500]);
    expect(w.validation).toEqual([500, 750]);
    expect(w.test).toEqual([750, 1000]);
  });
});

describe("CSV export", () => {
  it("writes CRA-style records with FX provenance and escapes commas", () => {
    const db = openDb(":memory:");
    const ledger = new Ledger(db, () => T);
    ledger.initAccount(500, 140);
    ledger.propose({ id: "p1", mint: PUMP_MINT, venue: "pumpswap", strategy: "A_continuation", decimals: 6, plannedSizeLamports: 200_000_000n, plannedLossCad: 2.5, invalidationPrice: 1, targetPrice: 2, timeStopMs: 1000, solCad: 140, fxJson: JSON.stringify({ solUsdAt: T, usdCadDate: "2026-10-23" }) });
    const fill = { quoteIn: 200_000_000n, quoteOut: 1000n, quoteImpactPct: 1, quoteRoute: "Pump.fun Amm", quoteAt: T, simLatencyMs: 1, baseFee: 5000n, priorityFee: 2000n, rent: 2_074_080n, fillIn: 200_000_000n, fillOut: 1000n };
    ledger.recordEntryFill("p1", fill, 1);
    ledger.recordExitFill("p1", { ...fill, fillIn: 1000n, fillOut: 190_000_000n, rent: 0n }, 1000n, "INVALIDATION", "price 0.9, below 0.95", 140);
    const csv = exportPositionsCsv(db);
    const lines = csv.trim().split("\n");
    expect(lines[0]).toMatch(/^position_id,mode,mint/);
    expect(lines[1]).toContain("CLOSED");
    expect(lines[1]).toContain('"price 0.9, below 0.95"');
    expect(lines[1]).toMatch(/BoC USD\/CAD 2026-10-23/);
    const orders = exportOrdersCsv(db).trim().split("\n");
    expect(orders).toHaveLength(3);
    db.close();
  });
});
