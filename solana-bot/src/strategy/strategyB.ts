/**
 * Strategy B: breakout and retest, in two variants measured separately.
 *   B_breakout_retest:    after breaking the range high, price came back to it, held, and is turning up.
 *   B_breakout_no_retest: enter on the breakout itself when it is strongly supported.
 * Spec: docs/STRATEGIES.md#b. Parameters are placeholders.
 */
import type { Features } from "./features.ts";
import { pct } from "./strategyA.ts";
import { none, type Signal, type StrategyContext } from "./types.ts";

export const B_PARAMS = {
  /** The range (−300 s to −60 s) must be no wider than this to count as a defined level. */
  maxRangePct: 0.25,
  minRangeTrades: 15,
  /** Breakout: the 60 s high cleared the range high by at least this. */
  minBreakoutPct: 0.02,
  /** Retest: the 30 s low came back within this of the range high... */
  retestBandPct: 0.02,
  /** ...without closing more than this below it. */
  maxRetestUndercutPct: 0.01,
  /** No-retest variant only: trading must be accelerating. */
  minRateAccel: 2,
  minBuyers60: 8,
  maxTopBuyerShare: 0.3,
  maxExtensionPct: 0.05,
  /** Stop: back inside the range by this much means the breakout failed. */
  stopBelowLevelPct: 0.02,
  /** Target: level + this × range height. */
  targetRangeFraction: 0.5,
  timeStopMs: 240_000,
  cooldownMs: 5 * 60_000,
};

export function strategyB(f: Features, _ctx: StrategyContext, variant: "retest" | "no_retest", p = B_PARAMS): Signal {
  const id = variant === "retest" ? ("B_breakout_retest" as const) : ("B_breakout_no_retest" as const);
  if (!f.quality.ok) return none(id, [`data: ${f.quality.reasons.join("; ")}`], p.cooldownMs);
  const { last, priorHigh: H, priorLow: L, high60, low30 } = f;
  if (last === null || H === null || L === null || high60 === null || low30 === null) return none(id, ["not enough history"], p.cooldownMs);
  const range = H / L - 1;
  if (range > p.maxRangePct) return none(id, [`no defined range (${pct(range)} wide)`], p.cooldownMs);
  if (high60 / H - 1 < p.minBreakoutPct) return none(id, ["no breakout above the range high"], p.cooldownMs);
  if (f.buyers60 < p.minBuyers60) return none(id, [`thin participation (${f.buyers60} buyers/60s)`], p.cooldownMs);
  if (f.topBuyerShare60 > p.maxTopBuyerShare) return none(id, [`one wallet is ${pct(f.topBuyerShare60)} of buying`], p.cooldownMs);
  const ext = last / H - 1;
  if (ext > p.maxExtensionPct) return none(id, [`too extended (${pct(ext)} above the level)`], p.cooldownMs);
  if (variant === "retest") {
    if (low30 > H * (1 + p.retestBandPct)) return none(id, ["no retest of the level yet"], p.cooldownMs);
    if (low30 < H * (1 - p.maxRetestUndercutPct)) return none(id, ["retest lost the level"], p.cooldownMs);
    if (last <= low30) return none(id, ["not turning up from the retest"], p.cooldownMs);
    if (f.buyers10 < 2) return none(id, ["bounce is one wallet so far"], p.cooldownMs);
  } else {
    if (f.rateAccel < p.minRateAccel) return none(id, [`trading not accelerating (${f.rateAccel.toFixed(1)}x)`], p.cooldownMs);
    if (last < H * (1 + p.minBreakoutPct)) return none(id, ["price is not above the level now"], p.cooldownMs);
    if (f.imbalance60 < 0.1) return none(id, ["buying not dominant"], p.cooldownMs);
  }
  if (last < H) return none(id, ["price is below the level"], p.cooldownMs);
  const target = H + (H - L) * p.targetRangeFraction;
  if (target <= last) return none(id, ["no room left to the target"], p.cooldownMs);
  return {
    strategy: id,
    action: "ENTER",
    reasons: [`range ${pct(range)}`, `breakout high ${pct(high60 / H - 1)}`, variant === "retest" ? `retest low ${pct(low30 / H - 1)} vs level` : `rate ${f.rateAccel.toFixed(1)}x`, `${f.buyers60} buyers/60s`],
    refPrice: last,
    maxEntryPrice: H * (1 + p.maxExtensionPct),
    invalidationPrice: H * (1 - p.stopBelowLevelPct),
    targetPrice: target,
    expectedMovePct: target / last - 1,
    timeStopMs: p.timeStopMs,
    cooldownMs: p.cooldownMs,
  };
}
