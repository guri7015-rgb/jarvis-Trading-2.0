/**
 * Cross-check a Jupiter quote against pump.fun curve math.
 *
 * From fresh curve reserves we compute what the curve itself would charge
 * before fees, then back out the fee the quote implies. pump.fun documents
 * 1.25% per side on the curve; a large gap means the quote, the reserves, or
 * our understanding is off, and that is worth a flag.
 *
 * DERIVED: reserves and quote come from different moments, so small gaps are noise.
 */
import type { Quote } from "../market/quotes.ts";
import { MINTS } from "../solana/programs.ts";
import type { DecodedBondingCurve } from "../solana/pumpCurve.ts";

/** Only meaningful for a one-hop route straight through the pump.fun curve, quoted in SOL. */
export function isDirectCurveRoute(q: Quote): boolean {
  return q.hops === 1 && q.routeLabels[0] === "Pump.fun";
}

/** Buy: SOL in → tokens out. pump.fun adds the fee on top of the curve cost. */
export function impliedBuyFeeBps(curve: DecodedBondingCurve, q: Quote): number | undefined {
  if (!isDirectCurveRoute(q) || q.inputMint !== MINTS.WSOL || curve.quoteMint !== MINTS.WSOL) return undefined;
  const vq = curve.virtualQuoteReserves;
  const vt = curve.virtualTokenReserves;
  const t = q.outAmount;
  if (t <= 0n || t >= vt) return undefined;
  const cost = (vq * t) / (vt - t) + 1n;
  if (cost <= 0n) return undefined;
  return Math.round((Number(q.inAmount) / Number(cost) - 1) * 10_000);
}

/** Sell: tokens in → SOL out. pump.fun takes the fee out of the curve proceeds. */
export function impliedSellFeeBps(curve: DecodedBondingCurve, q: Quote): number | undefined {
  if (!isDirectCurveRoute(q) || q.outputMint !== MINTS.WSOL || curve.quoteMint !== MINTS.WSOL) return undefined;
  const vq = curve.virtualQuoteReserves;
  const vt = curve.virtualTokenReserves;
  const gross = (vq * q.inAmount) / (vt + q.inAmount);
  if (gross <= 0n) return undefined;
  return Math.round((1 - Number(q.outAmount) / Number(gross)) * 10_000);
}
