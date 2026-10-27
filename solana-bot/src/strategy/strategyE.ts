/**
 * Strategy E: dip hunt. The coin already ran, pulled back part of the run,
 * selling dried up, and buyers are coming back. The entry you get when you
 * missed the first move. Placeholders throughout; tuned on tape like A to D.
 *
 * "Buyers coming back" is measured on chain: distinct wallets buying in the
 * last 10 and 30 seconds, and buy volume outweighing sell volume. It is not a
 * social signal; no chatter feed is connected.
 */
import type { Features } from "./features.ts";
import { none, type Signal, type StrategyContext } from "./types.ts";
import { pct } from "./strategyA.ts";

export const E_PARAMS = {
  /** The run: high over the last 5 minutes against the low before it. */
  minRunPct: 0.15,
  /** Pullback as a share of the run, measured from the 5-minute high to the 60 s low. */
  minPullbackOfRun: 0.2,
  maxPullbackOfRun: 0.6,
  /** Price has bounced at least this much off the 60 s low. */
  minReclaimPct: 0.02,
  /** ...but not run away from it. */
  maxReclaimPct: 0.1,
  minBuyers10: 3,
  minNewBuyers30: 4,
  /** Buy volume must outweigh sell volume over 60 s at least this much (−1..1). */
  minImbalance60: 0.1,
  maxTopBuyerShare: 0.35,
  maxRepeatedSizeRatio: 0.6,
  /** Stop below the 60 s low by this much. */
  stopBufferPct: 0.01,
  /** Target: this share of the way back to the 5-minute high. */
  targetFractionToHigh: 0.6,
  timeStopMs: 240_000,
  cooldownMs: 5 * 60_000,
};

export function strategyE(f: Features, _ctx: StrategyContext, p = E_PARAMS): Signal {
  const id = "E_dip_hunt" as const;
  if (!f.quality.ok) return none(id, [`data: ${f.quality.reasons.join("; ")}`], p.cooldownMs);
  const { last, high300, low300, low60 } = f;
  if (last === null || high300 === null || low300 === null || low60 === null) return none(id, ["not enough history"], p.cooldownMs);
  const run = high300 / low300 - 1;
  if (run < p.minRunPct) return none(id, [`no run to pull back from (${pct(run)} < ${pct(p.minRunPct)})`], p.cooldownMs);
  const pullback = (high300 - low60) / (high300 - low300);
  if (pullback < p.minPullbackOfRun) return none(id, [`no real dip yet (${pct(pullback)} of the run)`], p.cooldownMs);
  if (pullback > p.maxPullbackOfRun) return none(id, [`gave back too much (${pct(pullback)} of the run)`], p.cooldownMs);
  const reclaim = last / low60 - 1;
  if (reclaim < p.minReclaimPct) return none(id, [`still falling (${pct(reclaim)} off the low)`], p.cooldownMs);
  if (reclaim > p.maxReclaimPct) return none(id, [`bounce already ran (${pct(reclaim)} off the low)`], p.cooldownMs);
  if (f.buyers10 < p.minBuyers10) return none(id, [`only ${f.buyers10} buyers/10s`], p.cooldownMs);
  if (f.newBuyers30 < p.minNewBuyers30) return none(id, [`only ${f.newBuyers30} new buyers/30s`], p.cooldownMs);
  if (f.imbalance60 < p.minImbalance60) return none(id, [`sellers still in charge (imbalance ${f.imbalance60.toFixed(2)})`], p.cooldownMs);
  if (f.topBuyerShare60 > p.maxTopBuyerShare) return none(id, [`one wallet is ${pct(f.topBuyerShare60)} of buying`], p.cooldownMs);
  if (f.repeatedSizeRatio60 > p.maxRepeatedSizeRatio) return none(id, [`${pct(f.repeatedSizeRatio60)} of trades repeat exact sizes`], p.cooldownMs);
  const target = last + (high300 - last) * p.targetFractionToHigh;
  return {
    strategy: id,
    action: "ENTER",
    reasons: [`ran ${pct(run)}`, `pulled back ${pct(pullback)} of the run`, `bounced ${pct(reclaim)} off the low`, `${f.buyers10} buyers/10s`, `${f.newBuyers30} new buyers/30s`],
    refPrice: last,
    maxEntryPrice: low60 * (1 + p.maxReclaimPct),
    invalidationPrice: low60 * (1 - p.stopBufferPct),
    targetPrice: target,
    expectedMovePct: target / last - 1,
    timeStopMs: p.timeStopMs,
    cooldownMs: p.cooldownMs,
  };
}
