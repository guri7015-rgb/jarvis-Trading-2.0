/**
 * Paper trader: turns approved entries into paper positions and manages them.
 *
 *   entry:  approved decision → executor.buy → ledger (OPEN or FAILED)
 *   manage: every tick, for each open position: fresh sell quote (net of
 *           fees), features + strategy D, exit engine → executor.sell → ledger
 *
 * Protective exits run even when new entries are halted. A sell with no
 * route marks the position STUCK and raises an alert; it is retried on later
 * ticks, never spammed.
 */
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { FxQuote } from "../market/fx.ts";
import type { QuoteClient } from "../market/quotes.ts";
import { BASE_FEE_LAMPORTS } from "../risk/costs.ts";
import type { RiskDecision } from "../risk/manager.ts";
import type { RiskStateStore } from "../risk/riskState.ts";
import { MINTS } from "../solana/programs.ts";
import { DEFAULT_EXIT_POLICY, decideExit, type ExitDecision, type ExitPolicy } from "../strategy/exits.ts";
import type { Features } from "../strategy/features.ts";
import { D_PARAMS, strategyD } from "../strategy/strategyD.ts";
import type { Signal } from "../strategy/types.ts";
import type { PaperExecutor } from "./executor.ts";
import { Ledger, type PositionRow } from "./ledger.ts";

export interface TraderDeps {
  ledger: Ledger;
  executor: PaperExecutor;
  quotes: QuoteClient;
  riskState: RiskStateStore;
  clock: Clock;
  logger: Logger;
  priorityMicroLamports: () => number;
  computeUnits: number;
  slippageBps: number;
  exitPolicy?: ExitPolicy;
  /** Sell-quote refresh cadence for open positions (rate-limit budget). */
  markEveryMs: number;
  /** Strategy D parameters for exit checks. */
  dParams?: typeof D_PARAMS;
  onAlert?: (msg: string, ctx: Record<string, unknown>) => void;
}

export interface EntryRequest {
  mint: string;
  venue: string;
  decimals: number;
  program: "token" | "token2022";
  signal: Signal;
  decision: RiskDecision;
  fx: FxQuote;
  realQuoteSol?: number;
}

export class PaperTrader {
  private lastMark = new Map<string, { at: number; net: bigint; route: boolean; impact: number }>();
  private busy = new Set<string>();
  public stats = { entries: 0, entryFailures: 0, exits: 0, exitFailures: 0, stuck: 0, alerts: 0 };

  constructor(private readonly d: TraderDeps) {}

  private netOfFees(gross: bigint): bigint {
    const prio = BigInt(Math.ceil((this.d.priorityMicroLamports() * this.d.computeUnits) / 1_000_000));
    const n = gross - BASE_FEE_LAMPORTS - prio;
    return n > 0n ? n : 0n;
  }

  /** Open a paper position. Idempotent on the position id. */
  async enter(req: EntryRequest): Promise<PositionRow | undefined> {
    const d = req.decision;
    if (!d.approved || d.sizeCad === undefined || d.plannedLossCad === undefined) return undefined;
    const s = req.signal;
    if (s.invalidationPrice === undefined || s.targetPrice === undefined || s.timeStopMs === undefined) return undefined;
    const id = `${req.mint.slice(0, 8)}-${s.strategy}-${this.d.clock.now()}`;
    const size = BigInt(Math.floor((d.sizeCad / req.fx.solCad) * 1e9));
    const breakout = s.strategy.startsWith("B_") ? s.maxEntryPrice : undefined;
    this.d.ledger.propose({
      id,
      mint: req.mint,
      venue: req.venue,
      strategy: s.strategy,
      decimals: req.decimals,
      plannedSizeLamports: size,
      plannedLossCad: d.plannedLossCad,
      invalidationPrice: s.invalidationPrice,
      targetPrice: s.targetPrice,
      timeStopMs: s.timeStopMs,
      breakoutLevel: breakout,
      realQuoteSolAtEntry: req.realQuoteSol,
      solCad: req.fx.solCad,
      fxJson: JSON.stringify(req.fx),
    });
    this.d.riskState.recordEntry();
    const r = await this.d.executor.buy(req.mint, size, { decimals: req.decimals, program: req.program }, this.d.slippageBps);
    if (r.ok && r.entryPrice !== undefined) {
      this.d.ledger.recordEntryFill(id, r.fill, r.entryPrice);
      this.stats.entries++;
      this.d.logger.info("paper entry", { id, mint: req.mint, strategy: s.strategy, sizeCad: d.sizeCad, entryPrice: r.entryPrice, slippageBps: r.fill.slippageBps, latencyMs: r.fill.simLatencyMs });
    } else {
      this.d.ledger.recordEntryFailure(id, r.fill);
      this.stats.entryFailures++;
      const feesCad = (Number(r.fill.baseFee + r.fill.priorityFee) / 1e9) * req.fx.solCad;
      this.d.riskState.recordClose(-feesCad);
      this.d.logger.warn("paper entry failed", { id, mint: req.mint, failure: r.fill.failure, feesCad });
    }
    return this.d.ledger.get(id);
  }

  /** Planned loss of open positions, for the daily budget. */
  openRiskCad(): number {
    return this.d.ledger.open().reduce((s, p) => s + p.planned_loss_cad, 0);
  }

  /**
   * Manage one open position. `features` may be undefined when the token is
   * no longer watched; exits then rely on quotes and time alone.
   */
  async manage(p: PositionRow, features: Features | undefined, solCad: number | null, riskLimitBreached: boolean): Promise<ExitDecision | undefined> {
    if (this.busy.has(p.id)) return undefined;
    this.busy.add(p.id);
    try {
      const now = this.d.clock.now();
      const held = BigInt(p.tokens_held);
      if (held <= 0n) return undefined;
      let mark = this.lastMark.get(p.id);
      if (!mark || now - mark.at >= this.d.markEveryMs) {
        try {
          const q = await this.d.quotes.quote({ inputMint: p.mint, outputMint: MINTS.WSOL, amount: held, slippageBps: this.d.slippageBps });
          mark = { at: now, net: this.netOfFees(q.outAmount), route: true, impact: q.priceImpact };
        } catch (e) {
          mark = { at: now, net: 0n, route: (e as Error).message !== "NO_ROUTE", impact: 1 };
        }
        this.lastMark.set(p.id, mark);
        if (mark.route) this.d.ledger.updateMark(p.id, mark.net);
      }
      const costBasis = BigInt(p.cost_basis_lamports);
      const failure = features ? strategyD(features, { breakoutLevel: p.breakout_level ?? undefined, invalidationPrice: p.invalidation_price, realQuoteSolAtEntry: p.real_quote_sol_at_entry ?? undefined }, this.d.dParams ?? D_PARAMS) : { action: "NONE" as const, reasons: [] };
      const decision = decideExit(
        {
          entryAt: p.opened_at ?? now,
          entryPrice: p.entry_price ?? 0,
          costBasisSol: Number(costBasis) / 1e9,
          invalidationPrice: p.invalidation_price,
          targetPrice: p.target_price,
          timeStopMs: p.time_stop_ms,
          peakNetSol: Number(BigInt(p.peak_net_lamports)) / 1e9,
          partialTaken: p.partial_taken === 1,
        },
        {
          now,
          lastPrice: features?.last ?? null,
          sellNetSol: mark.route && mark.net > 0n ? Number(mark.net) / 1e9 : undefined,
          sellRouteAvailable: mark.route,
          exitImpactPct: mark.route ? mark.impact : undefined,
          tokenRestricted: p.state === "STUCK" && !mark.route,
          riskLimitBreached,
          failure,
        },
        this.d.exitPolicy ?? DEFAULT_EXIT_POLICY,
      );
      if (decision.action === "HOLD") return decision;
      if (decision.action === "ALERT") {
        this.stats.alerts++;
        this.d.onAlert?.("exit wanted but no verified route", { id: p.id, mint: p.mint, reason: decision.reason, blocked: decision.blocked });
        if (p.state !== "STUCK") {
          this.d.ledger.recordExitFailure(p.id, { quoteIn: held, quoteOut: 0n, quoteImpactPct: 0, quoteRoute: "", quoteAt: now, simLatencyMs: 0, baseFee: 0n, priorityFee: 0n, rent: 0n, failure: decision.blocked }, decision.reason ?? "ALERT", true);
          this.stats.stuck++;
        }
        return decision;
      }
      const tokens = decision.action === "EXIT_PARTIAL" ? held / 2n : held;
      const r = await this.d.executor.sell(p.mint, tokens, this.d.slippageBps);
      const detail = decision.matched.map((m) => `${m.reason}: ${m.detail}`).join("; ");
      if (r.ok) {
        this.d.ledger.recordExitFill(p.id, r.fill, tokens, decision.reason ?? "EXIT", detail, solCad);
        this.lastMark.delete(p.id);
        const after = this.d.ledger.get(p.id);
        if (after?.state === "CLOSED" && after.realized_pnl_cad !== null) this.d.riskState.recordClose(after.realized_pnl_cad);
        this.stats.exits++;
        this.d.logger.info("paper exit", { id: p.id, reason: decision.reason, tokens: tokens.toString(), pnlCad: after?.realized_pnl_cad, slippageBps: r.fill.slippageBps });
      } else {
        this.d.ledger.recordExitFailure(p.id, r.fill, decision.reason ?? "EXIT", r.noRoute);
        this.stats.exitFailures++;
        if (r.noRoute) {
          this.stats.stuck++;
          this.d.onAlert?.("sell route disappeared", { id: p.id, mint: p.mint });
        }
        this.d.logger.warn("paper exit failed", { id: p.id, failure: r.fill.failure, noRoute: r.noRoute });
      }
      return decision;
    } finally {
      this.busy.delete(p.id);
    }
  }

  marks(): Map<string, bigint> {
    const m = new Map<string, bigint>();
    for (const [id, v] of this.lastMark) if (v.route) m.set(id, v.net);
    return m;
  }
}
