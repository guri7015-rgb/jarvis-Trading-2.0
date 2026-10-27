import { describe, expect, it } from "vitest";
import type { Clock } from "../src/core/clock.ts";
import { silentLogger } from "../src/core/log.ts";
import type { FxQuote } from "../src/market/fx.ts";
import { parseQuote, QuoteError, type QuoteClient, type QuoteRequest } from "../src/market/quotes.ts";
import { PaperExecutor, type SimParams } from "../src/paper/executor.ts";
import { Ledger } from "../src/paper/ledger.ts";
import { PaperTrader } from "../src/paper/trader.ts";
import { BASE_FEE_LAMPORTS } from "../src/risk/costs.ts";
import type { RiskDecision } from "../src/risk/manager.ts";
import { RiskStateStore } from "../src/risk/riskState.ts";
import { MINTS } from "../src/solana/programs.ts";
import { openDb } from "../src/storage/db.ts";
import type { Features } from "../src/strategy/features.ts";
import type { Signal } from "../src/strategy/types.ts";
import { fixtureJson, ImmediateClock, PUMP_MINT } from "./helpers.ts";

const T0 = Date.parse("2026-10-26T12:00:00Z");
const FX: FxQuote = { solCad: 140, solUsd: 100, usdCad: 1.4, solUsdAt: T0, usdCadDate: "2026-10-23", evidence: "DERIVED" };

/**
 * Fake Jupiter: prices from a settable "market" level. buy: lamports → tokens at
 * price; sell: tokens → lamports at price × (1 − fee). `noRoute` kills sells.
 */
function fakeQuotes(clock: Clock) {
  const st = { price: 1e-6, fee: 0.0125, noRoute: false, calls: 0, onCall: undefined as undefined | ((n: number) => void) };
  const qc = {
    async quote(req: QuoteRequest) {
      st.calls++;
      st.onCall?.(st.calls);
      const isBuy = req.inputMint === MINTS.WSOL;
      if (!isBuy && st.noRoute) throw new QuoteError("NO_ROUTE");
      const raw = fixtureJson<any>(isBuy ? "jupiter-quote-pumpswap-buy.json" : "jupiter-quote-pumpswap-sell.json");
      const swap = (m: string) => (m === MINTS.WSOL ? m : req.inputMint === MINTS.WSOL ? req.outputMint : req.inputMint);
      raw.inputMint = swap(raw.inputMint);
      raw.outputMint = swap(raw.outputMint);
      for (const leg of raw.routePlan) {
        leg.swapInfo.inputMint = swap(leg.swapInfo.inputMint);
        leg.swapInfo.outputMint = swap(leg.swapInfo.outputMint);
      }
      raw.inAmount = req.amount.toString();
      const out = isBuy ? (Number(req.amount) / 1e9 / st.price) * 1e6 * (1 - st.fee) : (Number(req.amount) / 1e6) * st.price * 1e9 * (1 - st.fee);
      raw.outAmount = String(Math.floor(out));
      raw.otherAmountThreshold = String(Math.floor(out * 0.97));
      return parseQuote(raw, req, clock.now());
    },
  } as unknown as QuoteClient;
  return { qc, st };
}

function setup(sim: Partial<SimParams> = {}) {
  const clock = new ImmediateClock(T0);
  const db = openDb(":memory:");
  const ledger = new Ledger(db, () => clock.now());
  ledger.initAccount(500, 140);
  const { qc, st } = fakeQuotes(clock);
  const params: SimParams = { latencyMs: [1000, 1000], stressHaircut: 0.01, failureRate: 0, computeUnits: 200_000, random: () => 0.5, ...sim };
  const executor = new PaperExecutor(qc, clock, () => 10_000, params);
  const riskState = new RiskStateStore(db, () => clock.now());
  const alerts: string[] = [];
  const trader = new PaperTrader({ ledger, executor, quotes: qc, riskState, clock, logger: silentLogger, priorityMicroLamports: () => 10_000, computeUnits: 200_000, slippageBps: 300, markEveryMs: 1000, onAlert: (m) => alerts.push(m) });
  return { clock, db, ledger, st, executor, trader, riskState, alerts };
}

const signal: Signal = { strategy: "A_continuation", action: "ENTER", reasons: ["test"], refPrice: 1e-6, maxEntryPrice: 1.03e-6, invalidationPrice: 0.95e-6, targetPrice: 1.2e-6, expectedMovePct: 0.2, timeStopMs: 180_000, cooldownMs: 1 };
const decision: RiskDecision = { approved: true, mode: "paper", sizeCad: 28, plannedLossCad: 2.5, steps: [] };
const feat = (last: number): Features => ({ last, quality: { ok: true, reasons: [], trades180s: 50, secondsSinceLastTrade: 1, medianLagS: 1, inGap: false, warnings: [] }, imbalance60: 0, sellers60: 0, ret30: 0 }) as unknown as Features;

describe("Ledger", () => {
  it("keeps the paper account and position state idempotent", () => {
    const { ledger } = setup();
    expect(ledger.account()!.cash).toBe(3_571_428_571n); // CAD 500 at 140
    ledger.initAccount(1000, 100); // ignored
    expect(ledger.account()!.startingCad).toBe(500);
  });

  it("refuses to move a position backwards and refuses to sell more than held", async () => {
    const { ledger } = setup();
    ledger.propose({ id: "p1", mint: PUMP_MINT, venue: "pumpswap", strategy: "A_continuation", decimals: 6, plannedSizeLamports: 200_000_000n, plannedLossCad: 2.5, invalidationPrice: 1, targetPrice: 2, timeStopMs: 1000, solCad: 140, fxJson: "{}" });
    const fill = { quoteIn: 200_000_000n, quoteOut: 1000n, quoteImpactPct: 1, quoteRoute: "x", quoteAt: T0, simLatencyMs: 1, baseFee: 5000n, priorityFee: 2000n, rent: 2_074_080n, fillIn: 200_000_000n, fillOut: 1000n };
    expect(ledger.recordEntryFill("p1", fill, 1)).toBe(true);
    expect(ledger.recordEntryFill("p1", fill, 1)).toBe(false); // repeat is a no-op
    expect(ledger.account()!.cash).toBe(3_571_428_571n - 200_000_000n - 7000n - 2_074_080n);
    expect(() => ledger.recordExitFill("p1", { ...fill, fillIn: 2000n, fillOut: 1n }, 2000n, "X", "", 140)).toThrow(/exceeds/);
  });

  it("a keyed exit applied twice credits cash once", () => {
    const { ledger } = setup();
    ledger.propose({ id: "p1", mint: PUMP_MINT, venue: "pumpswap", strategy: "A_continuation", decimals: 6, plannedSizeLamports: 200_000_000n, plannedLossCad: 2.5, invalidationPrice: 1, targetPrice: 2, timeStopMs: 1000, solCad: 140, fxJson: "{}" });
    const fill = { quoteIn: 200_000_000n, quoteOut: 1000n, quoteImpactPct: 1, quoteRoute: "x", quoteAt: T0, simLatencyMs: 1, baseFee: 5000n, priorityFee: 2000n, rent: 2_074_080n, fillIn: 200_000_000n, fillOut: 1000n };
    ledger.recordEntryFill("p1", fill, 1);
    const sell = { ...fill, fillIn: 500n, fillOut: 110_000_000n };
    expect(ledger.recordExitFill("p1", sell, 500n, "TARGET", "", 140, "k1")).toBe(true);
    const cash = ledger.account()!.cash;
    expect(ledger.recordExitFill("p1", sell, 500n, "TARGET", "", 140, "k1")).toBe(false); // replay
    expect(ledger.account()!.cash).toBe(cash);
    expect(ledger.recordExitFill("p1", sell, 500n, "TARGET", "", 140, "k2")).toBe(true); // a genuinely new sell
    expect(ledger.get("p1")!.state).toBe("CLOSED");
  });

  it("recovers after an unclean stop: unresolved entries fail with no P&L, pending exits reopen", () => {
    const { ledger, db } = setup();
    const propose = (id: string) => ledger.propose({ id, mint: PUMP_MINT, venue: "pumpswap", strategy: "A_continuation", decimals: 6, plannedSizeLamports: 200_000_000n, plannedLossCad: 2.5, invalidationPrice: 1, targetPrice: 2, timeStopMs: 1000, solCad: 140, fxJson: "{}" });
    propose("stuckProposed");
    propose("wasExiting");
    const fill = { quoteIn: 200_000_000n, quoteOut: 1000n, quoteImpactPct: 1, quoteRoute: "x", quoteAt: T0, simLatencyMs: 1, baseFee: 5000n, priorityFee: 2000n, rent: 2_074_080n, fillIn: 200_000_000n, fillOut: 1000n };
    ledger.recordEntryFill("wasExiting", fill, 1);
    db.exec("UPDATE positions SET state = 'EXIT_PENDING' WHERE id = 'wasExiting'");
    const cash = ledger.account()!.cash;
    expect(ledger.pending()).toHaveLength(2); // both would block new entries forever
    const r = ledger.recover();
    expect(r).toEqual({ failedUnresolved: ["stuckProposed"], reopened: ["wasExiting"] });
    expect(ledger.get("stuckProposed")!.state).toBe("FAILED");
    expect(ledger.get("stuckProposed")!.realized_pnl_cad).toBe(0);
    expect(ledger.get("wasExiting")!.state).toBe("OPEN");
    expect(ledger.pending()).toHaveLength(0);
    expect(ledger.account()!.cash).toBe(cash); // recovery never moves cash
    expect(ledger.recover()).toEqual({ failedUnresolved: [], reopened: [] });
  });

  it("nested transactions roll back together", () => {
    const { ledger, db } = setup();
    const cash = ledger.account()!.cash;
    expect(() =>
      ledger.atomic(() => {
        db.prepare("UPDATE paper_account SET cash_lamports = '1' WHERE mode = 'paper'").run();
        ledger.atomic(() => {
          throw new Error("inner");
        });
      }),
    ).toThrow(/inner/);
    expect(ledger.account()!.cash).toBe(cash);
  });
});

describe("PaperExecutor", () => {
  it("fills at the fresh quote minus the haircut, after a delay, and charges fees and rent", async () => {
    const { executor, clock } = setup();
    const r = await executor.buy(PUMP_MINT, 200_000_000n, { decimals: 6, program: "token2022" }, 300);
    expect(r.ok).toBe(true);
    expect(r.fill.simLatencyMs).toBe(1000);
    expect(r.fill.fillOut).toBe((r.fill.requoteOut! * 9900n) / 10_000n);
    expect(r.fill.slippageBps).toBe(100);
    expect(r.fill.baseFee).toBe(BASE_FEE_LAMPORTS);
    expect(r.fill.priorityFee).toBe(2000n);
    expect(r.fill.rent).toBe(2_074_080n);
    expect(clock.now()).toBe(T0 + 1000);
  });

  it("fails when the market moves past the quote's minimum-out during the delay", async () => {
    const { executor, st } = setup();
    st.onCall = (n) => {
      if (n === 2) st.price *= 1.05; // price jumps 5% before the fresh quote; min-out allowed 3%
    };
    const r = await executor.buy(PUMP_MINT, 200_000_000n, { decimals: 6, program: "token2022" }, 300);
    expect(r.ok).toBe(false);
    expect(r.fill.failure).toMatch(/slippage exceeded/);
  });

  it("draws simulated on-chain failures that still cost fees", async () => {
    const { executor } = setup({ failureRate: 1 });
    const r = await executor.buy(PUMP_MINT, 200_000_000n, { decimals: 6, program: "token2022" }, 300);
    expect(r.ok).toBe(false);
    expect(r.fill.failure).toMatch(/simulated/);
    expect(r.fill.baseFee + r.fill.priorityFee).toBe(7000n);
  });

  it("reports a missing sell route as noRoute with no fee", async () => {
    const { executor, st } = setup();
    st.noRoute = true;
    const r = await executor.sell(PUMP_MINT, 1_000_000n, 300);
    expect(r.noRoute).toBe(true);
    expect(r.fill.baseFee).toBe(0n);
  });
});

describe("PaperTrader", () => {
  const req = (over: Partial<Parameters<PaperTrader["enter"]>[0]> = {}) => ({ mint: PUMP_MINT, venue: "pumpswap", decimals: 6, program: "token2022" as const, signal, decision, fx: FX, ...over });

  it("opens a position sized from the decision, counts the entry, and marks it", async () => {
    const { trader, ledger, riskState } = setup();
    const p = await trader.enter(req());
    expect(p?.state).toBe("OPEN");
    expect(BigInt(p!.planned_size_lamports)).toBe(200_000_000n); // CAD 28 at 140
    expect(riskState.today().entries).toBe(1);
    expect(trader.openRiskCad()).toBe(2.5);
    expect(ledger.open()).toHaveLength(1);
  });

  it("refuses a second entry while one is open, even with two approved decisions in the same tick", async () => {
    const { trader, ledger, riskState } = setup();
    const first = await trader.enter(req());
    expect(first?.state).toBe("OPEN");
    const second = await trader.enter(req({ mint: MINTS.USDC }));
    expect(second).toBeUndefined();
    expect(ledger.open()).toHaveLength(1);
    expect(riskState.today().entries).toBe(1);
  });

  it("a failed entry is FAILED, pays fees, and counts as a (tiny) loss", async () => {
    const { trader, riskState } = setup({ failureRate: 1 });
    const p = await trader.enter(req());
    expect(p?.state).toBe("FAILED");
    expect(riskState.today().realizedLossCad).toBeCloseTo((7000 / 1e9) * 140, 6);
    expect(trader.openRiskCad()).toBe(0);
  });

  it("takes profit on net proceeds when the target is reached and books CAD P&L", async () => {
    const { trader, ledger, st, clock, riskState } = setup();
    const p = (await trader.enter(req()))!;
    st.price = 1.25e-6; // +25%
    clock.t += 2000;
    const d = await trader.manage(ledger.get(p.id)!, feat(1.25e-6), 140, false);
    expect(d?.action).toBe("EXIT");
    expect(d?.reason).toBe("PROFIT_TARGET");
    const after = ledger.get(p.id)!;
    expect(after.state).toBe("CLOSED");
    expect(after.realized_pnl_cad!).toBeGreaterThan(0);
    // Net of two 1.25% fees, two 1% haircuts and network fees, a +25% move nets well under +25%.
    expect(Number(after.realized_pnl_lamports) / Number(after.cost_basis_lamports)).toBeLessThan(0.22);
    expect(riskState.today().consecutiveLosses).toBe(0);
    expect(ledger.account()!.cash).toBeGreaterThan(3_571_428_571n);
  });

  it("exits on invalidation with a loss, and the loss hits the daily budget", async () => {
    const { trader, ledger, st, clock, riskState } = setup();
    const p = (await trader.enter(req()))!;
    st.price = 0.9e-6;
    clock.t += 2000;
    const d = await trader.manage(ledger.get(p.id)!, feat(0.9e-6), 140, false);
    expect(d?.reason).toBe("INVALIDATION");
    const after = ledger.get(p.id)!;
    expect(after.state).toBe("CLOSED");
    expect(after.realized_pnl_cad!).toBeLessThan(0);
    expect(riskState.today().realizedLossCad).toBeCloseTo(-after.realized_pnl_cad!, 6);
    expect(riskState.today().consecutiveLosses).toBe(1);
  });

  it("marks a position STUCK when the sell route disappears, alerts, and never spams sells", async () => {
    const { trader, ledger, st, clock, alerts } = setup();
    const p = (await trader.enter(req()))!;
    st.noRoute = true;
    clock.t += 2000;
    const d1 = await trader.manage(ledger.get(p.id)!, feat(0.5e-6), 140, false);
    expect(d1?.action).toBe("ALERT");
    expect(ledger.get(p.id)!.state).toBe("STUCK");
    expect(alerts).toHaveLength(1);
    const before = st.calls;
    clock.t += 2000;
    await trader.manage(ledger.get(p.id)!, feat(0.5e-6), 140, false);
    expect(st.calls - before).toBe(1); // one fresh quote attempt per tick, no sell attempts
    // Route returns: the stuck position can still be closed.
    st.noRoute = false;
    st.price = 0.5e-6;
    clock.t += 2000;
    const d3 = await trader.manage(ledger.get(p.id)!, feat(0.5e-6), 140, false);
    expect(d3?.action).toBe("EXIT");
    expect(ledger.get(p.id)!.state).toBe("CLOSED");
  });

  it("time-stops a position that goes nowhere", async () => {
    const { trader, ledger, clock } = setup();
    const p = (await trader.enter(req()))!;
    clock.t += 181_000;
    const d = await trader.manage(ledger.get(p.id)!, feat(1e-6), 140, false);
    expect(d?.reason).toBe("TIME_STOP");
  });

  it("flattens on an explicit kill switch even while holding a profit", async () => {
    const { trader, ledger, clock } = setup();
    const p = (await trader.enter(req()))!;
    clock.t += 2000;
    const d = await trader.manage(ledger.get(p.id)!, feat(1e-6), 140, true);
    expect(d?.reason).toBe("RISK_LIMIT");
  });

  it("snapshots equity as cash plus the net mark of open positions", async () => {
    const { trader, ledger, clock } = setup();
    await trader.enter(req());
    clock.t += 2000;
    await trader.manage(ledger.open()[0]!, feat(1e-6), 140, false);
    const s = ledger.snapshot(trader.marks(), 140);
    expect(s.marks).toBeGreaterThan(0n);
    expect(s.equity).toBeLessThan(3_571_428_571n); // round-trip costs already show
  });
});
