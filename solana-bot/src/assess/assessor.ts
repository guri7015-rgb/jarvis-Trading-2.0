/**
 * Phase 3 assessor: for one candidate token, gather fresh evidence and run
 * the tradability gate. Read-only: it asks for quotes, never for transactions.
 *
 * Steps (each failure is recorded, and a missing input fails the gate):
 *   1. SOL/CAD rate → evaluation size in lamports
 *   2. fresh mint (+ pump.fun curve) accounts
 *   3. holder concentration (3 RPC calls)
 *   4. priority-fee estimate (cached)
 *   5. buy quote for the size, then a sell quote for exactly what the buy returns
 *   6. round-trip cost, implied curve fee, gate verdict
 */
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { TokenRegistry } from "../discovery/registry.ts";
import { cadToLamports, type FxQuote, type FxService } from "../market/fx.ts";
import type { Quote, QuoteClient } from "../market/quotes.ts";
import { computeCosts, priorityEstimate, type CostBreakdown } from "../risk/costs.ts";
import { impliedBuyFeeBps, impliedSellFeeBps } from "../risk/curveCheck.ts";
import { evaluateGate, recheckDelayMs, type GateResult } from "../risk/gate.ts";
import { analyzeHolders, type HolderReport } from "../risk/holders.ts";
import type { RiskPolicy } from "../risk/policy.ts";
import { derivePumpBondingCurve } from "../solana/address.ts";
import { decodeMint, type DecodedMint } from "../solana/mint.ts";
import { MINTS, PROGRAMS } from "../solana/programs.ts";
import { decodeBondingCurve, type DecodedBondingCurve } from "../solana/pumpCurve.ts";
import type { CallBudget, SolanaRpc } from "../solana/rpc.ts";

export interface Candidate {
  mint: string;
  source: string;
  liquidityUsd?: number;
  addedAt: number;
}

export interface AssessmentRecord {
  mint: string;
  at: number;
  gate: GateResult;
  costs?: CostBreakdown;
  buy?: Quote;
  sell?: Quote;
  holders?: HolderReport;
  fx?: FxQuote;
}

export interface AssessorDeps {
  db: DatabaseSync;
  registry: TokenRegistry;
  rpc: SolanaRpc;
  budget: CallBudget;
  quotes: QuoteClient;
  fx: FxService;
  clock: Clock;
  logger: Logger;
  policy: RiskPolicy;
}

const PRIORITY_CACHE_MS = 30_000;
/** After a rate limit on holder data, stop asking for this long (the public RPC refuses it outright). */
const HOLDER_BREAKER_MS = 30 * 60_000;
/** Venues where new meme coins launch. Tokens without one (e.g. majors in trending lists) are out of scope. */
const LAUNCH_VENUES = new Set(["pump_curve", "raydium_launchlab", "meteora_dbc"]);
const MAX_CANDIDATES = 200;

const BANDS = 4;
/** 0: <$10k, 1: $10k–50k, 2: $50k–250k, 3: >$250k (provider-reported liquidity). */
export function liquidityBand(usd: number | undefined): number {
  if (usd === undefined || usd < 10_000) return 0;
  if (usd < 50_000) return 1;
  if (usd < 250_000) return 2;
  return 3;
}

const asError = (e: unknown) => (e instanceof Error ? e : new Error(String(e)));

export class Assessor {
  private candidates = new Map<string, Candidate>();
  private priority = new Map<string, { value: number; at: number }>();
  private holderBreakerUntil = 0;
  private bandTurn = 0;
  public stats = { assessed: 0, passed: 0, rejected: 0, skippedBudget: 0, skippedNotReady: 0 };

  constructor(private readonly d: AssessorDeps) {}

  /** Add candidates (latest liquidity wins). Below-threshold candidates are dropped to save budget. */
  addCandidates(list: Omit<Candidate, "addedAt">[]): void {
    const now = this.d.clock.now();
    for (const c of list) {
      if (c.liquidityUsd !== undefined && c.liquidityUsd < this.d.policy.minCandidateLiquidityUsd) continue;
      this.candidates.set(c.mint, { ...c, addedAt: now });
    }
    // Keep the newest entries only.
    while (this.candidates.size > MAX_CANDIDATES) this.candidates.delete(this.candidates.keys().next().value!);
  }

  get candidateCount(): number {
    return this.candidates.size;
  }

  /**
   * Next candidate that is confirmed on-chain and out of its recheck cool-down.
   * Rotates through liquidity bands so small new tokens get sampled, not only
   * the deepest pools (which would make costs look better than they are).
   */
  private pick(): Candidate | undefined {
    const now = this.d.clock.now();
    const band = (c: Candidate) => liquidityBand(c.liquidityUsd);
    const start = this.bandTurn++ % BANDS;
    const ordered = [...this.candidates.values()].sort((a, b) => {
      const ra = (band(a) - start + BANDS) % BANDS;
      const rb = (band(b) - start + BANDS) % BANDS;
      return ra - rb || b.addedAt - a.addedAt;
    });
    for (const c of ordered) {
      const t = this.d.registry.get(c.mint);
      if (!t || t.confirm_status === "PENDING") continue; // not ready yet
      if (t.confirm_status !== "CONFIRMED" || !t.launch_venue || !LAUNCH_VENUES.has(t.launch_venue)) {
        this.candidates.delete(c.mint); // conflict, not a mint, or not a launchpad token: never assess
        continue;
      }
      const last = this.d.db.prepare("SELECT recheck_after FROM assessments WHERE mint = ? ORDER BY at DESC LIMIT 1").get(c.mint) as
        | { recheck_after: number }
        | undefined;
      if (last && last.recheck_after > now) continue;
      return c;
    }
    return undefined;
  }

  /** Assess the next ready candidate, if any. */
  async tick(): Promise<AssessmentRecord | undefined> {
    if (this.d.budget.remaining < this.d.policy.minRpcBudgetToAssess) {
      this.stats.skippedBudget++;
      return undefined;
    }
    const c = this.pick();
    if (!c) {
      this.stats.skippedNotReady++;
      return undefined;
    }
    this.candidates.delete(c.mint);
    return this.assess(c);
  }

  /** Priority-fee estimate for transactions touching the pool(s) the quote routes through. */
  private async priorityFee(pools: string[]): Promise<number> {
    const now = this.d.clock.now();
    const key = pools.join(",");
    const hit = this.priority.get(key);
    if (hit && now - hit.at < PRIORITY_CACHE_MS) return hit.value;
    try {
      const v = priorityEstimate(await this.d.rpc.getRecentPrioritizationFees(pools), this.d.policy.maxPriorityMicroLamports);
      this.priority.set(key, { value: v, at: now });
      if (this.priority.size > 200) this.priority.delete(this.priority.keys().next().value!);
      return v;
    } catch {
      // Unknown market fee: budget for the cap rather than for zero.
      return this.d.policy.maxPriorityMicroLamports;
    }
  }

  async assess(c: Candidate): Promise<AssessmentRecord> {
    const p = this.d.policy;
    const started = this.d.clock.now();
    const token = this.d.registry.get(c.mint);

    // 1. Size in lamports.
    let fx: FxQuote | undefined;
    let fxError: string | undefined;
    let size: bigint | undefined;
    try {
      fx = await this.d.fx.solCad();
      size = cadToLamports(p.evalSizeCad, fx.solCad);
    } catch (e) {
      fxError = asError(e).message;
    }

    // 2. Fresh mint and curve.
    let mint: DecodedMint | Error = new Error("not read");
    let curve: DecodedBondingCurve | null | undefined;
    let accountsSlot: number | undefined;
    let curveAddr: string | undefined;
    try {
      curveAddr = token?.launch_venue === "pump_curve" ? await derivePumpBondingCurve(c.mint) : undefined;
      const res = await this.d.rpc.getMultipleAccounts(curveAddr ? [c.mint, curveAddr] : [c.mint]);
      accountsSlot = res.slot;
      const m = res.accounts[0];
      mint = m ? decodeMint(m.data, m.owner) : new Error("mint account not found");
      if (curveAddr) {
        const ca = res.accounts[1];
        curve = ca && ca.owner === PROGRAMS.PUMP_CURVE ? decodeBondingCurve(ca.data) : null;
      }
    } catch (e) {
      mint = asError(e);
    }

    // 3. Holders.
    let holders: HolderReport | Error;
    try {
      if (mint instanceof Error) throw new Error("mint unavailable");
      if (this.d.clock.now() < this.holderBreakerUntil) throw new Error("holder data paused: RPC rate-limited getTokenLargestAccounts");
      holders = await analyzeHolders(this.d.rpc, c.mint, mint.supply, curve?.creator ?? token?.creator ?? null);
    } catch (e) {
      holders = asError(e);
      if (/429|rate limited/i.test(holders.message) && !holders.message.startsWith("holder data paused")) {
        this.holderBreakerUntil = this.d.clock.now() + HOLDER_BREAKER_MS;
        this.d.logger.warn("holder data unavailable from this RPC; pausing holder checks", { minutes: HOLDER_BREAKER_MS / 60_000 });
      }
    }

    // 4. Priority fee for the pools a swap would lock: the curve for pump.fun tokens,
    //    otherwise the newest pool we know of. Fetched before the quotes so the
    //    quotes are the last input and as fresh as possible at decision time.
    const pool = (this.d.db.prepare("SELECT pool FROM pools WHERE mint = ? ORDER BY first_seen_at DESC LIMIT 1").get(c.mint) as { pool: string } | undefined)?.pool;
    const prio = await this.priorityFee([curve ? curveAddr : undefined, pool].filter((x): x is string => !!x));

    // 5. Quotes. No quotes without a size.
    let buy: Quote | Error = new Error(fxError ? "no size (FX unavailable)" : "not requested");
    let sell: Quote | Error | undefined;
    if (size !== undefined) {
      try {
        buy = await this.d.quotes.quote({ inputMint: MINTS.WSOL, outputMint: c.mint, amount: size, slippageBps: p.quoteSlippageBps });
      } catch (e) {
        buy = asError(e);
      }
      if (!(buy instanceof Error)) {
        try {
          sell = await this.d.quotes.quote({ inputMint: c.mint, outputMint: MINTS.WSOL, amount: buy.outAmount, slippageBps: p.quoteSlippageBps });
        } catch (e) {
          sell = asError(e);
        }
      }
    }

    // 6. Costs and verdict.
    let costs: CostBreakdown | undefined;
    if (size !== undefined && !(buy instanceof Error) && sell && !(sell instanceof Error) && !(mint instanceof Error)) {
      costs = computeCosts({ sizeLamports: size, buy, sell, priorityMicroLamportsPerCu: prio, computeUnits: p.assumedComputeUnits, mintProgram: mint.program });
    }
    const ibf = curve && !(buy instanceof Error) ? impliedBuyFeeBps(curve, buy) : undefined;
    const isf = curve && sell && !(sell instanceof Error) ? impliedSellFeeBps(curve, sell) : undefined;
    const now = this.d.clock.now();
    const gate = evaluateGate(
      { now, confirmStatus: token?.confirm_status ?? "MISSING", mint, curve, sizeLamports: size, holders, buy, sell, costs, impliedBuyFeeBps: ibf, impliedSellFeeBps: isf, fxError },
      p,
    );

    this.persist(c, token?.stage ?? null, now, gate, { fx, size, mint, buy, sell, costs, prio, ibf, isf, holders, accountsSlot, durationMs: now - started });
    this.stats.assessed++;
    if (gate.verdict === "PASS") this.stats.passed++;
    else this.stats.rejected++;
    this.d.logger.info("assessed", { mint: c.mint, verdict: gate.verdict, rejects: gate.rejects.map((r) => r.rule), costBps: costs?.totalCostBps });
    return {
      mint: c.mint,
      at: now,
      gate,
      costs,
      buy: buy instanceof Error ? undefined : buy,
      sell: sell instanceof Error ? undefined : sell,
      holders: holders instanceof Error ? undefined : holders,
      fx,
    };
  }

  private persist(
    c: Candidate,
    stage: string | null,
    now: number,
    gate: GateResult,
    x: {
      fx?: FxQuote;
      size?: bigint;
      mint: DecodedMint | Error;
      buy: Quote | Error;
      sell?: Quote | Error;
      costs?: CostBreakdown;
      prio: number;
      ibf?: number;
      isf?: number;
      holders: HolderReport | Error;
      accountsSlot?: number;
      durationMs: number;
    },
  ): void {
    const q = (v: Quote | Error | undefined) => (v && !(v instanceof Error) ? v : undefined);
    const buy = q(x.buy);
    const sell = q(x.sell);
    const h = x.holders instanceof Error ? undefined : x.holders;
    this.d.db
      .prepare(
        `INSERT INTO assessments (mint, at, verdict, rejects, flags, recheck_after, candidate_source, liquidity_usd_reported, stage, mint_program,
           size_cad, sol_cad, fx_json, size_lamports, buy_out, sell_out, buy_impact_pct, sell_impact_pct, buy_route, sell_route, quote_gap_ms,
           quote_round_trip_bps, network_fee_lamports, rent_lamports, total_cost_bps, break_even_pct, priority_micro_lamports,
           implied_buy_fee_bps, implied_sell_fee_bps, top10_wallet_pct, largest_wallet_pct, creator_pct, pool_pct, holders_slot, accounts_slot, duration_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.mint,
        now,
        gate.verdict,
        JSON.stringify(gate.rejects),
        JSON.stringify(gate.flags),
        now + recheckDelayMs(gate, this.d.policy),
        c.source,
        c.liquidityUsd ?? null,
        stage,
        x.mint instanceof Error ? null : x.mint.program,
        this.d.policy.evalSizeCad,
        x.fx?.solCad ?? null,
        x.fx ? JSON.stringify(x.fx) : null,
        x.size?.toString() ?? null,
        buy?.outAmount.toString() ?? null,
        sell?.outAmount.toString() ?? null,
        buy ? buy.priceImpact * 100 : null,
        sell ? sell.priceImpact * 100 : null,
        buy ? buy.routeLabels.join(">") : x.buy instanceof Error ? `ERR:${x.buy.message.slice(0, 60)}` : null,
        sell ? sell.routeLabels.join(">") : x.sell instanceof Error ? `ERR:${x.sell.message.slice(0, 60)}` : null,
        buy && sell ? Math.abs(sell.receivedAt - buy.receivedAt) : null,
        x.costs ? Number((x.costs.quoteRoundTripLossLamports * 10_000n) / x.costs.sizeLamports) : null,
        x.costs?.networkFeesLamports.toString() ?? null,
        x.costs?.rentLamports.toString() ?? null,
        x.costs?.totalCostBps ?? null,
        x.costs?.breakEvenMovePct ?? null,
        x.prio,
        x.ibf ?? null,
        x.isf ?? null,
        h?.top10WalletPct ?? null,
        h?.largestWalletPct ?? null,
        h?.creatorPct ?? null,
        h?.poolPct ?? null,
        h?.slot ?? null,
        x.accountsSlot ?? null,
        x.durationMs,
      );
  }
}
