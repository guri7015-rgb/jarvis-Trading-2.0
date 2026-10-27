import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import { silentLogger } from "../src/core/log.ts";
import { deskState } from "../src/dashboard/desk.ts";
import { atr, evaluateMajor, marketMood, parseCandles, type Candle } from "../src/majors/majors.ts";
import { HORIZONS, OutcomeTracker } from "../src/signals/outcomes.ts";
import { openDb } from "../src/storage/db.ts";
import { PUMP_MINT } from "./helpers.ts";

const T = Date.parse("2026-10-27T12:00:00Z");

function decision(db: ReturnType<typeof openDb>, at: number, approved: boolean, firstFailure?: string, mint = PUMP_MINT) {
  const signal = { strategy: "A_continuation", action: "ENTER", reasons: ["test"], refPrice: 1e-6, maxEntryPrice: 1.03e-6, invalidationPrice: 0.95e-6, targetPrice: 1.1e-6, expectedMovePct: 0.1, timeStopMs: 180_000, cooldownMs: 1 };
  const risk = { approved, firstFailure, sizeCad: approved ? 30 : undefined, plannedLossCad: approved ? 2.5 : undefined, rewardToRisk: 0.8, steps: [{ gate: "COSTS", ok: approved, detail: "expected 10.0% vs break-even 4.0%, net R:R 0.80" }] };
  db.prepare("INSERT INTO decisions (at, mint, strategy, action, reasons, signal_json, risk_json) VALUES (?, ?, 'A_continuation', ?, '[]', ?, ?)").run(at, mint, approved ? "PAPER_ELIGIBLE" : "REJECT", JSON.stringify(signal), JSON.stringify(risk));
}

describe("signal scorecard", () => {
  it("registers valid setups only, stamps them, fills horizons on time, and reports beat-cost rates", async () => {
    const db = openDb(":memory:");
    const clock = new FakeClock(T);
    const prices = new Map<string, number>([[PUMP_MINT, 100]]);
    const calls: string[][] = [];
    const tracker = new OutcomeTracker(db, async (m) => (calls.push(m), new Map([...prices].filter(([k]) => m.includes(k)))), clock, silentLogger);
    decision(db, T - 10_000, true); // ENTER
    decision(db, T - 10_000, false, "COSTS"); // valid setup, blocked by cost
    decision(db, T - 10_000, false, "DATA_HEALTH"); // not a valid setup: never scored
    expect(tracker.register()).toBe(2);
    await tracker.tick();
    expect(calls).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) n FROM signal_outcomes WHERE p0 = 100").get()).toEqual({ n: 2 });
    // 1 minute later the price is up 6%: inside the 1m window, outside the others.
    prices.set(PUMP_MINT, 106);
    await clock.advance(60_000);
    await tracker.tick();
    expect(db.prepare("SELECT p_1m, p_5m FROM signal_outcomes LIMIT 1").get()).toEqual({ p_1m: 106, p_5m: null });
    // 5 minutes later, up 2%: below the 4% cost estimate.
    prices.set(PUMP_MINT, 102);
    await clock.advance(240_000);
    await tracker.tick();
    const sc = tracker.scorecard();
    const enter = sc.find((r) => r.verdict === "ENTER")!;
    expect(enter.n).toBe(1);
    expect(enter.horizons.find((h) => h.label === "1m")).toMatchObject({ n: 1, beatCostPct: 100 });
    expect(enter.horizons.find((h) => h.label === "5m")).toMatchObject({ n: 1, beatCostPct: 0 });
    expect(enter.horizons.find((h) => h.label === "5m")!.avgRetPct).toBeCloseTo(2, 5);
    expect(HORIZONS.map((h) => h.label)).toEqual(["1m", "5m", "30m", "4h"]);
    // A horizon missed by more than half its length is never back-filled.
    await clock.advance(3_300_000);
    await tracker.tick();
    expect(db.prepare("SELECT p_30m FROM signal_outcomes LIMIT 1").get()).toEqual({ p_30m: null });

    const desk = deskState({ db, outcomes: tracker, now: () => clock.now() });
    expect(desk.signals.map((s) => s.kind).sort()).toEqual(["ENTER", "SETUP"]);
    expect(desk.signals.find((s) => s.kind === "ENTER")!.outcome?.r1m).toBeCloseTo(6, 5);
    expect(desk.scorecard).toHaveLength(2);
  });
});

describe("majors desk", () => {
  const mk = (n: number, f: (i: number) => Partial<Candle>): Candle[] => Array.from({ length: n }, (_, i) => ({ t: T - (n - i) * 3_600_000, low: 99, high: 101, open: 100, close: 100, volume: 10, ...f(i) }));

  it("parses Coinbase candles oldest first and computes ATR", () => {
    const c = parseCandles([[1700003600, 9, 11, 10, 10.5, 5], [1700000000, 9, 11, 10, 10, 5]]);
    expect(c.map((x) => x.t)).toEqual([1700000000000, 1700003600000]);
    expect(atr(mk(20, () => ({})), 14)).toBe(2);
  });

  it("gives a LONG plan on a breakout with volume, a SHORT on a breakdown, and none inside the range or on thin volume", () => {
    const long = mk(40, (i) => (i === 39 ? { high: 104, close: 103, volume: 20 } : {}));
    const p = evaluateMajor("BTC-USD", long, T, 1.4, 2.5)!;
    expect(p.side).toBe("LONG");
    expect(p.level).toBe(101);
    expect(p.stop).toBeLessThan(103);
    expect(p.target).toBeGreaterThan(103);
    expect(p.targetPct / p.stopPct).toBeCloseTo(2, 6);
    // CAD 2.50 at 1.4 USD/CAD = USD 1.786 of risk across the stop distance.
    expect(p.sizeForRiskCad.units * (103 - p.stop)).toBeCloseTo(2.5 / 1.4, 6);

    const short = mk(40, (i) => (i === 39 ? { low: 96, close: 97, volume: 20 } : {}));
    expect(evaluateMajor("ETH-USD", short, T, 1.4, 2.5)!.side).toBe("SHORT");
    expect(evaluateMajor("SOL-USD", mk(40, () => ({})), T, 1.4, 2.5)!.side).toBe("NONE");
    const thin = mk(40, (i) => (i === 39 ? { high: 104, close: 103, volume: 11 } : {}));
    const t = evaluateMajor("SOL-USD", thin, T, 1.4, 2.5)!;
    expect(t.side).toBe("NONE");
    expect(t.reasons[0]).toMatch(/volume only/);
    expect(evaluateMajor("X", mk(10, () => ({})), T, 1.4, 2.5)).toBeNull();
    const swing = evaluateMajor("BTC-USD", long, T, 1.4, 2.5, undefined, "DAILY")!;
    expect(swing.timeframe).toBe("DAILY");
    expect(swing.reasons[0]).toMatch(/20d high/);
  });

  it("reads the market mood from 24 h moves across the big coins", () => {
    const up = mk(30, (i) => ({ close: 100 + i }));
    const down = mk(30, (i) => ({ close: 130 - i }));
    const m = new Map<string, Candle[]>([["BTC-USD", up], ["ETH-USD", up], ["SOL-USD", up], ["XRP-USD", up], ["DOGE-USD", down]]);
    const mood = marketMood(m);
    expect(mood.mood).toBe("RISK ON");
    expect(mood.upCount).toBe(4);
    expect(mood.moves.find((x) => x.product === "BTC-USD")!.ret24h).toBeCloseTo(24 / 105, 6);
    m.set("BTC-USD", down); m.set("ETH-USD", down); m.set("SOL-USD", down);
    expect(marketMood(m).mood).toBe("RISK OFF");
    expect(marketMood(new Map([["BTC-USD", up]])).mood).toBe("UNKNOWN");
  });
});
