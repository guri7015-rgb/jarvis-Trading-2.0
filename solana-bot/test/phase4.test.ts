/**
 * Phase 4 tests. Strategy scenarios use SYNTHETIC tapes shaped to each setup;
 * they test the rules, not whether any rule makes money.
 */
import { describe, expect, it } from "vitest";
import { parseTradeLogs } from "../src/market/eventDecoder.ts";
import { DEFAULT_LIMITS, loadRiskLimits } from "../src/risk/limits.ts";
import { decideEntry, type RiskInput } from "../src/risk/manager.ts";
import { RiskStateStore } from "../src/risk/riskState.ts";
import { decodePumpSwapPool } from "../src/solana/pumpSwapPool.ts";
import { PROGRAMS } from "../src/solana/programs.ts";
import { openDb } from "../src/storage/db.ts";
import { decideExit, type ExitContext, type OpenPosition } from "../src/strategy/exits.ts";
import { buildCandles, computeFeatures, type Trade } from "../src/strategy/features.ts";
import { strategyA } from "../src/strategy/strategyA.ts";
import { strategyB } from "../src/strategy/strategyB.ts";
import { strategyC } from "../src/strategy/strategyC.ts";
import { strategyD } from "../src/strategy/strategyD.ts";
import type { Signal } from "../src/strategy/types.ts";
import { fixtureJson } from "./helpers.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const T = 1_800_000_000_000;
const sec = (s: number) => T + s * 1000;
let n = 0;
/** One synthetic trade: at second s, price p, side, wallet, SOL size; arrives 1 s later. */
const tr = (s: number, p: number, side: "buy" | "sell" = "buy", wallet = `w${n++}`, sol = 0.1 + n * 0.000137): Trade => ({
  mint: "M",
  signature: `sig${n}`,
  eventIndex: 0,
  slot: 1000 + s * 3 + n,
  blockTimeMs: sec(s),
  receivedAt: sec(s) + 1000,
  side,
  wallet,
  quoteSol: sol,
  priceSol: p,
});
/** Many trades evenly spread over [from, to) seconds with prices from fn. */
function span(from: number, to: number, every: number, price: (s: number) => number, side: (s: number) => "buy" | "sell" = () => "buy") {
  const out: Trade[] = [];
  for (let s = from; s < to; s += every) out.push(tr(s, price(s), side(s)));
  return out;
}

describe("trade events from real logs", () => {
  it("decodes captured pump.fun curve trades and a PumpSwap buy", () => {
    const curve = fixtureJson<{ sig: string; slot: number; logs: string[] }[]>("logs-pump-curve.json");
    const evs = curve.flatMap((t) => parseTradeLogs(t.sig, t.slot, t.logs).events);
    expect(evs).toHaveLength(9);
    expect(evs.every((e) => e.venue === "pump_curve" && e.mintOrPool === "AkWjwenr7Pg7F4pHgAftefCTXZPShgch9HKrwGstpump")).toBe(true);
    const first = evs[0]!;
    expect(first.side).toBe("buy");
    expect(Number(first.quoteAmount) / 1e9).toBeCloseTo(0.01087563, 8);
    expect(Number(first.realQuoteReserves) / 1e9).toBeCloseTo(39.046615447, 6);
    const pool = fixtureJson<{ sig: string; slot: number; logs: string[] }[]>("logs-pumpswap-pool.json");
    const swaps = pool.flatMap((t) => parseTradeLogs(t.sig, t.slot, t.logs).events);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({ venue: "pumpswap", side: "buy", mintOrPool: "B1aZbSxi9xkZC6FNpxDEX8dWQkV2o6PXqzhUUDLefiCS" });
  });

  it("rejects a forged event printed by another program", () => {
    const real = fixtureJson<{ sig: string; slot: number; logs: string[] }[]>("logs-pump-curve.json")[0]!;
    const data = real.logs.find((l) => l.startsWith("Program data: "))!;
    const forged = ["Program EvilEvilEvilEvilEvilEvilEvilEvilEvi1 invoke [1]", data, "Program EvilEvilEvilEvilEvilEvilEvilEvilEvi1 success"];
    const p = parseTradeLogs("x", 1, forged);
    expect(p.events).toHaveLength(0);
    expect(p.spoofed).toBe(1);
    // The same bytes from the real program are accepted.
    expect(parseTradeLogs("x", 1, [`Program ${PROGRAMS.PUMP_CURVE} invoke [1]`, data, `Program ${PROGRAMS.PUMP_CURVE} success`]).events).toHaveLength(1);
  });

  it("notes truncated logs and skips malformed events", () => {
    const p = parseTradeLogs("x", 1, [`Program ${PROGRAMS.PUMP_CURVE} invoke [1]`, "Program data: vdt/007mYe4=", "Log truncated"]);
    expect(p.truncated).toBe(true);
    expect(p.events).toHaveLength(0);
  });

  it("decodes a real PumpSwap pool account", () => {
    const d = fixtureJson<{ result: { value: { data: [string, string] } } }>("rpc-pumpswap-pool.json");
    const pool = decodePumpSwapPool(Uint8Array.from(Buffer.from(d.result.value.data[0], "base64")));
    expect(pool.baseMint).toBe("EeRnxWKPmLByLXta19P5Y8EA1xNf4B1HxNsGkXAXpump");
    expect(pool.quoteMint).toBe("So11111111111111111111111111111111111111112");
  });
});

describe("features", () => {
  it("only sees trades that had arrived by decision time (no look-ahead)", () => {
    const tape = [tr(0, 1), tr(10, 1.1)];
    tape.push({ ...tr(19, 2), receivedAt: sec(25) }); // happened at 19 s, arrived at 25 s
    expect(computeFeatures("M", tape, sec(20)).last).toBe(1.1);
    expect(computeFeatures("M", tape, sec(26)).last).toBe(2);
  });

  it("flags sparse, stale, laggy and gapped data", () => {
    const q = computeFeatures("M", [tr(0, 1)], sec(100)).quality;
    expect(q.ok).toBe(false);
    expect(q.reasons.join(" ")).toMatch(/sparse/);
    expect(q.reasons.join(" ")).toMatch(/stale/);
    const lagged = span(0, 100, 2, () => 1).map((t) => ({ ...t, receivedAt: t.blockTimeMs + 20_000 }));
    expect(computeFeatures("M", lagged, sec(121)).quality.reasons.join(" ")).toMatch(/lag/);
    const good = span(0, 100, 2, () => 1);
    expect(computeFeatures("M", good, sec(101), [{ from: sec(50), to: sec(60) }]).quality.reasons.join(" ")).toMatch(/gap/);
  });

  it("measures participation, imbalance, concentration and repeated sizes", () => {
    const tape = [...span(240, 300, 2, () => 1)];
    // A single wallet buying in identical sizes.
    for (let s = 250; s < 300; s += 5) tape.push(tr(s, 1, "buy", "whale", 1.0));
    const f = computeFeatures("M", tape, sec(300));
    expect(f.topBuyerShare60).toBeGreaterThan(0.5);
    expect(f.repeatedSizeRatio60).toBeGreaterThan(0.2);
    expect(f.imbalance60).toBe(1);
  });

  it("builds candles only from real trades and marks sparse ones", () => {
    const c = buildCandles([tr(0, 1), tr(1, 2), tr(2, 1.5), tr(40, 3)], sec(60), 15_000, 3);
    expect(c).toHaveLength(2); // the empty 15–30 s interval is not invented
    expect(c[0]).toMatchObject({ open: 1, high: 2, low: 1, close: 1.5, trades: 3, sparse: false });
    expect(c[1]!.sparse).toBe(true);
  });
});

/** Synthetic shapes for each setup (SYNTHETIC: for rule testing only). */
function continuationTape(breakout: number) {
  const t: Trade[] = [];
  t.push(...span(0, 120, 3, (s) => 1 + (s / 120) * 0.2)); // impulse 1.0 → 1.2
  t.push(...span(120, 240, 3, () => 1.2)); // holds at the top
  t.push(...span(240, 290, 2, (s) => 1.18 + ((s % 4) / 4) * 0.02)); // tight base 1.18–1.195
  t.push(tr(292, 1.2 * breakout, "buy", "x1"), tr(295, 1.2 * breakout, "buy", "x2"), tr(298, 1.2 * breakout, "buy", "x3"));
  return t;
}

describe("strategies (synthetic scenarios)", () => {
  it("A fires on a tight base breakout and refuses a chase", () => {
    const sig = strategyA(computeFeatures("M", continuationTape(1.01), sec(300)), {});
    expect(sig.action).toBe("ENTER");
    expect(sig.invalidationPrice!).toBeLessThan(sig.refPrice!);
    expect(sig.targetPrice!).toBeGreaterThan(sig.refPrice!);
    const chase = strategyA(computeFeatures("M", continuationTape(1.12), sec(300)), {});
    expect(chase.action).toBe("NONE");
  });

  it("A refuses when the data is poor, whatever the shape", () => {
    const sparse = continuationTape(1.01).filter((_, i) => i % 10 === 0);
    expect(strategyA(computeFeatures("M", sparse, sec(300)), {}).reasons[0]).toMatch(/^data:/);
  });

  it("B no-retest fires on an accelerating breakout; B retest waits for the retest", () => {
    const t: Trade[] = [...span(0, 240, 4, (s) => 1 + 0.08 * Math.sin(s / 20))]; // range 0.92–1.08
    t.push(...span(242, 270, 3, () => 1.1)); // breakout, after the range window ends at −60 s
    t.push(...span(270, 300, 1, () => 1.12)); // accelerating, holding above
    const f = computeFeatures("M", t, sec(300));
    expect(strategyB(f, {}, "no_retest").action).toBe("ENTER");
    expect(strategyB(f, {}, "retest").reasons[0]).toMatch(/no retest/);
    const r = [...span(0, 240, 4, (s) => 1 + 0.08 * Math.sin(s / 20)), ...span(242, 265, 3, () => 1.12), ...span(271, 290, 2, () => 1.085), tr(294, 1.1, "buy", "y1"), tr(297, 1.11, "buy", "y2")];
    expect(strategyB(computeFeatures("M", r, sec(300)), {}, "retest").action).toBe("ENTER");
  });

  it("C needs a young token, broad new buyers and no runaway move", () => {
    const t: Trade[] = [...span(200, 270, 7, () => 1)];
    for (let s = 270; s < 300; s += 1) t.push(tr(s, 1 + (s - 270) * 0.002));
    const f = computeFeatures("M", t, sec(300));
    expect(strategyC(f, { tokenAgeMs: 5 * 60_000 }).action).toBe("ENTER");
    expect(strategyC(f, { tokenAgeMs: 60 * 60_000 }).reasons[0]).toMatch(/not new/);
    expect(strategyC(f, {}).reasons[0]).toMatch(/age unknown/);
  });

  it("D vetoes entries on a dump and exits an open position below invalidation, but never exits on bad data alone", () => {
    const t: Trade[] = [...span(0, 270, 3, () => 1), ...span(270, 300, 1, (s) => 1 - (s - 270) * 0.004, () => "sell")];
    const f = computeFeatures("M", t, sec(300));
    expect(strategyD(f).action).toBe("VETO");
    expect(strategyD(f, { invalidationPrice: 0.95 }).action).toBe("EXIT");
    const stale = computeFeatures("M", [tr(0, 1)], sec(300));
    expect(strategyD(stale, { invalidationPrice: 0.5 }).action).toBe("VETO");
  });
});

describe("risk manager", () => {
  const sig: Signal = { strategy: "A_continuation", action: "ENTER", reasons: ["ok"], refPrice: 1, maxEntryPrice: 1.03, invalidationPrice: 0.95, targetPrice: 1.2, expectedMovePct: 0.2, timeStopMs: 180_000, cooldownMs: 1 };
  const base = (): RiskInput => ({
    now: T,
    signal: sig,
    failure: { action: "NONE", reasons: [] },
    feedsHealthy: true,
    feedReasons: [],
    quality: { ok: true, reasons: [], trades180s: 50, secondsSinceLastTrade: 1, medianLagS: 1, inGap: false },
    assessment: { at: T - 30_000, verdict: "PASS", researchOnly: false, totalCostBps: 300, breakEvenPct: 3.1, sizeCad: 30, solCad: 140 },
    lastPrice: 1.01,
    state: { day: "2026-10-26", realizedLossCad: 0, entries: 0, consecutiveLosses: 0, haltedReason: null },
    openPositions: 0,
    pendingOrders: 0,
    openRiskCad: 0,
    limitsRefused: [],
  });
  const fail = (i: RiskInput) => decideEntry(i, DEFAULT_LIMITS).firstFailure;

  it("approves a complete plan, sizes from the loss budget, and stays paper-only", () => {
    const d = decideEntry(base(), DEFAULT_LIMITS);
    expect(d.approved).toBe(true);
    expect(d.mode).toBe("paper");
    expect(d.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    // stop 5% + cost 3% + stress 2% = 10% of size at risk → CAD 25 for a CAD 2.50 budget
    expect(d.sizeCad).toBe(25);
    expect(d.plannedLossCad).toBe(2.5);
  });

  it("stops at the first failing gate, in the spec's order", () => {
    expect(fail({ ...base(), feedsHealthy: false, feedReasons: ["stream down"] })).toBe("DATA_HEALTH");
    expect(fail({ ...base(), assessment: { ...base().assessment!, at: T - 10 * 60_000 } })).toBe("TOKEN_GATE");
    expect(fail({ ...base(), assessment: { ...base().assessment!, verdict: "REJECT", researchOnly: true } })).toBe("TOKEN_GATE");
    expect(fail({ ...base(), failure: { action: "VETO", reasons: ["dump"] } })).toBe("REGIME");
    expect(fail({ ...base(), signal: { ...sig, action: "NONE", reasons: ["no setup"] } })).toBe("SETUP");
    expect(fail({ ...base(), signal: { ...sig, invalidationPrice: 1.2 } })).toBe("CONFIRMATION");
    expect(fail({ ...base(), lastPrice: 1.1 })).toBe("ENTRY_PRICE");
  });

  it("rejects when the expected move doesn't clear costs plus margin", () => {
    expect(fail({ ...base(), signal: { ...sig, targetPrice: 1.04, expectedMovePct: 0.04 } })).toBe("COSTS");
  });

  it("refuses to size up a wide stop", () => {
    // stop 20% + 3% + 2% = 25% at risk → CAD 10, below the CAD 15 minimum
    expect(fail({ ...base(), signal: { ...sig, invalidationPrice: 0.8, targetPrice: 1.8, expectedMovePct: 0.8 } })).toBe("SIZING");
  });

  it("enforces one position, no pending orders, 3 entries/day, losing streaks, the daily loss budget and halts", () => {
    const st = base().state;
    expect(fail({ ...base(), openPositions: 1 })).toBe("PORTFOLIO");
    expect(fail({ ...base(), pendingOrders: 1 })).toBe("PORTFOLIO");
    expect(fail({ ...base(), state: { ...st, entries: 3 } })).toBe("PORTFOLIO");
    expect(fail({ ...base(), state: { ...st, consecutiveLosses: 3 } })).toBe("PORTFOLIO");
    expect(fail({ ...base(), state: { ...st, realizedLossCad: 8 } })).toBe("PORTFOLIO");
    expect(fail({ ...base(), state: { ...st, haltedReason: "kill switch" } })).toBe("PORTFOLIO");
    expect(fail({ ...base(), limitsRefused: ["maxPositionCad"] })).toBe("PORTFOLIO");
  });
});

describe("risk limits and state", () => {
  const dir = mkdtempSync(join(tmpdir(), "limits-"));
  it("tightening needs no confirmation; loosening is refused until the file hash is confirmed", () => {
    const f = join(dir, "limits.json");
    writeFileSync(f, JSON.stringify({ maxPositionCad: 20, dailyLossLimitCad: 50 }));
    const a = loadRiskLimits(f, join(dir, "confirm"));
    expect(a.limits.maxPositionCad).toBe(20);
    expect(a.limits.dailyLossLimitCad).toBe(DEFAULT_LIMITS.dailyLossLimitCad);
    expect(a.refused).toEqual(["dailyLossLimitCad"]);
    writeFileSync(join(dir, "confirm"), createHash("sha256").update(JSON.stringify({ maxPositionCad: 20, dailyLossLimitCad: 50 })).digest("hex"));
    const b = loadRiskLimits(f, join(dir, "confirm"));
    expect(b.limits.dailyLossLimitCad).toBe(50);
    expect(b.loosenedConfirmed).toEqual(["dailyLossLimitCad"]);
  });

  it("rejects unknown keys in the limits file", () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, JSON.stringify({ leverage: 10 }));
    expect(() => loadRiskLimits(f)).toThrow();
  });

  it("persists losses, entries and halts across a restart; a new UTC day resets entries but not the losing streak", () => {
    const path = join(dir, "state.sqlite");
    let now = Date.parse("2026-10-26T12:00:00Z");
    let db = openDb(path);
    let s = new RiskStateStore(db, () => now);
    s.recordEntry();
    s.recordClose(-2);
    s.recordClose(-1.5);
    s.halt("daily loss");
    db.close();
    db = openDb(path);
    s = new RiskStateStore(db, () => now);
    expect(s.today()).toMatchObject({ entries: 1, realizedLossCad: 3.5, consecutiveLosses: 2, haltedReason: "daily loss" });
    now = Date.parse("2026-10-27T00:01:00Z");
    expect(s.today()).toMatchObject({ entries: 0, realizedLossCad: 0, consecutiveLosses: 2, haltedReason: null });
    db.close();
  });
});

describe("exit engine", () => {
  const pos: OpenPosition = { entryAt: T, entryPrice: 1, costBasisSol: 0.2, invalidationPrice: 0.95, targetPrice: 1.15, timeStopMs: 180_000, peakNetSol: 0.2, partialTaken: false };
  const ctx = (o: Partial<ExitContext> = {}): ExitContext => ({ now: T + 10_000, lastPrice: 1.02, sellNetSol: 0.199, sellRouteAvailable: true, tokenRestricted: false, riskLimitBreached: false, failure: { action: "NONE", reasons: [] }, ...o });

  it("holds when nothing has triggered", () => {
    expect(decideExit(pos, ctx()).action).toBe("HOLD");
  });

  it("follows the spec's priority order when several rules match", () => {
    const d = decideExit(pos, ctx({ lastPrice: 0.9, tokenRestricted: true, now: T + 999_000, failure: { action: "EXIT", reasons: ["x"] } }));
    expect(d.reason).toBe("EMERGENCY");
    expect(d.matched.map((m) => m.reason)).toEqual(["EMERGENCY", "INVALIDATION", "STRATEGY", "TIME_STOP"]);
  });

  it("takes profit on net proceeds, trails, and time-stops", () => {
    expect(decideExit(pos, ctx({ lastPrice: 1.16, sellNetSol: 0.225 })).reason).toBe("PROFIT_TARGET");
    expect(decideExit(pos, ctx({ lastPrice: 1.16, sellNetSol: 0.225 }), { maxExitImpactPct: 0.05, profitMode: "partial", trailActivatePct: 0.04, trailGivebackPct: 0.03 }).action).toBe("EXIT_PARTIAL");
    expect(decideExit({ ...pos, peakNetSol: 0.22 }, ctx({ sellNetSol: 0.21 })).reason).toBe("TRAILING");
    expect(decideExit(pos, ctx({ now: T + 181_000 })).reason).toBe("TIME_STOP");
  });

  it("never fires blind sells: no route or no fresh quote means ALERT", () => {
    const d = decideExit(pos, ctx({ lastPrice: 0.8, sellRouteAvailable: false }));
    expect(d.action).toBe("ALERT");
    expect(d.reason).toBe("INVALIDATION");
    expect(decideExit(pos, ctx({ lastPrice: 0.8, sellNetSol: undefined })).action).toBe("ALERT");
  });
});
