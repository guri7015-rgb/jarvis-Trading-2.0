/**
 * Signal engine (Phase 4): watchlist → live trades → features → strategies →
 * risk manager → recorded decision. Paper only: an approved decision is
 * recorded as PAPER_ELIGIBLE. Nothing here creates a position or a transaction.
 *
 * Watchlist admission:
 *   - a recent gate assessment with verdict PASS, or
 *   - research mode only: a reject whose ONLY failures are missing data (e.g.
 *     holder data refused by the RPC). These are watched to measure signals,
 *     and the risk manager always rejects them at gate 2.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import { categorize, type TokenRegistry } from "../discovery/registry.ts";
import type { HealthMonitor } from "../health/monitor.ts";
import type { TradeEvent } from "../market/eventDecoder.ts";
import type { TradeStream, WatchTarget } from "../market/tradeStream.ts";
import type { RiskLimits } from "../risk/limits.ts";
import { decideEntry, type AssessmentView, type RiskDecision } from "../risk/manager.ts";
import type { RiskStateStore } from "../risk/riskState.ts";
import { derivePumpBondingCurve } from "../solana/address.ts";
import { MINTS, PROGRAMS } from "../solana/programs.ts";
import { decodeBondingCurve } from "../solana/pumpCurve.ts";
import { decodePumpSwapPool } from "../solana/pumpSwapPool.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { computeFeatures, type Features, type Trade } from "./features.ts";
import { strategyA } from "./strategyA.ts";
import { strategyB } from "./strategyB.ts";
import { strategyC } from "./strategyC.ts";
import { strategyD } from "./strategyD.ts";
import type { Signal } from "./types.ts";
import type { PaperTrader } from "../paper/trader.ts";
import type { Ledger } from "../paper/ledger.ts";
import type { FxService, FxQuote } from "../market/fx.ts";

export interface EngineDeps {
  db: DatabaseSync;
  registry: TokenRegistry;
  rpc: SolanaRpc;
  stream: TradeStream;
  health: HealthMonitor;
  clock: Clock;
  logger: Logger;
  limits: RiskLimits;
  limitsRefused: string[];
  riskState: RiskStateStore;
  /** Admit tokens rejected only for missing data, for measurement. Never tradable. */
  research: boolean;
  newLaunchMaxAgeMs: number;
  earlyMaxAgeMs: number;
  /** Phase 5: when present, approved entries open paper positions and open positions are managed each tick. */
  trader?: PaperTrader;
  ledger?: Ledger;
  fx?: FxService;
  /** Daily halt reason, if a kill switch or limit has fired (blocks entries, never exits). */
  haltReason?: () => string | null;
}

interface Watched {
  target: WatchTarget;
  addedAt: number;
  researchOnly: boolean;
  decimals: number;
}

export const MAX_WATCH = 3;
const WATCH_IDLE_MS = 10 * 60_000;
const WATCH_MAX_MS = 60 * 60_000;
const ASSESSMENT_LOOKBACK_MS = 10 * 60_000;
const SNAPSHOT_EVERY_MS = 30_000;

export class SignalEngine {
  private watch = new Map<string, Watched>();
  private cooldown = new Map<string, number>();
  private lastSnapshot = new Map<string, number>();
  private timers: unknown[] = [];
  private running = false;
  private fxCache: { q: FxQuote; at: number } | undefined;
  public stats = { ticks: 0, signals: 0, approved: 0, rejected: 0, tradesStored: 0, watchAdds: 0, watchDrops: 0, paperEntries: 0 };

  constructor(private readonly d: EngineDeps) {}

  /** Called by the trade stream. Stores ONCHAIN_CONFIRMED trades (confirmed commitment). */
  onTrades(target: WatchTarget, events: TradeEvent[], receivedAt: number): void {
    const w = this.watch.get(target.mint);
    if (!w) return;
    const ins = this.d.db.prepare(
      `INSERT OR IGNORE INTO trades (mint, venue, signature, event_index, slot, block_time_ms, received_at, side, wallet, quote_amount, token_amount, price_sol, real_quote_reserves)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of events) {
      if (e.tokenAmount === 0n) continue;
      const price = Number(e.quoteAmount) / 1e9 / (Number(e.tokenAmount) / 10 ** w.decimals);
      const r = ins.run(target.mint, e.venue, e.signature, e.eventIndex, e.slot, e.blockTimeMs, receivedAt, e.side, e.wallet, e.quoteAmount.toString(), e.tokenAmount.toString(), price, e.realQuoteReserves?.toString() ?? null);
      this.stats.tradesStored += Number(r.changes);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = (fn: () => Promise<void>, every: number) => {
      const run = async () => {
        if (!this.running) return;
        try {
          await fn();
        } catch (e) {
          this.d.logger.warn("engine task failed", { err: (e as Error).message });
        }
        if (this.running) this.timers.push(this.d.clock.setTimeout(run, every));
      };
      void run();
    };
    loop(() => this.refreshWatchlist(), 30_000);
    loop(() => this.cycle(), 5_000);
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) this.d.clock.clearTimeout(t);
  }

  watched(): { mint: string; venue: string; researchOnly: boolean; addedAt: number }[] {
    return [...this.watch.values()].map((w) => ({ mint: w.target.mint, venue: w.target.venue, researchOnly: w.researchOnly, addedAt: w.addedAt }));
  }

  /** Latest assessment as the risk manager sees it. */
  private assessment(mint: string): AssessmentView | undefined {
    const r = this.d.db.prepare("SELECT at, verdict, rejects, total_cost_bps, break_even_pct, size_cad, sol_cad FROM assessments WHERE mint = ? ORDER BY at DESC LIMIT 1").get(mint) as
      | { at: number; verdict: "PASS" | "REJECT"; rejects: string; total_cost_bps: number | null; break_even_pct: number | null; size_cad: number; sol_cad: number | null }
      | undefined;
    if (!r) return undefined;
    const rejects = JSON.parse(r.rejects) as { kind: string }[];
    return {
      at: r.at,
      verdict: r.verdict,
      researchOnly: r.verdict === "REJECT" && rejects.length > 0 && rejects.every((x) => x.kind === "data"),
      totalCostBps: r.total_cost_bps,
      breakEvenPct: r.break_even_pct,
      sizeCad: r.size_cad,
      solCad: r.sol_cad,
    };
  }

  async refreshWatchlist(): Promise<void> {
    const now = this.d.clock.now();
    // Drop idle, stale or no-longer-acceptable tokens.
    for (const [mint, w] of this.watch) {
      const lastTrade = (this.d.db.prepare("SELECT MAX(received_at) t FROM trades WHERE mint = ?").get(mint) as { t: number | null }).t ?? w.addedAt;
      const a = this.assessment(mint);
      const structural = a && a.verdict === "REJECT" && !a.researchOnly && (JSON.parse((this.d.db.prepare("SELECT rejects FROM assessments WHERE mint = ? ORDER BY at DESC LIMIT 1").get(mint) as { rejects: string }).rejects) as { kind: string }[]).some((x) => x.kind === "structural");
      if (now - lastTrade > WATCH_IDLE_MS || now - w.addedAt > WATCH_MAX_MS || structural) {
        this.d.stream.remove(w.target.account);
        this.watch.delete(mint);
        this.stats.watchDrops++;
      }
    }
    if (this.watch.size >= MAX_WATCH) return;
    const rows = this.d.db
      .prepare("SELECT mint, verdict, rejects FROM assessments WHERE at >= ? ORDER BY at DESC")
      .all(now - ASSESSMENT_LOOKBACK_MS) as { mint: string; verdict: string; rejects: string }[];
    const seen = new Set<string>();
    for (const r of rows) {
      if (this.watch.size >= MAX_WATCH) break;
      if (seen.has(r.mint) || this.watch.has(r.mint)) continue;
      seen.add(r.mint);
      const rejects = JSON.parse(r.rejects) as { kind: string }[];
      const researchOnly = r.verdict === "REJECT" && rejects.length > 0 && rejects.every((x) => x.kind === "data");
      if (r.verdict !== "PASS" && !(this.d.research && researchOnly)) continue;
      const target = await this.resolveTarget(r.mint);
      if (!target) continue;
      const t = this.d.registry.get(r.mint);
      this.watch.set(r.mint, { target, addedAt: now, researchOnly, decimals: t?.decimals ?? 6 });
      this.d.stream.add(target);
      this.stats.watchAdds++;
      this.d.logger.info("watching", { mint: r.mint, venue: target.venue, researchOnly });
    }
  }

  /** Where this token trades now, checked on-chain: its live curve, or its PumpSwap pool. */
  private async resolveTarget(mint: string): Promise<WatchTarget | undefined> {
    const t = this.d.registry.get(mint);
    if (!t) return undefined;
    const pool = (this.d.db.prepare("SELECT pool FROM pools WHERE mint = ? AND venue = 'pumpswap' ORDER BY first_seen_at DESC LIMIT 1").get(mint) as { pool: string } | undefined)?.pool;
    const curve = t.launch_venue === "pump_curve" ? await derivePumpBondingCurve(mint) : undefined;
    const addrs = [curve, pool].filter((x): x is string => !!x);
    if (!addrs.length) return undefined;
    const res = await this.d.rpc.getMultipleAccounts(addrs);
    const ci = curve ? 0 : -1;
    const pi = pool ? addrs.length - 1 : -1;
    if (ci >= 0) {
      const a = res.accounts[ci];
      if (a && a.owner === PROGRAMS.PUMP_CURVE) {
        try {
          const c = decodeBondingCurve(a.data);
          if (!c.complete && !c.isMayhemMode && c.quoteMint === MINTS.WSOL) return { account: curve!, mint, venue: "pump_curve" };
        } catch {
          /* fall through to the pool */
        }
      }
    }
    if (pi >= 0) {
      const a = res.accounts[pi];
      if (a && a.owner === PROGRAMS.PUMPSWAP) {
        try {
          const p = decodePumpSwapPool(a.data);
          if (p.baseMint === mint && p.quoteMint === MINTS.WSOL) return { account: pool!, mint, venue: "pumpswap" };
        } catch {
          /* not watchable */
        }
      }
    }
    return undefined;
  }

  private loadTrades(mint: string, since: number): Trade[] {
    const rows = this.d.db
      .prepare("SELECT signature, event_index, slot, block_time_ms, received_at, side, wallet, quote_amount, price_sol, real_quote_reserves FROM trades WHERE mint = ? AND block_time_ms >= ? ORDER BY slot, event_index")
      .all(mint, since) as { signature: string; event_index: number; slot: number; block_time_ms: number; received_at: number; side: "buy" | "sell"; wallet: string; quote_amount: string; price_sol: number; real_quote_reserves: string | null }[];
    return rows.map((r) => ({
      mint,
      signature: r.signature,
      eventIndex: r.event_index,
      slot: r.slot,
      blockTimeMs: r.block_time_ms,
      receivedAt: r.received_at,
      side: r.side,
      wallet: r.wallet,
      quoteSol: Number(r.quote_amount) / 1e9,
      priceSol: r.price_sol,
      realQuoteSol: r.real_quote_reserves ? Number(r.real_quote_reserves) / 1e9 : undefined,
    }));
  }

  private gaps(since: number): { from: number; to: number }[] {
    return (this.d.db.prepare("SELECT from_ms, to_ms FROM gaps WHERE to_ms >= ? AND provider IN ('all','solana_ws')").all(since) as { from_ms: number; to_ms: number }[]).map((g) => ({ from: g.from_ms, to: g.to_ms }));
  }

  private async fx(): Promise<FxQuote | undefined> {
    if (!this.d.fx) return undefined;
    const now = this.d.clock.now();
    if (this.fxCache && now - this.fxCache.at < 60_000) return this.fxCache.q;
    try {
      const q = await this.d.fx.solCad();
      this.fxCache = { q, at: now };
      return q;
    } catch {
      return undefined;
    }
  }

  /** Open positions are never left unmanaged: this runs whether or not entries are halted. */
  private async managePositions(featuresByMint: Map<string, Features>, solCad: number | null): Promise<void> {
    const trader = this.d.trader;
    if (!trader) return;
    // A halt blocks new entries only; it is not by itself a reason to flatten.
    // `riskLimitBreached` is reserved for an explicit kill switch (haltReason starting with "KILL").
    const kill = (this.d.haltReason?.() ?? this.d.riskState.today().haltedReason ?? "").startsWith("KILL");
    for (const p of this.ledgerOpen()) {
      await trader.manage(p, featuresByMint.get(p.mint), solCad, kill);
    }
  }

  private ledgerOpen() {
    return this.d.ledger?.open() ?? [];
  }

  /** One pass over the watchlist. Returns the decisions made, for tests. */
  tick(): { mint: string; signal: Signal; decision: RiskDecision }[] {
    const { out } = this.evaluate();
    return out;
  }

  /** Full cycle: evaluate signals, open approved paper entries, manage open positions. */
  async cycle(): Promise<void> {
    const { out, features } = this.evaluate();
    const trader = this.d.trader;
    if (!trader) return;
    const fx = await this.fx();
    for (const r of out) {
      if (!r.decision.approved || !fx) continue;
      const t = this.d.registry.get(r.mint);
      const w = this.watch.get(r.mint);
      if (!t || !w) continue;
      const f = features.get(r.mint);
      const pos = await trader.enter({
        mint: r.mint,
        venue: w.target.venue,
        decimals: w.decimals,
        program: t.mint_program === "token" ? "token" : "token2022",
        signal: r.signal,
        decision: r.decision,
        fx,
        realQuoteSol: f?.realQuoteSol ?? undefined,
      });
      if (pos) this.stats.paperEntries++;
    }
    await this.managePositions(features, fx?.solCad ?? null);
    try {
      this.d.ledger?.snapshot(trader.marks(), fx?.solCad ?? null);
    } catch {
      /* account not initialised yet */
    }
  }

  private evaluate(): { out: { mint: string; signal: Signal; decision: RiskDecision }[]; features: Map<string, Features> } {
    this.stats.ticks++;
    const now = this.d.clock.now();
    const gate = this.d.health.gate();
    const ws = this.d.health.get("solana_ws");
    const feedsHealthy = gate.open && ws.status !== "DOWN";
    const feedReasons = [...gate.reasons, ...(ws.status === "DOWN" ? [`trade feed ${ws.reason}`] : [])];
    const out: { mint: string; signal: Signal; decision: RiskDecision }[] = [];
    const featuresByMint = new Map<string, Features>();
    const state = this.d.riskState.today();
    const openPositions = this.ledgerOpen();
    const pendingOrders = this.d.ledger?.pending().length ?? 0;
    const openRiskCad = this.d.trader?.openRiskCad() ?? 0;
    // Positions on tokens no longer watched still need features for exits.
    const mints = new Set([...this.watch.keys(), ...openPositions.map((p) => p.mint)]);
    for (const mint of mints) {
      const w = this.watch.get(mint);
      const f = computeFeatures(mint, this.loadTrades(mint, now - 300_000), now, this.gaps(now - 300_000));
      featuresByMint.set(mint, f);
      if (!w) continue;
      const t = this.d.registry.get(mint);
      const cat = t ? categorize(t, now, { newLaunchMaxAgeMs: this.d.newLaunchMaxAgeMs, earlyMaxAgeMs: this.d.earlyMaxAgeMs }) : undefined;
      // Age only from a creation time that isn't merely an upper bound.
      const ctx = { tokenAgeMs: cat && cat.category !== "UNKNOWN_AGE" ? cat.ageMs : undefined };
      const failure = strategyD(f);
      if (now - (this.lastSnapshot.get(mint) ?? 0) >= SNAPSHOT_EVERY_MS) {
        this.lastSnapshot.set(mint, now);
        this.record(now, mint, "SNAPSHOT", "SNAPSHOT", [w.target.venue, w.researchOnly ? "research-only" : "gated", ...f.quality.reasons], undefined, undefined, f);
      }
      const signals = [strategyA(f, ctx), strategyB(f, ctx, "retest"), strategyB(f, ctx, "no_retest"), strategyC(f, ctx)];
      for (const s of signals) {
        if (s.action !== "ENTER") continue;
        const key = `${mint}:${s.strategy}`;
        if ((this.cooldown.get(key) ?? 0) > now) continue;
        this.cooldown.set(key, now + s.cooldownMs);
        this.stats.signals++;
        const decision = decideEntry(
          {
            now,
            signal: s,
            failure,
            feedsHealthy,
            feedReasons,
            quality: f.quality,
            assessment: this.assessment(mint),
            lastPrice: f.last,
            state,
            openPositions: openPositions.length,
            pendingOrders,
            openRiskCad,
            limitsRefused: this.d.limitsRefused,
          },
          this.d.limits,
        );
        if (decision.approved) this.stats.approved++;
        else this.stats.rejected++;
        this.record(now, mint, s.strategy, decision.approved ? "PAPER_ELIGIBLE" : "REJECT", decision.approved ? s.reasons : [`${decision.firstFailure}: ${decision.steps.find((x) => !x.ok)?.detail ?? ""}`], s, decision, f);
        out.push({ mint, signal: s, decision });
        if (decision.approved) break; // one approved entry per token per tick
      }
    }
    return { out, features: featuresByMint };
  }

  private record(at: number, mint: string, strategy: string, action: string, reasons: string[], s?: Signal, d?: RiskDecision, f?: Features): void {
    this.d.db
      .prepare("INSERT INTO decisions (at, mint, strategy, action, reasons, signal_json, risk_json, features_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(at, mint, strategy, action, JSON.stringify(reasons), s ? JSON.stringify(s) : null, d ? JSON.stringify(d) : null, f ? JSON.stringify(f) : null);
  }
}
