/**
 * Deterministic risk manager (spec §8 entry gates, §9 sizing, §16 limits).
 *
 * Runs the eleven gates in the spec's order and stops at the first failure.
 * Strategies cannot skip it, and no model output can override it. It only
 * decides entries: halts here never block a protective exit.
 */
import { LIVE_TRADING_ENABLED } from "../core/config.ts";
import type { FailureSignal, Signal } from "../strategy/types.ts";
import type { DataQuality } from "../strategy/features.ts";
import type { RiskLimits } from "./limits.ts";
import type { DayState } from "./riskState.ts";

export interface AssessmentView {
  at: number;
  verdict: "PASS" | "REJECT";
  /** Only data-kind rejects (e.g. holder data unavailable): watched for research, never tradable. */
  researchOnly: boolean;
  totalCostBps: number | null;
  breakEvenPct: number | null;
  sizeCad: number;
  solCad: number | null;
}

export interface RiskInput {
  now: number;
  signal: Signal;
  failure: FailureSignal;
  feedsHealthy: boolean;
  feedReasons: string[];
  quality: DataQuality;
  assessment: AssessmentView | undefined;
  /** Latest price (SOL/token) from the tape. */
  lastPrice: number | null;
  state: DayState;
  openPositions: number;
  pendingOrders: number;
  /** Planned loss of any open position, counted against today's limit. */
  openRiskCad: number;
  /** Unconfirmed loosening of a limit was refused at start-up. */
  limitsRefused: string[];
}

export interface GateStep {
  n: number;
  gate: string;
  ok: boolean;
  detail: string;
}

export interface RiskDecision {
  approved: boolean;
  /** Paper only until live trading is explicitly approved. */
  mode: "paper";
  sizeCad?: number;
  plannedLossCad?: number;
  rewardToRisk?: number;
  netEdgePct?: number;
  /** Size differs from the CAD size the costs were measured at: re-quote before acting. */
  requoteRequired?: boolean;
  steps: GateStep[];
  firstFailure?: string;
}

export function decideEntry(i: RiskInput, L: RiskLimits): RiskDecision {
  const steps: GateStep[] = [];
  const out = (approved: boolean, extra: Partial<RiskDecision> = {}): RiskDecision => ({
    approved,
    mode: "paper",
    steps,
    firstFailure: approved ? undefined : steps.find((s) => !s.ok)?.gate,
    ...extra,
  });
  const step = (n: number, gate: string, ok: boolean, detail: string) => {
    steps.push({ n, gate, ok, detail });
    return ok;
  };
  const s = i.signal;
  const a = i.assessment;

  // 1. Data source health and freshness.
  if (!step(1, "DATA_HEALTH", i.feedsHealthy && i.quality.ok, i.feedsHealthy ? (i.quality.ok ? "ok" : i.quality.reasons.join("; ")) : i.feedReasons.join("; "))) return out(false);
  // 2. Token tradability and safety gate.
  const fresh = !!a && i.now - a.at <= L.maxAssessmentAgeMs;
  const gate2 = !a ? "no assessment" : !fresh ? `assessment ${Math.round((i.now - a.at) / 1000)}s old` : a.researchOnly ? "research only: gate rejected for missing data" : a.verdict;
  if (!step(2, "TOKEN_GATE", fresh && a!.verdict === "PASS", gate2)) return out(false);
  // 3. Liquidity and exitability (sell route, impact, thin reserves) are part of the gate verdict; costs must exist.
  if (!step(3, "EXIT_LIQUIDITY", a!.totalCostBps !== null && a!.breakEvenPct !== null, a!.totalCostBps === null ? "no round-trip cost measured" : "sell route and costs measured")) return out(false);
  // 4. Market regime: a failure signal on this token vetoes entries.
  if (!step(4, "REGIME", i.failure.action === "NONE", i.failure.reasons.join("; ") || "no failure signal")) return out(false);
  // 5. Strategy setup.
  if (!step(5, "SETUP", s.action === "ENTER", s.reasons.join("; "))) return out(false);
  // 6. Signal confirmation: a complete, internally consistent plan.
  const plan = s.refPrice !== undefined && s.invalidationPrice !== undefined && s.targetPrice !== undefined && s.maxEntryPrice !== undefined && s.expectedMovePct !== undefined;
  const consistent = plan && s.invalidationPrice! < s.refPrice! && s.targetPrice! > s.refPrice! && s.maxEntryPrice! >= s.refPrice!;
  if (!step(6, "CONFIRMATION", consistent, consistent ? "plan complete" : "signal plan incomplete or inconsistent")) return out(false);
  // 7. Entry price check.
  const priceOk = i.lastPrice !== null && i.lastPrice <= s.maxEntryPrice!;
  if (!step(7, "ENTRY_PRICE", priceOk, priceOk ? "within max entry" : `last ${i.lastPrice} above max entry ${s.maxEntryPrice}`)) return out(false);
  // 8. Full round-trip cost vs expected move.
  const costPct = a!.totalCostBps! / 10_000;
  const breakEven = a!.breakEvenPct! / 100;
  const stopDist = 1 - s.invalidationPrice! / s.refPrice!;
  const netReward = s.expectedMovePct! - costPct;
  const netRisk = stopDist + costPct + L.stressPct;
  const rr = netReward / netRisk;
  const edge = s.expectedMovePct! - breakEven;
  const costOk = edge >= L.minEdgeOverBreakEvenPct && rr >= L.minRewardToRisk;
  if (!step(8, "COSTS", costOk, `expected ${(s.expectedMovePct! * 100).toFixed(1)}% vs break-even ${(breakEven * 100).toFixed(1)}%, net R:R ${rr.toFixed(2)}`)) return out(false, { rewardToRisk: rr, netEdgePct: edge });
  // 9. Position sizing from the loss budget.
  const lossPerCad = netRisk;
  const size = Math.min(L.maxPositionCad, L.maxLossPerTradeCad / lossPerCad);
  const plannedLoss = size * lossPerCad;
  if (!step(9, "SIZING", size >= L.minPositionCad, size >= L.minPositionCad ? `CAD ${size.toFixed(2)}, planned loss CAD ${plannedLoss.toFixed(2)}` : `stop too wide: size CAD ${size.toFixed(2)} below minimum ${L.minPositionCad}`))
    return out(false, { rewardToRisk: rr, netEdgePct: edge });
  // 10. Portfolio, daily loss and cool-down.
  const st = i.state;
  const lossRoom = L.dailyLossLimitCad - st.realizedLossCad - i.openRiskCad;
  const why = st.haltedReason
    ? `halted: ${st.haltedReason}`
    : i.limitsRefused.length
      ? `unconfirmed limit increase: ${i.limitsRefused.join(",")}`
      : i.openPositions >= L.maxOpenPositions
        ? "a position is already open"
        : i.pendingOrders > 0
          ? "an order is still unresolved"
          : st.entries >= L.maxEntriesPerDay
            ? `${st.entries} entries today`
            : st.consecutiveLosses >= L.maxConsecutiveLosses
              ? `${st.consecutiveLosses} losses in a row: cool-down`
              : plannedLoss > lossRoom
                ? `planned loss CAD ${plannedLoss.toFixed(2)} exceeds CAD ${lossRoom.toFixed(2)} left today`
                : "";
  if (!step(10, "PORTFOLIO", why === "", why || `CAD ${lossRoom.toFixed(2)} of daily loss budget left`)) return out(false, { sizeCad: size, plannedLossCad: plannedLoss, rewardToRisk: rr, netEdgePct: edge });
  // 11. Execution readiness: paper only.
  step(11, "EXECUTION", true, LIVE_TRADING_ENABLED ? "live" : "paper only (live trading disabled)");
  return out(true, {
    sizeCad: Math.round(size * 100) / 100,
    plannedLossCad: Math.round(plannedLoss * 100) / 100,
    rewardToRisk: rr,
    netEdgePct: edge,
    requoteRequired: Math.abs(size - a!.sizeCad) / a!.sizeCad > 0.25,
  });
}
