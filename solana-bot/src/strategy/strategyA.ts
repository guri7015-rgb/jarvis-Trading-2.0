/**
 * Strategy A: momentum continuation after consolidation.
 * Spec: docs/STRATEGIES.md#a. All parameters are placeholders until Phase 5–6 data.
 */
import type { Features } from "./features.ts";
import { none, type Signal, type StrategyContext } from "./types.ts";

export const A_PARAMS = {
  /** Prior impulse: price over [−300 s, −60 s] must have risen at least this much low→high. */
  minImpulsePct: 0.1,
  /** Consolidation: last-60 s range no wider than this. */
  maxConsolidationRangePct: 0.06,
  /** Pullback may not give back more than this share of the impulse. */
  maxRetraceOfImpulse: 0.5,
  minBuyers60: 8,
  maxTopBuyerShare: 0.3,
  maxRepeatedSizeRatio: 0.35,
  /** Breakout: last trade above the consolidation high by at least this. */
  minBreakoutPct: 0.005,
  /** Don't chase more than this above the consolidation high. */
  maxExtensionPct: 0.03,
  /** Stop below the consolidation low by this much. */
  stopBufferPct: 0.005,
  /** Target = ref + this × impulse height (measured move, conservative). */
  targetImpulseFraction: 0.5,
  timeStopMs: 180_000,
  cooldownMs: 5 * 60_000,
};

export function strategyA(f: Features, _ctx: StrategyContext, p = A_PARAMS): Signal {
  const id = "A_continuation" as const;
  if (!f.quality.ok) return none(id, [`data: ${f.quality.reasons.join("; ")}`], p.cooldownMs);
  const { last, priorHigh, priorLow, baseHigh, baseLow } = f;
  if (last === null || priorHigh === null || priorLow === null || baseHigh === null || baseLow === null) return none(id, ["not enough history"], p.cooldownMs);
  const impulse = priorHigh / priorLow - 1;
  if (impulse < p.minImpulsePct) return none(id, [`no prior impulse (${pct(impulse)} < ${pct(p.minImpulsePct)})`], p.cooldownMs);
  const baseRange = baseHigh / baseLow - 1;
  if (baseRange > p.maxConsolidationRangePct) return none(id, [`not consolidating (base range ${pct(baseRange)})`], p.cooldownMs);
  const retrace = (priorHigh - baseLow) / (priorHigh - priorLow);
  if (retrace > p.maxRetraceOfImpulse) return none(id, [`gave back ${pct(retrace)} of the impulse`], p.cooldownMs);
  if (f.buyers60 < p.minBuyers60) return none(id, [`thin participation (${f.buyers60} buyers/60s)`], p.cooldownMs);
  if (f.topBuyerShare60 > p.maxTopBuyerShare) return none(id, [`one wallet is ${pct(f.topBuyerShare60)} of buying`], p.cooldownMs);
  if (f.repeatedSizeRatio60 > p.maxRepeatedSizeRatio) return none(id, [`${pct(f.repeatedSizeRatio60)} of trades repeat exact sizes`], p.cooldownMs);
  const brk = last / baseHigh - 1;
  if (brk < p.minBreakoutPct) return none(id, ["no breakout from the base yet"], p.cooldownMs);
  if (brk > p.maxExtensionPct) return none(id, [`too extended (${pct(brk)} above the base)`], p.cooldownMs);
  if (f.buyers10 < 2) return none(id, ["breakout is one wallet so far"], p.cooldownMs);
  if (f.imbalance60 < 0) return none(id, ["sellers outweigh buyers over 60s"], p.cooldownMs);
  const target = last + (priorHigh - priorLow) * p.targetImpulseFraction;
  return {
    strategy: id,
    action: "ENTER",
    reasons: [`impulse ${pct(impulse)}`, `base range ${pct(baseRange)}`, `breakout ${pct(brk)}`, `${f.buyers60} buyers/60s`, `${f.buyers10} buyers/10s`],
    refPrice: last,
    maxEntryPrice: baseHigh * (1 + p.maxExtensionPct),
    invalidationPrice: baseLow * (1 - p.stopBufferPct),
    targetPrice: target,
    expectedMovePct: target / last - 1,
    timeStopMs: p.timeStopMs,
    cooldownMs: p.cooldownMs,
  };
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
