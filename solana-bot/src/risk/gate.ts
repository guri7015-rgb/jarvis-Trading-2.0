/**
 * Tradability gate. Pure and deterministic: same inputs, same verdict.
 *
 * Every rule that fails is recorded with what we saw, the limit, and the
 * evidence behind it. A missing input is a failure, never a pass. Passing
 * this gate means "no automated check objected". It does NOT mean safe.
 */
import type { Evidence } from "../core/types.ts";
import type { Quote } from "../market/quotes.ts";
import type { DecodedMint } from "../solana/mint.ts";
import type { DecodedBondingCurve } from "../solana/pumpCurve.ts";
import type { CostBreakdown } from "./costs.ts";
import type { HolderReport } from "./holders.ts";
import type { RiskPolicy } from "./policy.ts";

export type RuleKind = "structural" | "market" | "data";

export interface Finding {
  rule: string;
  kind: RuleKind;
  observed: string;
  limit: string;
  evidence: Evidence;
}

export interface GateInput {
  now: number;
  confirmStatus: string;
  /** Fresh read at assessment time. */
  mint: DecodedMint | Error;
  /** Fresh read, pump.fun tokens only. */
  curve?: DecodedBondingCurve | null;
  holders: HolderReport | Error;
  buy: Quote | Error;
  sell: Quote | Error | undefined;
  costs?: CostBreakdown;
  impliedBuyFeeBps?: number;
  impliedSellFeeBps?: number;
  fxError?: string;
}

export interface GateResult {
  verdict: "PASS" | "REJECT";
  rejects: Finding[];
  flags: Finding[];
}

const msg = (e: Error) => e.message.slice(0, 120);

export function evaluateGate(i: GateInput, p: RiskPolicy): GateResult {
  const rejects: Finding[] = [];
  const flags: Finding[] = [];
  const reject = (rule: string, kind: RuleKind, observed: string, limit: string, evidence: Evidence) => rejects.push({ rule, kind, observed, limit, evidence });
  const flag = (rule: string, kind: RuleKind, observed: string, limit: string, evidence: Evidence) => flags.push({ rule, kind, observed, limit, evidence });

  if (i.fxError) reject("FX_UNAVAILABLE", "data", i.fxError, "fresh SOL/CAD rate", "DERIVED");
  if (i.confirmStatus !== "CONFIRMED") reject("NOT_CONFIRMED", "data", i.confirmStatus, "CONFIRMED", "ONCHAIN_CONFIRMED");

  // Token controls (fresh on-chain read).
  if (i.mint instanceof Error) reject("MINT_READ", "data", msg(i.mint), "fresh mint account", "ONCHAIN_CONFIRMED");
  else {
    if (i.mint.mintAuthority) reject("MINT_AUTHORITY", "structural", i.mint.mintAuthority, "none", "ONCHAIN_CONFIRMED");
    if (i.mint.freezeAuthority) reject("FREEZE_AUTHORITY", "structural", i.mint.freezeAuthority, "none", "ONCHAIN_CONFIRMED");
    const bad = i.mint.extensions.filter((x) => !p.allowedExtensions.includes(x));
    if (bad.length) reject("TOKEN_EXTENSION", "structural", bad.join(","), `only ${p.allowedExtensions.join(",")}`, "ONCHAIN_CONFIRMED");
  }

  // Exit route (quotes are PROVIDER_REPORTED; the cost maths on them is DERIVED).
  if (i.buy instanceof Error) reject(i.buy.message === "NO_ROUTE" ? "NO_BUY_ROUTE" : "BUY_QUOTE", "market", msg(i.buy), "executable buy quote", "PROVIDER_REPORTED");
  if (i.sell === undefined) {
    if (!(i.buy instanceof Error)) reject("SELL_QUOTE", "data", "not requested", "executable sell quote", "PROVIDER_REPORTED");
  } else if (i.sell instanceof Error) reject(i.sell.message === "NO_ROUTE" ? "NO_SELL_ROUTE" : "SELL_QUOTE", "market", msg(i.sell), "executable sell quote", "PROVIDER_REPORTED");

  for (const [side, q] of [["BUY", i.buy], ["SELL", i.sell]] as const) {
    if (!q || q instanceof Error) continue;
    const age = i.now - q.receivedAt;
    if (age > p.maxQuoteAgeMs) reject(`${side}_QUOTE_STALE`, "data", `${age}ms`, `<= ${p.maxQuoteAgeMs}ms`, "DERIVED");
    const badLabels = q.routeLabels.filter((l) => !p.allowedRouteLabels.includes(l));
    if (badLabels.length) reject(`${side}_ROUTE_VENUE`, "market", badLabels.join(","), "known launch/AMM venues", "PROVIDER_REPORTED");
    if (q.hops > p.maxRouteHops) reject(`${side}_ROUTE_HOPS`, "market", String(q.hops), `<= ${p.maxRouteHops}`, "PROVIDER_REPORTED");
    const impactPct = q.priceImpact * 100;
    const max = side === "BUY" ? p.maxBuyImpactPct : p.maxSellImpactPct;
    if (impactPct > max) reject(`${side}_IMPACT`, "market", `${impactPct.toFixed(2)}%`, `<= ${max}%`, "PROVIDER_REPORTED");
  }
  if (!(i.buy instanceof Error) && i.sell && !(i.sell instanceof Error)) {
    const gap = Math.abs(i.sell.receivedAt - i.buy.receivedAt);
    if (gap > p.maxQuoteGapMs) reject("QUOTE_GAP", "data", `${gap}ms`, `<= ${p.maxQuoteGapMs}ms`, "DERIVED");
    if (i.sell.hops === 1 && i.sell.ammKeys.length === 1) flag("SINGLE_POOL_EXIT", "market", i.sell.routeLabels[0] ?? "?", "exit depends on one pool", "PROVIDER_REPORTED");
  }
  if (i.costs) {
    if (i.costs.totalCostBps > p.maxRoundTripCostBps)
      reject("ROUND_TRIP_COST", "market", `${(i.costs.totalCostBps / 100).toFixed(2)}%`, `<= ${(p.maxRoundTripCostBps / 100).toFixed(2)}%`, "DERIVED");
  } else if (!(i.buy instanceof Error) && i.sell && !(i.sell instanceof Error)) {
    reject("COSTS", "data", "not computed", "cost breakdown", "DERIVED");
  }

  // pump.fun curve state.
  if (i.curve) {
    const onCurve = !(i.buy instanceof Error) && i.buy.routeLabels.includes("Pump.fun");
    if (i.curve.complete && onCurve) reject("CURVE_COMPLETE", "market", "curve complete", "trading curve", "ONCHAIN_CONFIRMED");
  }
  for (const [side, bps] of [["BUY", i.impliedBuyFeeBps], ["SELL", i.impliedSellFeeBps]] as const) {
    if (bps !== undefined && Math.abs(bps - p.documentedCurveFeeBps) > 50)
      flag(`${side}_FEE_DIFFERS`, "market", `${bps}bps implied`, `~${p.documentedCurveFeeBps}bps documented`, "DERIVED");
  }

  // Holders (direct on-chain evidence; no clustering).
  if (i.holders instanceof Error) reject("HOLDER_READ", "data", msg(i.holders), "holder snapshot", "ONCHAIN_CONFIRMED");
  else {
    const h = i.holders;
    if (h.top10WalletPct > p.maxTop10WalletPct) reject("TOP10_CONCENTRATION", "market", `${h.top10WalletPct}%`, `<= ${p.maxTop10WalletPct}%`, "ONCHAIN_CONFIRMED");
    if (h.largestWalletPct > p.maxLargestWalletPct) reject("LARGEST_WALLET", "market", `${h.largestWalletPct}%`, `<= ${p.maxLargestWalletPct}%`, "ONCHAIN_CONFIRMED");
    if (h.creatorPct > p.maxCreatorPct) reject("CREATOR_HOLDING", "market", `${h.creatorPct}%`, `<= ${p.maxCreatorPct}%`, "ONCHAIN_CONFIRMED");
  }

  return { verdict: rejects.length ? "REJECT" : "PASS", rejects, flags };
}

/** How long before a rejected token is looked at again: the longest wait any failed rule asks for. */
export function recheckDelayMs(r: GateResult, p: RiskPolicy): number {
  if (r.verdict === "PASS") return p.recheckAfterMarketRejectMs;
  if (r.rejects.some((f) => f.kind === "structural")) return p.recheckAfterStructuralRejectMs;
  if (r.rejects.some((f) => f.kind === "market")) return p.recheckAfterMarketRejectMs;
  return p.recheckAfterDataRejectMs;
}
