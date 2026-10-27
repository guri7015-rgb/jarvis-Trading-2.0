/**
 * Everything the dashboard shows, read from the database and live objects.
 * Pure read: the dashboard can't change any setting or trigger any action
 * except the manual emergency stop (see server.ts), which closes open paper
 * positions and halts new entries for the day.
 */
import type { DatabaseSync } from "node:sqlite";
import { LIVE_TRADING_ENABLED } from "../core/config.ts";
import type { HealthMonitor } from "../health/monitor.ts";
import type { Ledger } from "../paper/ledger.ts";
import type { RiskLimits } from "../risk/limits.ts";
import type { RiskStateStore } from "../risk/riskState.ts";
import { SOFTWARE_VERSION } from "../paper/ledger.ts";

export interface DashboardDeps {
  db: DatabaseSync;
  health: HealthMonitor;
  riskState: RiskStateStore;
  limits: RiskLimits;
  limitsRefused: string[];
  ledger?: Ledger;
  marks?: () => Map<string, bigint>;
  watched?: () => { mint: string; venue: string; researchOnly: boolean; addedAt: number }[];
  rpcBudget?: () => { usedToday: number; remaining: number };
  /** Scanner movers and firehose stats, when --scan is on. */
  movers?: () => { list: { key: string; mint?: string; venue: string; status: string; firstSeenAt: number; lastTradeAt: number; trades60: number; trades15: number; buyers60: number; sellers60: number; buySol60: number; sellSol60: number; ret60: number; score: number }[]; stats: Record<string, number> };
  /** Label shown in the top bar: PAPER, or PAPER EXPLORE. */
  mode?: string;
  now: () => number;
}

/** Every mint the page shows, so logos can be looked up for exactly those. */
export function shownMints(s: ReturnType<typeof dashboardState>): string[] {
  return [...new Set([...s.tokens.recent, ...s.assessments.recentRejections, ...s.signals, ...s.positions, ...s.watchlist, ...s.events, ...s.review].map((x) => x.mint))];
}

export function dashboardState(d: DashboardDeps) {
  const now = d.now();
  const day = d.riskState.today();
  const q = <T>(sql: string, ...p: (string | number)[]) => d.db.prepare(sql).all(...p) as unknown as T[];
  const one = <T>(sql: string, ...p: (string | number)[]) => d.db.prepare(sql).get(...p) as T | undefined;

  const gate = d.health.gate();
  const feeds = d.health.snapshot().map((h) => ({ provider: h.provider, status: h.status, reason: h.reason, lastDataAt: h.kind === "stream" ? h.lastEventAt : h.lastSuccessAt, rateLimitHits: h.rateLimitHits, failures: h.totalFailures }));
  const lastUpdate = Math.max(0, ...feeds.map((f) => f.lastDataAt ?? 0));

  const tokens = one<{ n: number; confirmed: number; conflicts: number }>("SELECT COUNT(*) n, SUM(confirm_status='CONFIRMED') confirmed, SUM(confirm_status='CONFLICT') conflicts FROM tokens");
  const recentTokens = q<{ mint: string; stage: string; confirm_status: string; launch_venue: string | null; first_observed_at: number }>("SELECT mint, stage, confirm_status, launch_venue, first_observed_at FROM tokens ORDER BY first_observed_at DESC LIMIT 8");

  const rejections = q<{ mint: string; at: number; rejects: string; total_cost_bps: number | null }>("SELECT mint, at, rejects, total_cost_bps FROM assessments WHERE verdict='REJECT' ORDER BY at DESC LIMIT 12").map((r) => ({
    mint: r.mint,
    at: r.at,
    rules: (JSON.parse(r.rejects) as { rule: string; observed: string; limit: string }[]).map((x) => `${x.rule} (${x.observed}; limit ${x.limit})`),
    costBps: r.total_cost_bps,
  }));
  const ruleCounts = new Map<string, number>();
  for (const r of q<{ rejects: string }>("SELECT rejects FROM assessments WHERE at >= ?", now - 24 * 3_600_000)) for (const x of JSON.parse(r.rejects) as { rule: string }[]) ruleCounts.set(x.rule, (ruleCounts.get(x.rule) ?? 0) + 1);
  const assessed24h = one<{ n: number; pass: number }>("SELECT COUNT(*) n, SUM(verdict='PASS') pass FROM assessments WHERE at >= ?", now - 24 * 3_600_000);

  const eligible = q<{ at: number; mint: string; strategy: string; action: string; reasons: string; risk_json: string | null }>("SELECT at, mint, strategy, action, reasons, risk_json FROM decisions WHERE action IN ('PAPER_ELIGIBLE','REJECT') ORDER BY at DESC LIMIT 12").map((r) => ({
    at: r.at,
    mint: r.mint,
    strategy: r.strategy,
    action: r.action,
    reasons: JSON.parse(r.reasons) as string[],
    sizeCad: r.risk_json ? (JSON.parse(r.risk_json) as { sizeCad?: number }).sizeCad : undefined,
  }));

  const marks = d.marks?.() ?? new Map<string, bigint>();
  const open = (d.ledger?.open() ?? []).map((p) => {
    const mark = marks.get(p.id);
    const basis = BigInt(p.cost_basis_lamports);
    return {
      id: p.id,
      mint: p.mint,
      venue: p.venue,
      strategy: p.strategy,
      state: p.state,
      openedAt: p.opened_at,
      entryPrice: p.entry_price,
      invalidation: p.invalidation_price,
      target: p.target_price,
      tokensHeld: p.tokens_held,
      costBasisSol: Number(basis) / 1e9,
      exitNetSol: mark !== undefined ? Number(mark) / 1e9 : null,
      unrealizedSol: mark !== undefined ? Number(mark - basis) / 1e9 : null,
      unrealizedCad: mark !== undefined && p.sol_cad_at_entry ? (Number(mark - basis) / 1e9) * p.sol_cad_at_entry : null,
      ageS: p.opened_at ? Math.round((now - p.opened_at) / 1000) : null,
    };
  });
  const closed = d.ledger?.closed() ?? [];
  const realizedSol = closed.reduce((s, p) => s + Number(BigInt(p.realized_pnl_lamports ?? "0")) / 1e9, 0);
  const realizedCad = closed.reduce((s, p) => s + (p.realized_pnl_cad ?? 0), 0);
  const feesSol = (d.ledger ? [...closed, ...d.ledger.open()] : []).reduce((s, p) => s + Number(BigInt(p.fees_lamports)) / 1e9, 0);
  const unrealizedSol = open.reduce((s, p) => s + (p.unrealizedSol ?? 0), 0);
  const account = d.ledger?.account();
  const failedOrders = q<{ id: string; position_id: string; side: string; resolved_at: number; failure: string | null }>("SELECT id, position_id, side, resolved_at, failure FROM orders WHERE state='FAILED' ORDER BY resolved_at DESC LIMIT 8");
  const dayStart = Date.parse(day.day + "T00:00:00Z");
  const eqToday = q<{ at: number; equity_lamports: string }>("SELECT at, equity_lamports FROM equity_snapshots WHERE at >= ? ORDER BY at", dayStart);
  let peak = 0n;
  let dd = 0n;
  for (const e of eqToday) {
    const v = BigInt(e.equity_lamports);
    if (v > peak) peak = v;
    if (peak - v > dd) dd = peak - v;
  }
  const staleQuotes = one<{ n: number }>("SELECT COUNT(*) n FROM assessments WHERE at >= ? AND (rejects LIKE '%QUOTE_STALE%' OR rejects LIKE '%QUOTE_GAP%')", now - 3_600_000)?.n ?? 0;

  // Performance of this mode's resolved positions, and how simulated fills compared with their quotes.
  const mode = d.ledger ? (d.mode ?? "PAPER").toLowerCase().replace(" unsafe", "").replace(" ", "_") : "paper";
  const perf = one<{ n: number; wins: number; losses: number; avg_win: number | null; avg_loss: number | null; avg_hold_s: number | null; pnl: number | null; failed: number }>(
    `SELECT COUNT(*) n, SUM(realized_pnl_cad > 0) wins, SUM(realized_pnl_cad < 0) losses,
            AVG(CASE WHEN realized_pnl_cad > 0 THEN realized_pnl_cad END) avg_win,
            AVG(CASE WHEN realized_pnl_cad < 0 THEN realized_pnl_cad END) avg_loss,
            AVG(CASE WHEN opened_at IS NOT NULL AND closed_at IS NOT NULL THEN (closed_at - opened_at) / 1000.0 END) avg_hold_s,
            SUM(realized_pnl_cad) pnl, SUM(state = 'FAILED') failed
       FROM positions WHERE mode = ? AND state IN ('CLOSED','FAILED')`,
    mode,
  );
  const fills = one<{ n: number; failed: number; avg_slip_bps: number | null; avg_latency_ms: number | null; avg_quote_impact: number | null }>(
    `SELECT COUNT(*) n, SUM(o.state = 'FAILED') failed, AVG(o.slippage_bps) avg_slip_bps, AVG(o.sim_latency_ms) avg_latency_ms, AVG(o.quote_impact_pct) avg_quote_impact
       FROM orders o JOIN positions p ON p.id = o.position_id WHERE p.mode = ?`,
    mode,
  );
  const performance = {
    closed: perf?.n ?? 0,
    failedEntries: perf?.failed ?? 0,
    winRate: perf && perf.n ? (perf.wins ?? 0) / perf.n : null,
    avgWinCad: perf?.avg_win ?? null,
    avgLossCad: perf?.avg_loss ?? null,
    avgHoldS: perf?.avg_hold_s ?? null,
    netCad: perf?.pnl ?? null,
    orders: fills?.n ?? 0,
    failedOrders: fills?.failed ?? 0,
    /** Simulated fill versus its own quote, in basis points (what the stress allowance is meant to cover). */
    avgFillSlipBps: fills?.avg_slip_bps ?? null,
    avgLatencyMs: fills?.avg_latency_ms ?? null,
    avgQuoteImpactPct: fills?.avg_quote_impact ?? null,
  };

  const breakers = [
    { name: "Live trading", state: LIVE_TRADING_ENABLED ? "ON" : "OFF (hard-coded)", ok: !LIVE_TRADING_ENABLED },
    { name: "Manual halt", state: day.haltedReason ? `HALTED: ${day.haltedReason}` : "clear", ok: !day.haltedReason },
    { name: "Daily loss", state: `CAD ${day.realizedLossCad.toFixed(2)} of ${d.limits.dailyLossLimitCad}`, ok: day.realizedLossCad < d.limits.dailyLossLimitCad },
    { name: "Entries today", state: `${day.entries} of ${d.limits.maxEntriesPerDay}`, ok: day.entries < d.limits.maxEntriesPerDay },
    { name: "Losing streak", state: `${day.consecutiveLosses} of ${d.limits.maxConsecutiveLosses}`, ok: day.consecutiveLosses < d.limits.maxConsecutiveLosses },
    { name: "Open positions", state: `${open.length} of ${d.limits.maxOpenPositions}`, ok: open.length < d.limits.maxOpenPositions },
    { name: "Unconfirmed limit increases", state: d.limitsRefused.length ? d.limitsRefused.join(", ") : "none", ok: d.limitsRefused.length === 0 },
    { name: "Discovery gate", state: gate.open ? "open" : gate.reasons.join("; "), ok: gate.open },
    { name: "Stale data", state: now - lastUpdate > 120_000 ? `no data for ${Math.round((now - lastUpdate) / 1000)}s` : "fresh", ok: now - lastUpdate <= 120_000 },
  ];

  const events = q<{ at: number; mint: string; strategy: string; action: string; reasons: string }>("SELECT at, mint, strategy, action, reasons FROM decisions WHERE action != 'SNAPSHOT' ORDER BY at DESC LIMIT 20").map((e) => ({ ...e, reasons: JSON.parse(e.reasons) as string[] }));

  const movers = d.movers?.() ?? null;
  const watchlist = d.watched?.() ?? [];
  const watchedSet = new Set(watchlist.map((w) => w.mint));
  // One row per coin checked in the last 24 h: its NEWEST verdict, when, why, and how often it has passed.
  // A coin that passed earlier and failed a re-check shows as rejected, with the time it last passed.
  const review = q<{ mint: string; at: number; verdict: string; rejects: string; total_cost_bps: number | null; stage: string | null; checks: number; passes: number; last_pass: number | null }>(
    `SELECT a.mint, a.at, a.verdict, a.rejects, a.total_cost_bps, a.stage,
            s.checks, s.passes, s.last_pass
       FROM assessments a
       JOIN (SELECT mint, MAX(at) at, COUNT(*) checks, SUM(verdict='PASS') passes, MAX(CASE WHEN verdict='PASS' THEN at END) last_pass
               FROM assessments WHERE at >= ? GROUP BY mint) s ON s.mint = a.mint AND s.at = a.at
      ORDER BY (a.verdict='PASS') DESC, a.at DESC LIMIT 40`,
    now - 24 * 3_600_000,
  ).map((r) => ({
    mint: r.mint,
    at: r.at,
    verdict: r.verdict,
    watched: watchedSet.has(r.mint),
    stage: r.stage,
    costBps: r.total_cost_bps,
    checks: r.checks,
    passes: r.passes,
    lastPass: r.last_pass,
    rules: (JSON.parse(r.rejects) as { rule: string; observed: string; limit: string }[]).map((x) => `${x.rule} (${x.observed}; limit ${x.limit})`),
  }));

  const shownMints = [...recentTokens, ...rejections, ...eligible, ...open, ...watchlist, ...events, ...review].map((x) => x.mint).concat((movers?.list ?? []).map((m) => m.mint).filter((m): m is string => !!m));
  const meta: Record<string, { name: string | null; symbol: string | null; icon: string | null }> = {};
  const chunk = [...new Set(shownMints)];
  if (chunk.length) {
    for (const r of q<{ mint: string; name: string | null; symbol: string | null; icon_url: string | null }>(`SELECT mint, name, symbol, icon_url FROM token_meta WHERE mint IN (${chunk.map(() => "?").join(",")})`, ...chunk)) {
      meta[r.mint] = { name: r.name, symbol: r.symbol, icon: r.icon_url && r.icon_url.startsWith("https://") ? r.icon_url : null };
    }
  }

  return {
    meta,
    review,
    performance,
    movers,
    now,
    mode: d.mode ?? "PAPER",
    liveTradingEnabled: LIVE_TRADING_ENABLED,
    version: SOFTWARE_VERSION,
    lastUpdate,
    gate,
    feeds,
    rpcBudget: d.rpcBudget?.(),
    tokens: { total: tokens?.n ?? 0, confirmed: tokens?.confirmed ?? 0, conflicts: tokens?.conflicts ?? 0, recent: recentTokens },
    assessments: { last24h: assessed24h?.n ?? 0, passed24h: assessed24h?.pass ?? 0, ruleCounts: [...ruleCounts].sort((a, b) => b[1] - a[1]), recentRejections: rejections },
    watchlist,
    signals: eligible,
    positions: open,
    pnl: { realizedSol, realizedCad, unrealizedSol, feesSol, closedCount: closed.length, cashSol: account ? Number(account.cash) / 1e9 : null, startingSol: account ? Number(account.starting) / 1e9 : null, startingCad: account?.startingCad ?? null },
    risk: { day, limits: d.limits, drawdownTodaySol: Number(dd) / 1e9, lossBudgetLeftCad: Math.max(0, d.limits.dailyLossLimitCad - day.realizedLossCad) },
    failedOrders,
    staleQuotesLastHour: staleQuotes,
    breakers,
    events,
  };
}
