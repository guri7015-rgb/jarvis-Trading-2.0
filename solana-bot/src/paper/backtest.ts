/**
 * Replay backtester over recorded trade tapes.
 *
 * Same strategies, risk manager and exit engine as live. What differs is the
 * fill model: there are no historical Jupiter quotes, so fills are MODELLED
 * from the tape price plus a per-venue cost model fitted to Phase 3's measured
 * round trips. Every result from here is labelled MODELLED.
 *
 * Look-ahead: a trade is visible only after its recorded arrival time; a fill
 * is priced from the first trade that arrives after the decision plus the
 * simulated latency, never from the decision-time price.
 */
import type { RiskLimits } from "../risk/limits.ts";
import { decideEntry, type AssessmentView } from "../risk/manager.ts";
import type { DayState } from "../risk/riskState.ts";
import { DEFAULT_EXIT_POLICY, decideExit, type ExitPolicy } from "../strategy/exits.ts";
import { computeFeatures, visible, type Trade } from "../strategy/features.ts";
import { strategyA } from "../strategy/strategyA.ts";
import { strategyB } from "../strategy/strategyB.ts";
import { strategyC } from "../strategy/strategyC.ts";
import { strategyD } from "../strategy/strategyD.ts";
import type { Signal, StrategyId } from "../strategy/types.ts";

export interface CostModel {
  /** Venue fee per side, fraction (pump curve 0.0125 documented; PumpSwap by tier). */
  venueFeePerSide: number;
  /** Price impact per side for the evaluation size, fraction (Phase 3 median by venue). */
  impactPerSide: number;
  /** Extra adverse move on fills (latency, stress). */
  haircut: number;
  /** Probability an entry or exit fails; fees still paid. */
  failureRate: number;
  /** Probability a sell finds no route at all (position stuck until a later tick finds one). */
  noRouteRate: number;
  latencyMs: [number, number];
  networkFeeSol: number;
  rentSol: number;
}

/** Phase 3 measurements, 2026-10-26: pump curve round trip ~3.05%, PumpSwap ~1.96%. */
export const COST_MODELS: Record<"pump_curve" | "pumpswap", CostModel> = {
  pump_curve: { venueFeePerSide: 0.0125, impactPerSide: 0.003, haircut: 0.01, failureRate: 0.1, noRouteRate: 0.02, latencyMs: [4000, 12000], networkFeeSol: 0.000405, rentSol: 0.00207408 },
  pumpswap: { venueFeePerSide: 0.0075, impactPerSide: 0.0025, haircut: 0.01, failureRate: 0.1, noRouteRate: 0.01, latencyMs: [4000, 12000], networkFeeSol: 0.000405, rentSol: 0.00207408 },
};

export interface BacktestTrade {
  mint: string;
  strategy: StrategyId;
  entryAt: number;
  exitAt: number | null;
  entryPrice: number;
  exitPrice: number | null;
  sizeSol: number;
  costBasisSol: number;
  proceedsSol: number;
  pnlSol: number;
  pnlPct: number;
  grossChartPct: number;
  reason: string;
  holdMs: number;
  failedEntry: boolean;
  stuck: boolean;
}

export interface BacktestOptions {
  limits: RiskLimits;
  exitPolicy?: ExitPolicy;
  stepMs: number;
  sizeCad: number;
  solCad: number;
  random: () => number;
  /** Token age for C, if known. */
  tokenAgeMs?: number;
  strategies?: StrategyId[];
}

export interface BacktestResult {
  label: "MODELLED";
  trades: BacktestTrade[];
  steps: number;
  signals: number;
  rejectedByGate: Record<string, number>;
}

const rnd = (r: () => number, [a, b]: [number, number]) => a + (b - a) * r();

/** First visible trade at or after time t (chain time), as the fill reference. */
function fillRef(tape: Trade[], t: number, arrivalBy: number): Trade | undefined {
  for (const x of tape) if (x.blockTimeMs >= t && x.receivedAt <= arrivalBy) return x;
  return undefined;
}

export function backtestTape(mint: string, venue: "pump_curve" | "pumpswap", tape: Trade[], gaps: { from: number; to: number }[], o: BacktestOptions): BacktestResult {
  const cm = COST_MODELS[venue];
  const sorted = [...tape].sort((a, b) => a.blockTimeMs - b.blockTimeMs);
  const trades: BacktestTrade[] = [];
  const rejected: Record<string, number> = {};
  let signals = 0;
  let steps = 0;
  let cooldown = new Map<string, number>();
  const state: DayState = { day: "replay", realizedLossCad: 0, entries: 0, consecutiveLosses: 0, haltedReason: null };
  const start = sorted[0]!.receivedAt + 60_000;
  const end = sorted[sorted.length - 1]!.receivedAt;
  let open: { entryAt: number; entryPrice: number; tokens: number; costBasis: number; sig: Signal; peakNet: number; partial: boolean; stuck: boolean; fees: number } | undefined;
  const roundTripCost = 2 * (cm.venueFeePerSide + cm.impactPerSide) + 2 * cm.haircut;
  const assessment: AssessmentView = { at: 0, verdict: "PASS", researchOnly: false, totalCostBps: Math.round(roundTripCost * 10_000), breakEvenPct: roundTripCost * 100, sizeCad: o.sizeCad, solCad: o.solCad };
  const strategies = o.strategies ?? ["A_continuation", "B_breakout_retest", "B_breakout_no_retest", "C_early_acceleration"];
  const sizeSol = o.sizeCad / o.solCad;

  for (let now = start; now <= end; now += o.stepMs) {
    steps++;
    const vis = visible(sorted, now).filter((t) => t.blockTimeMs >= now - 300_000);
    const f = computeFeatures(mint, vis, now, gaps);
    // Manage an open position first (exits don't depend on entry gates).
    if (open) {
      const held = open.tokens;
      const lastPx = f.last;
      // Net sell value now: price × tokens × (1 − fee − impact), minus network fee.
      const sellNet = lastPx !== null ? held * lastPx * (1 - cm.venueFeePerSide - cm.impactPerSide) - cm.networkFeeSol : undefined;
      if (sellNet !== undefined) open.peakNet = Math.max(open.peakNet, sellNet);
      const routeOk = !(open.stuck && o.random() > 0.3); // a stuck route comes back with 30% chance per tick
      const failure = strategyD(f, { breakoutLevel: open.sig.strategy.startsWith("B_") ? open.sig.maxEntryPrice : undefined, invalidationPrice: open.sig.invalidationPrice });
      const d = decideExit(
        { entryAt: open.entryAt, entryPrice: open.entryPrice, costBasisSol: open.costBasis, invalidationPrice: open.sig.invalidationPrice!, targetPrice: open.sig.targetPrice!, timeStopMs: open.sig.timeStopMs!, peakNetSol: open.peakNet, partialTaken: open.partial },
        { now, lastPrice: lastPx, sellNetSol: routeOk ? sellNet : undefined, sellRouteAvailable: routeOk, tokenRestricted: false, riskLimitBreached: false, failure },
        o.exitPolicy ?? DEFAULT_EXIT_POLICY,
      );
      if (d.action === "ALERT") open.stuck = true;
      else if (d.action === "EXIT" || d.action === "EXIT_PARTIAL") {
        const lat = rnd(o.random, cm.latencyMs);
        const ref = fillRef(sorted, now + lat, now + lat + 15_000);
        const fillPx = ref ? ref.priceSol * (1 - cm.haircut) : null;
        if (o.random() < cm.noRouteRate || fillPx === null) {
          open.stuck = true;
          open.fees += cm.networkFeeSol;
        } else if (o.random() < cm.failureRate) {
          open.fees += cm.networkFeeSol;
        } else {
          const sellTokens = d.action === "EXIT_PARTIAL" ? held / 2 : held;
          const proceeds = sellTokens * fillPx * (1 - cm.venueFeePerSide - cm.impactPerSide) - cm.networkFeeSol;
          if (d.action === "EXIT_PARTIAL") {
            open.tokens -= sellTokens;
            open.partial = true;
            open.costBasis -= proceeds; // remaining basis after the partial
            open.stuck = false;
          } else {
            const pnl = proceeds + (open.partial ? 0 : 0) - open.costBasis - open.fees;
            trades.push({
              mint,
              strategy: open.sig.strategy,
              entryAt: open.entryAt,
              exitAt: now + lat,
              entryPrice: open.entryPrice,
              exitPrice: fillPx,
              sizeSol,
              costBasisSol: open.costBasis + open.fees,
              proceedsSol: proceeds,
              pnlSol: pnl,
              pnlPct: pnl / (open.costBasis + open.fees),
              grossChartPct: fillPx / open.entryPrice - 1,
              reason: d.reason ?? "EXIT",
              holdMs: now + lat - open.entryAt,
              failedEntry: false,
              stuck: false,
            });
            state.realizedLossCad += Math.max(0, -pnl * o.solCad);
            state.consecutiveLosses = pnl < 0 ? state.consecutiveLosses + 1 : 0;
            open = undefined;
          }
        }
      }
      if (open) continue; // one position at a time
    }
    // Entries.
    const ctx = { tokenAgeMs: o.tokenAgeMs };
    const failure = strategyD(f);
    const sigs: Signal[] = [];
    if (strategies.includes("A_continuation")) sigs.push(strategyA(f, ctx));
    if (strategies.includes("B_breakout_retest")) sigs.push(strategyB(f, ctx, "retest"));
    if (strategies.includes("B_breakout_no_retest")) sigs.push(strategyB(f, ctx, "no_retest"));
    if (strategies.includes("C_early_acceleration")) sigs.push(strategyC(f, ctx));
    for (const s of sigs) {
      if (s.action !== "ENTER") continue;
      if ((cooldown.get(s.strategy) ?? 0) > now) continue;
      cooldown.set(s.strategy, now + s.cooldownMs);
      signals++;
      const dec = decideEntry({ now, signal: s, failure, feedsHealthy: true, feedReasons: [], quality: f.quality, assessment: { ...assessment, at: now }, lastPrice: f.last, state, openPositions: open ? 1 : 0, pendingOrders: 0, openRiskCad: 0, limitsRefused: [] }, o.limits);
      if (!dec.approved) {
        const k = dec.firstFailure ?? "?";
        rejected[k] = (rejected[k] ?? 0) + 1;
        continue;
      }
      const lat = rnd(o.random, cm.latencyMs);
      const ref = fillRef(sorted, now + lat, now + lat + 15_000);
      if (!ref) continue;
      const fillPx = ref.priceSol * (1 + cm.haircut);
      if (fillPx > s.maxEntryPrice!) {
        rejected["ENTRY_PRICE_AT_FILL"] = (rejected["ENTRY_PRICE_AT_FILL"] ?? 0) + 1;
        continue;
      }
      state.entries++;
      const size = (dec.sizeCad ?? o.sizeCad) / o.solCad;
      if (o.random() < cm.failureRate) {
        trades.push({ mint, strategy: s.strategy, entryAt: now + lat, exitAt: null, entryPrice: fillPx, exitPrice: null, sizeSol: size, costBasisSol: cm.networkFeeSol, proceedsSol: 0, pnlSol: -cm.networkFeeSol, pnlPct: -cm.networkFeeSol / size, grossChartPct: 0, reason: "ENTRY_FAILED", holdMs: 0, failedEntry: true, stuck: false });
        continue;
      }
      const tokens = (size * (1 - cm.venueFeePerSide - cm.impactPerSide)) / fillPx;
      open = { entryAt: now + lat, entryPrice: fillPx, tokens, costBasis: size + cm.networkFeeSol, sig: s, peakNet: 0, partial: false, stuck: false, fees: 0 };
      break;
    }
  }
  if (open) {
    // Still holding at the end of the tape: mark at the last price, labelled as unrealised.
    const last = sorted[sorted.length - 1]!.priceSol;
    const proceeds = open.tokens * last * (1 - cm.venueFeePerSide - cm.impactPerSide) - cm.networkFeeSol;
    const pnl = proceeds - open.costBasis - open.fees;
    trades.push({ mint, strategy: open.sig.strategy, entryAt: open.entryAt, exitAt: null, entryPrice: open.entryPrice, exitPrice: null, sizeSol, costBasisSol: open.costBasis + open.fees, proceedsSol: proceeds, pnlSol: pnl, pnlPct: pnl / (open.costBasis + open.fees), grossChartPct: last / open.entryPrice - 1, reason: open.stuck ? "STUCK_AT_END" : "OPEN_AT_END", holdMs: end - open.entryAt, failedEntry: false, stuck: open.stuck });
  }
  return { label: "MODELLED", trades, steps, signals, rejectedByGate: rejected };
}

export interface Stats {
  n: number;
  wins: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  expectancyPct: number;
  profitFactor: number;
  netPnlSol: number;
  maxDrawdownSol: number;
  largestLossSol: number;
  maxConsecutiveLosses: number;
  timeInMarketMs: number;
  byStrategy: Record<string, { n: number; netPnlSol: number; winRate: number }>;
  byReason: Record<string, number>;
}

export function summarize(trades: BacktestTrade[]): Stats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlSol > 0);
  const losses = trades.filter((t) => t.pnlSol <= 0);
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  let streak = 0;
  let maxStreak = 0;
  for (const t of [...trades].sort((a, b) => a.entryAt - b.entryAt)) {
    eq += t.pnlSol;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
    streak = t.pnlSol < 0 ? streak + 1 : 0;
    maxStreak = Math.max(maxStreak, streak);
  }
  const byStrategy: Stats["byStrategy"] = {};
  for (const t of trades) {
    const b = (byStrategy[t.strategy] ??= { n: 0, netPnlSol: 0, winRate: 0 });
    b.n++;
    b.netPnlSol += t.pnlSol;
    b.winRate += t.pnlSol > 0 ? 1 : 0;
  }
  for (const b of Object.values(byStrategy)) b.winRate = b.n ? b.winRate / b.n : 0;
  const byReason: Record<string, number> = {};
  for (const t of trades) byReason[t.reason] = (byReason[t.reason] ?? 0) + 1;
  const grossWin = sum(wins.map((t) => t.pnlSol));
  const grossLoss = -sum(losses.map((t) => t.pnlSol));
  return {
    n,
    wins: wins.length,
    winRate: n ? wins.length / n : 0,
    avgWinPct: wins.length ? sum(wins.map((t) => t.pnlPct)) / wins.length : 0,
    avgLossPct: losses.length ? sum(losses.map((t) => t.pnlPct)) / losses.length : 0,
    expectancyPct: n ? sum(trades.map((t) => t.pnlPct)) / n : 0,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    netPnlSol: sum(trades.map((t) => t.pnlSol)),
    maxDrawdownSol: dd,
    largestLossSol: losses.length ? Math.min(...losses.map((t) => t.pnlSol)) : 0,
    maxConsecutiveLosses: maxStreak,
    timeInMarketMs: sum(trades.map((t) => t.holdMs)),
    byStrategy,
    byReason,
  };
}

/** Chronological split of a tape window into train / validation / test by time, never by trade. */
export function splitWindows(startMs: number, endMs: number, fractions: [number, number, number] = [0.5, 0.25, 0.25]): { train: [number, number]; validation: [number, number]; test: [number, number] } {
  const span = endMs - startMs;
  const a = startMs + span * fractions[0];
  const b = a + span * fractions[1];
  return { train: [startMs, a], validation: [a, b], test: [b, endMs] };
}
