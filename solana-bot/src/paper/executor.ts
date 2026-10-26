/**
 * Paper executor. Never builds, signs or sends a transaction.
 *
 * A paper fill is: the quote at decision time, then a simulated delay, then a
 * FRESH quote. The fill is the fresh quote's output minus a stress haircut.
 * Failures are drawn at a configurable rate and still cost the network fee.
 * A sell with no route leaves the position STUCK, not silently closed.
 */
import type { Clock } from "../core/clock.ts";
import type { Quote, QuoteClient, QuoteError } from "../market/quotes.ts";
import { ATA_RENT_LAMPORTS, BASE_FEE_LAMPORTS } from "../risk/costs.ts";
import { MINTS } from "../solana/programs.ts";
import type { OrderFill } from "./ledger.ts";

export interface SimParams {
  /** Latency samples (ms) drawn uniformly; measured live in Phase 4: 4–11 s feed lag plus our own cycle. */
  latencyMs: [number, number];
  /** Extra adverse move applied to the fresh quote (fraction). */
  stressHaircut: number;
  /** Probability a submitted swap fails on-chain (fee still paid). */
  failureRate: number;
  /** Compute units assumed per swap for the priority fee. */
  computeUnits: number;
  random: () => number;
}

export const CONSERVATIVE_SIM: SimParams = { latencyMs: [4_000, 12_000], stressHaircut: 0.01, failureRate: 0.1, computeUnits: 200_000, random: Math.random };

export interface EntryResult {
  ok: boolean;
  fill: OrderFill;
  /** SOL per whole token actually paid, when filled. */
  entryPrice?: number;
}

export interface ExitResult {
  ok: boolean;
  fill: OrderFill;
  /** True when no sell route existed at all. */
  noRoute: boolean;
}

export class PaperExecutor {
  constructor(
    private readonly quotes: QuoteClient,
    private readonly clock: Clock,
    private readonly priorityMicroLamports: () => number,
    private readonly sim: SimParams = CONSERVATIVE_SIM,
  ) {}

  private fees(): { baseFee: bigint; priorityFee: bigint } {
    return { baseFee: BASE_FEE_LAMPORTS, priorityFee: BigInt(Math.ceil((this.priorityMicroLamports() * this.sim.computeUnits) / 1_000_000)) };
  }

  private latency(): number {
    const [a, b] = this.sim.latencyMs;
    return Math.round(a + (b - a) * this.sim.random());
  }

  async buy(mint: string, sizeLamports: bigint, decimalsOrProgram: { decimals: number; program: "token" | "token2022" }, slippageBps: number): Promise<EntryResult> {
    const first = await this.quotes.quote({ inputMint: MINTS.WSOL, outputMint: mint, amount: sizeLamports, slippageBps });
    const latency = this.latency();
    await this.clock.sleep(latency);
    const fees = this.fees();
    const rent = ATA_RENT_LAMPORTS[decimalsOrProgram.program];
    const base: OrderFill = { quoteIn: first.inAmount, quoteOut: first.outAmount, quoteImpactPct: first.priceImpact * 100, quoteRoute: first.routeLabels.join(">"), quoteAt: first.receivedAt, simLatencyMs: latency, ...fees, rent };
    let fresh: Quote;
    try {
      fresh = await this.quotes.quote({ inputMint: MINTS.WSOL, outputMint: mint, amount: sizeLamports, slippageBps });
    } catch (e) {
      return { ok: false, fill: { ...base, failure: `route gone before fill: ${(e as QuoteError).message}` } };
    }
    if (this.sim.random() < this.sim.failureRate) return { ok: false, fill: { ...base, requoteOut: fresh.outAmount, failure: "simulated on-chain failure" } };
    const out = (fresh.outAmount * BigInt(Math.round((1 - this.sim.stressHaircut) * 10_000))) / 10_000n;
    // The quote's minimum-out is the floor a real swap would enforce.
    if (out < first.minOut) return { ok: false, fill: { ...base, requoteOut: fresh.outAmount, failure: "slippage exceeded: fresh quote below minimum out" } };
    const slippageBpsReal = Number(((first.outAmount - out) * 10_000n) / first.outAmount);
    const entryPrice = Number(sizeLamports) / 1e9 / (Number(out) / 10 ** decimalsOrProgram.decimals);
    return { ok: true, entryPrice, fill: { ...base, requoteOut: fresh.outAmount, fillIn: sizeLamports, fillOut: out, slippageBps: slippageBpsReal } };
  }

  async sell(mint: string, tokens: bigint, slippageBps: number): Promise<ExitResult> {
    const fees = this.fees();
    let first: Quote;
    try {
      first = await this.quotes.quote({ inputMint: mint, outputMint: MINTS.WSOL, amount: tokens, slippageBps });
    } catch (e) {
      const msg = (e as QuoteError).message;
      return { ok: false, noRoute: msg === "NO_ROUTE", fill: { quoteIn: tokens, quoteOut: 0n, quoteImpactPct: 0, quoteRoute: "", quoteAt: this.clock.now(), simLatencyMs: 0, baseFee: 0n, priorityFee: 0n, rent: 0n, failure: `no sell quote: ${msg}` } };
    }
    const latency = this.latency();
    await this.clock.sleep(latency);
    const base: OrderFill = { quoteIn: tokens, quoteOut: first.outAmount, quoteImpactPct: first.priceImpact * 100, quoteRoute: first.routeLabels.join(">"), quoteAt: first.receivedAt, simLatencyMs: latency, ...fees, rent: 0n };
    let fresh: Quote;
    try {
      fresh = await this.quotes.quote({ inputMint: mint, outputMint: MINTS.WSOL, amount: tokens, slippageBps });
    } catch (e) {
      const msg = (e as QuoteError).message;
      return { ok: false, noRoute: msg === "NO_ROUTE", fill: { ...base, failure: `route gone before fill: ${msg}` } };
    }
    if (this.sim.random() < this.sim.failureRate) return { ok: false, noRoute: false, fill: { ...base, requoteOut: fresh.outAmount, failure: "simulated on-chain failure" } };
    const out = (fresh.outAmount * BigInt(Math.round((1 - this.sim.stressHaircut) * 10_000))) / 10_000n;
    if (out < first.minOut) return { ok: false, noRoute: false, fill: { ...base, requoteOut: fresh.outAmount, failure: "slippage exceeded: fresh quote below minimum out" } };
    return { ok: true, noRoute: false, fill: { ...base, requoteOut: fresh.outAmount, fillIn: tokens, fillOut: out, slippageBps: Number(((first.outAmount - out) * 10_000n) / first.outAmount) } };
  }
}
