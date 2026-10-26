/**
 * Exit engine (spec §10). Independent of the entry strategy, deterministic,
 * and ordered by the spec's priority:
 *   1 emergency/safety → 2 invalidation or liquidity deterioration → 3 risk limit
 *   → 4 strategy exit → 5 profit/trailing → 6 time stop → HOLD
 * The first matching rule wins; every rule that matched is still reported.
 *
 * Decisions use NET proceeds from a fresh sell quote where one exists. A stop
 * is a decision rule, not a guaranteed fill.
 */
import type { FailureSignal } from "./types.ts";

export interface OpenPosition {
  entryAt: number;
  entryPrice: number;
  /** SOL spent including fees. */
  costBasisSol: number;
  invalidationPrice: number;
  targetPrice: number;
  timeStopMs: number;
  /** Highest net proceeds seen since entry (SOL). */
  peakNetSol: number;
  partialTaken: boolean;
}

export interface ExitContext {
  now: number;
  lastPrice: number | null;
  /** Net SOL a sell of the whole position would return now (quote minus fees). Undefined if no fresh quote. */
  sellNetSol?: number;
  sellRouteAvailable: boolean;
  /** Fall in exit value since entry from liquidity alone, e.g. sell impact widening. */
  exitImpactPct?: number;
  /** Token behaves abnormally: failed sell, transfer restriction, frozen account. */
  tokenRestricted: boolean;
  /** A risk limit (daily loss, kill switch) requires flattening. */
  riskLimitBreached: boolean;
  failure: FailureSignal;
}

export interface ExitPolicy {
  maxExitImpactPct: number;
  /** Profit mode: "full" exits at target; "partial" sells half at target and trails the rest. */
  profitMode: "full" | "partial";
  /** Start trailing once net proceeds are this far above cost. */
  trailActivatePct: number;
  /** Exit when net proceeds fall this far from their peak. */
  trailGivebackPct: number;
}

export const DEFAULT_EXIT_POLICY: ExitPolicy = { maxExitImpactPct: 0.05, profitMode: "full", trailActivatePct: 0.04, trailGivebackPct: 0.03 };

export type ExitReason = "EMERGENCY" | "INVALIDATION" | "LIQUIDITY" | "RISK_LIMIT" | "STRATEGY" | "PROFIT_TARGET" | "PARTIAL_PROFIT" | "TRAILING" | "TIME_STOP";

export interface ExitDecision {
  action: "EXIT" | "EXIT_PARTIAL" | "HOLD" | "ALERT";
  reason?: ExitReason;
  /** Every rule that matched, in priority order. */
  matched: { reason: ExitReason; detail: string }[];
  /** Exit wanted but no verified route: don't fire blind transactions; alert the operator. */
  blocked?: string;
}

export function decideExit(p: OpenPosition, c: ExitContext, pol: ExitPolicy = DEFAULT_EXIT_POLICY): ExitDecision {
  const m: ExitDecision["matched"] = [];
  const add = (reason: ExitReason, detail: string) => m.push({ reason, detail });

  // 1. Emergency / safety.
  if (c.tokenRestricted) add("EMERGENCY", "token restriction or failed sell");
  // 2. Invalidation or material liquidity deterioration.
  if (c.lastPrice !== null && c.lastPrice < p.invalidationPrice) add("INVALIDATION", `price ${c.lastPrice} below ${p.invalidationPrice}`);
  if (c.exitImpactPct !== undefined && c.exitImpactPct > pol.maxExitImpactPct) add("LIQUIDITY", `exit impact ${(c.exitImpactPct * 100).toFixed(1)}%`);
  if (!c.sellRouteAvailable) add("LIQUIDITY", "sell route disappeared");
  // 3. Risk limits.
  if (c.riskLimitBreached) add("RISK_LIMIT", "risk limit requires flattening");
  // 4. Strategy exit.
  if (c.failure.action === "EXIT") add("STRATEGY", c.failure.reasons.join("; "));
  // 5. Profit taking and trailing, on net proceeds.
  if (c.sellNetSol !== undefined) {
    const net = c.sellNetSol / p.costBasisSol - 1;
    const peak = Math.max(p.peakNetSol, c.sellNetSol);
    if (c.lastPrice !== null && c.lastPrice >= p.targetPrice && net > 0) add(pol.profitMode === "partial" && !p.partialTaken ? "PARTIAL_PROFIT" : "PROFIT_TARGET", `target reached, net ${(net * 100).toFixed(1)}%`);
    if (peak / p.costBasisSol - 1 >= pol.trailActivatePct && c.sellNetSol < peak * (1 - pol.trailGivebackPct)) add("TRAILING", `gave back ${((1 - c.sellNetSol / peak) * 100).toFixed(1)}% from peak`);
  }
  // 6. Time stop.
  if (c.now - p.entryAt >= p.timeStopMs) add("TIME_STOP", `held ${Math.round((c.now - p.entryAt) / 1000)}s`);

  if (!m.length) return { action: "HOLD", matched: m };
  const first = m[0]!;
  // No verified route: never spam blind sells. Alert and keep trying fresh quotes.
  if (!c.sellRouteAvailable || c.sellNetSol === undefined) return { action: "ALERT", reason: first.reason, matched: m, blocked: "no verified sell route or fresh quote" };
  return { action: first.reason === "PARTIAL_PROFIT" ? "EXIT_PARTIAL" : "EXIT", reason: first.reason, matched: m };
}
