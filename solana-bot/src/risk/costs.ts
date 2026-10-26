/**
 * Round-trip cost from executable quotes, plus network fees and rent.
 *
 * The quote round trip (buy now, sell the same tokens now) already contains
 * the venue fees and the price impact both ways, so they are not added again.
 * Rent for the token account is shown separately: it comes back only if the
 * account is closed after selling.
 */
import type { Quote } from "../market/quotes.ts";

export const BASE_FEE_LAMPORTS = 5_000n; // per signature (solana.com/docs/core/fees)
/** Rent-exempt minimum for a token account (solana.com/docs/tokens/basics/create-token-account). */
export const ATA_RENT_LAMPORTS = { token: 2_039_280n, token2022: 2_074_080n } as const;

export interface CostInput {
  sizeLamports: bigint;
  buy: Quote;
  /** Quote to sell exactly `buy.outAmount` tokens. */
  sell: Quote;
  priorityMicroLamportsPerCu: number;
  computeUnits: number;
  mintProgram: "token" | "token2022";
}

export interface CostBreakdown {
  sizeLamports: bigint;
  sellBackLamports: bigint;
  /** Venue fees + price impact, both ways, from the quotes. */
  quoteRoundTripLossLamports: bigint;
  /** Two transactions: base fee + priority fee each. Estimate. */
  networkFeesLamports: bigint;
  /** Locked while holding; refunded only if the token account is closed. */
  rentLamports: bigint;
  totalCostLamports: bigint;
  totalCostBps: number;
  /** Price rise needed (on the sell side) just to get the stake back after fees. */
  breakEvenMovePct: number;
}

export function computeCosts(i: CostInput): CostBreakdown {
  if (i.sell.inAmount !== i.buy.outAmount) throw new Error("sell quote must be for the tokens the buy returns");
  const priorityPerTx = BigInt(Math.ceil((i.priorityMicroLamportsPerCu * i.computeUnits) / 1_000_000));
  const networkFees = 2n * (BASE_FEE_LAMPORTS + priorityPerTx);
  const sellBack = i.sell.outAmount;
  const loss = i.sizeLamports - sellBack;
  const total = loss + networkFees;
  const totalCostBps = Number((total * 10_000n) / i.sizeLamports);
  // Need sellBack * m - networkFees >= size  →  m = (size + networkFees) / sellBack
  const m = Number(i.sizeLamports + networkFees) / Number(sellBack);
  return {
    sizeLamports: i.sizeLamports,
    sellBackLamports: sellBack,
    quoteRoundTripLossLamports: loss,
    networkFeesLamports: networkFees,
    rentLamports: ATA_RENT_LAMPORTS[i.mintProgram],
    totalCostLamports: total,
    totalCostBps,
    breakEvenMovePct: Math.round((m - 1) * 10_000) / 100,
  };
}

/** Median of the non-zero fees, capped. Zero if the node saw none. A rough market estimate. */
export function priorityEstimate(fees: number[], cap: number): number {
  const nz = fees.filter((f) => f > 0).sort((a, b) => a - b);
  if (nz.length === 0) return 0;
  return Math.min(cap, nz[Math.floor(nz.length / 2)]!);
}
