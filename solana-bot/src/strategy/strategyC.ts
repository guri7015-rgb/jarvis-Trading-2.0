/**
 * Strategy C: early acceleration on very new tokens.
 * The most exposed to manipulation, thin books and our own latency, so its
 * filters are the strictest. Spec: docs/STRATEGIES.md#c. Placeholders throughout.
 */
import type { Features } from "./features.ts";
import { pct } from "./strategyA.ts";
import { none, type Signal, type StrategyContext } from "./types.ts";

export const C_PARAMS = {
  maxTokenAgeMs: 10 * 60_000,
  minTrades30: 10,
  minRateAccel: 2,
  minNewBuyers30: 6,
  minImbalance60: 0.3,
  maxTopBuyerShare: 0.25,
  maxRepeatedSizeRatio: 0.3,
  /** The move must have started but not run away. */
  minRet60: 0.03,
  maxRet60: 0.25,
  stopBelowLow60Pct: 0.01,
  /** Fixed objective; C has no structure to measure a target from. */
  targetPct: 0.12,
  timeStopMs: 120_000,
  cooldownMs: 10 * 60_000,
};

export function strategyC(f: Features, ctx: StrategyContext, p = C_PARAMS): Signal {
  const id = "C_early_acceleration" as const;
  if (!f.quality.ok) return none(id, [`data: ${f.quality.reasons.join("; ")}`], p.cooldownMs);
  if (ctx.tokenAgeMs === undefined) return none(id, ["token age unknown"], p.cooldownMs);
  if (ctx.tokenAgeMs > p.maxTokenAgeMs) return none(id, ["token not new"], p.cooldownMs);
  const { last, low60, ret60 } = f;
  if (last === null || low60 === null || ret60 === null) return none(id, ["not enough history"], p.cooldownMs);
  if (f.trades30 < p.minTrades30) return none(id, [`only ${f.trades30} trades/30s`], p.cooldownMs);
  if (f.rateAccel < p.minRateAccel) return none(id, [`not accelerating (${f.rateAccel.toFixed(1)}x)`], p.cooldownMs);
  if (f.newBuyers30 < p.minNewBuyers30) return none(id, [`only ${f.newBuyers30} new buyers/30s`], p.cooldownMs);
  if (f.imbalance60 < p.minImbalance60) return none(id, [`buy imbalance ${f.imbalance60.toFixed(2)}`], p.cooldownMs);
  if (f.topBuyerShare60 > p.maxTopBuyerShare) return none(id, [`one wallet is ${pct(f.topBuyerShare60)} of buying`], p.cooldownMs);
  if (f.repeatedSizeRatio60 > p.maxRepeatedSizeRatio) return none(id, [`${pct(f.repeatedSizeRatio60)} of trades repeat exact sizes`], p.cooldownMs);
  if (ret60 < p.minRet60) return none(id, [`move too small (${pct(ret60)})`], p.cooldownMs);
  if (ret60 > p.maxRet60) return none(id, [`already extended (${pct(ret60)} in 60s)`], p.cooldownMs);
  const target = last * (1 + p.targetPct);
  return {
    strategy: id,
    action: "ENTER",
    reasons: [`${f.trades30} trades/30s (${f.rateAccel.toFixed(1)}x)`, `${f.newBuyers30} new buyers`, `imbalance ${f.imbalance60.toFixed(2)}`, `+${pct(ret60)} in 60s`],
    refPrice: last,
    maxEntryPrice: last * 1.02,
    invalidationPrice: low60 * (1 - p.stopBelowLow60Pct),
    targetPrice: target,
    expectedMovePct: p.targetPct,
    timeStopMs: p.timeStopMs,
    cooldownMs: p.cooldownMs,
  };
}
