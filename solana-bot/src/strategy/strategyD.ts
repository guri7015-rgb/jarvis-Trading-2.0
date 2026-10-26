/**
 * Strategy D: momentum failure. Never opens a position (spot only, no shorting).
 *   VETO: blocks a new entry on this token.
 *   EXIT: tells the exit engine an open position's reason to exist has failed.
 * Spec: docs/STRATEGIES.md#d. Placeholders.
 */
import type { Features } from "./features.ts";
import { pct } from "./strategyA.ts";
import type { FailureSignal } from "./types.ts";

export const D_PARAMS = {
  /** Sharp drop over 30 s. */
  maxRet30Drop: -0.06,
  /** Heavy, broad selling. */
  sellImbalance: -0.4,
  minSellers60: 5,
  /** Back below the breakout level by this much = failed breakout. */
  failedBreakoutPct: 0.01,
  /** Real SOL on the curve fell below this share of what it was at entry. */
  minRealSolKeptRatio: 0.7,
};

export interface PositionContext {
  breakoutLevel?: number;
  invalidationPrice?: number;
  realQuoteSolAtEntry?: number;
}

export function strategyD(f: Features, pos: PositionContext = {}, p = D_PARAMS): FailureSignal {
  const exit: string[] = [];
  const veto: string[] = [];
  if (f.last !== null && pos.invalidationPrice !== undefined && f.last < pos.invalidationPrice) exit.push("price below invalidation");
  if (f.last !== null && pos.breakoutLevel !== undefined && f.last < pos.breakoutLevel * (1 - p.failedBreakoutPct)) exit.push("breakout failed: back below the level");
  if (f.ret30 !== null && f.ret30 <= p.maxRet30Drop) (pos.invalidationPrice !== undefined ? exit : veto).push(`dropped ${pct(f.ret30)} in 30s`);
  if (f.imbalance60 <= p.sellImbalance && f.sellers60 >= p.minSellers60) (pos.invalidationPrice !== undefined ? exit : veto).push(`broad selling (imbalance ${f.imbalance60.toFixed(2)}, ${f.sellers60} sellers)`);
  if (pos.realQuoteSolAtEntry && f.realQuoteSol !== null && f.realQuoteSol < pos.realQuoteSolAtEntry * p.minRealSolKeptRatio) exit.push("real SOL in the curve is draining");
  // Bad data blocks entries but never forces a sale: the exit engine fetches fresh state first.
  if (!f.quality.ok) veto.push(`data: ${f.quality.reasons[0]}`);
  if (exit.length) return { action: "EXIT", reasons: exit };
  if (veto.length) return { action: "VETO", reasons: veto };
  return { action: "NONE", reasons: [] };
}
