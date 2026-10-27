/**
 * The desk: what to look at right now. Entries that cleared every gate,
 * setups that were valid but blocked by cost, the scanner's movers, the
 * majors' long/short plans, and the measured scorecard. Read-only.
 */
import type { DatabaseSync } from "node:sqlite";
import type { OutcomeTracker } from "../signals/outcomes.ts";
import type { MajorsDesk } from "../majors/majors.ts";

export interface DeskDeps {
  db: DatabaseSync;
  outcomes?: OutcomeTracker;
  majors?: MajorsDesk;
  movers?: () => { list: unknown[]; stats: Record<string, number> };
  /** Distinct buying wallets in the scanner's last 60 s for a mint (for launch cards). */
  buyersFor?: (mint: string) => number;
  watched?: () => { mint: string; venue: string; researchOnly: boolean; addedAt: number }[];
  mode?: string;
  now: () => number;
}

const AFTER_SETUP = new Set(["COSTS", "SIZING", "PORTFOLIO", "EXECUTION"]);

export function deskState(d: DeskDeps) {
  const now = d.now();
  const q = <T>(sql: string, ...p: (string | number)[]) => d.db.prepare(sql).all(...p) as unknown as T[];

  const rows = q<{ id: number; at: number; mint: string; strategy: string; action: string; reasons: string; signal_json: string | null; risk_json: string | null }>(
    "SELECT id, at, mint, strategy, action, reasons, signal_json, risk_json FROM decisions WHERE signal_json IS NOT NULL AND action IN ('PAPER_ELIGIBLE','REJECT') AND at >= ? ORDER BY at DESC LIMIT 60",
    now - 3 * 3_600_000,
  );
  const outcomes = new Map(q<{ decision_id: number; p0: number | null; p_1m: number | null; p_5m: number | null; p_30m: number | null; p_4h: number | null }>("SELECT decision_id, p0, p_1m, p_5m, p_30m, p_4h FROM signal_outcomes WHERE at >= ?", now - 3 * 3_600_000).map((o) => [o.decision_id, o]));
  const signals = [];
  for (const r of rows) {
    const sig = JSON.parse(r.signal_json!) as { refPrice?: number; maxEntryPrice?: number; invalidationPrice?: number; targetPrice?: number; expectedMovePct?: number; timeStopMs?: number; reasons: string[] };
    const risk = r.risk_json ? (JSON.parse(r.risk_json) as { approved: boolean; firstFailure?: string; sizeCad?: number; plannedLossCad?: number; rewardToRisk?: number; steps?: { gate: string; ok: boolean; detail: string }[] }) : undefined;
    if (!risk) continue;
    const valid = risk.approved || (risk.firstFailure !== undefined && AFTER_SETUP.has(risk.firstFailure));
    if (!valid && r.strategy !== "DRILL") continue;
    const o = outcomes.get(r.id);
    const ret = (p: number | null | undefined) => (o?.p0 && p ? (p / o.p0 - 1) * 100 : null);
    signals.push({
      id: r.id,
      at: r.at,
      ageS: Math.round((now - r.at) / 1000),
      mint: r.mint,
      strategy: r.strategy,
      kind: risk.approved ? "ENTER" : "SETUP",
      blockedBy: risk.approved ? null : risk.firstFailure ?? null,
      blockedDetail: risk.approved ? null : risk.steps?.find((x) => !x.ok)?.detail ?? null,
      why: sig.reasons,
      refPrice: sig.refPrice ?? null,
      maxEntryPrice: sig.maxEntryPrice ?? null,
      stop: sig.invalidationPrice ?? null,
      target: sig.targetPrice ?? null,
      stopPct: sig.refPrice && sig.invalidationPrice ? (1 - sig.invalidationPrice / sig.refPrice) * 100 : null,
      targetPct: sig.expectedMovePct !== undefined ? sig.expectedMovePct * 100 : null,
      timeStopS: sig.timeStopMs ? sig.timeStopMs / 1000 : null,
      sizeCad: risk.sizeCad ?? null,
      plannedLossCad: risk.plannedLossCad ?? null,
      rewardToRisk: risk.rewardToRisk ?? null,
      outcome: o ? { stamped: o.p0 !== null, r1m: ret(o.p_1m), r5m: ret(o.p_5m), r30m: ret(o.p_30m), r4h: ret(o.p_4h) } : null,
    });
  }

  // The board: a coin's stage right now. LAUNCHED (last 3 min) -> PASSED QUICK TEST -> BUY EARLY (C) / DIP HUNT (E) -> SELL (D fired).
  const launched = q<{ mint: string; first_observed_at: number; confirm_status: string; stage: string; launch_venue: string | null }>(
    "SELECT mint, first_observed_at, confirm_status, stage, launch_venue FROM tokens WHERE first_observed_at >= ? ORDER BY first_observed_at DESC LIMIT 15",
    now - 180_000,
  ).map((t) => ({ mint: t.mint, ageS: Math.round((now - t.first_observed_at) / 1000), confirmed: t.confirm_status === "CONFIRMED", stage: t.stage, venue: t.launch_venue, buyers60: d.buyersFor?.(t.mint) ?? null }));
  const quickPassed = q<{ mint: string; at: number; verdict: string; rejects: string; total_cost_bps: number | null; candidate_source: string | null }>(
    `SELECT a.mint, a.at, a.verdict, a.rejects, a.total_cost_bps, a.candidate_source FROM assessments a
       JOIN (SELECT mint, MAX(at) at FROM assessments WHERE at >= ? GROUP BY mint) m ON m.mint = a.mint AND m.at = a.at ORDER BY a.at DESC LIMIT 40`,
    now - 15 * 60_000,
  )
    .map((r) => {
      const rejects = JSON.parse(r.rejects) as { rule: string; kind: string; observed: string }[];
      const clean = r.verdict === "PASS" || (rejects.length > 0 && rejects.every((x) => x.kind === "data"));
      return { mint: r.mint, at: r.at, ageS: Math.round((now - r.at) / 1000), full: r.verdict === "PASS", clean, quick: !!r.candidate_source?.endsWith(":quick"), costBps: r.total_cost_bps, waitingOn: rejects.filter((x) => x.kind === "data").map((x) => x.rule), buyers60: d.buyersFor?.(r.mint) ?? null };
    })
    .filter((r) => r.clean)
    .slice(0, 15);
  const sells = q<{ at: number; mint: string; reasons: string }>("SELECT at, mint, reasons FROM decisions WHERE action = 'SELL' AND at >= ? ORDER BY at DESC LIMIT 40", now - 10 * 60_000);
  const seenSell = new Set<string>();
  const sell = sells.filter((x) => (seenSell.has(x.mint) ? false : (seenSell.add(x.mint), true))).slice(0, 10).map((x) => ({ mint: x.mint, at: x.at, ageS: Math.round((now - x.at) / 1000), reasons: JSON.parse(x.reasons) as string[] }));
  const recentSignals = signals.filter((x) => x.ageS <= 600);
  const board = {
    launched,
    quickPassed,
    buyEarly: recentSignals.filter((x) => x.strategy === "C_early_acceleration"),
    dipHunt: recentSignals.filter((x) => x.strategy === "E_dip_hunt"),
    other: recentSignals.filter((x) => x.strategy !== "C_early_acceleration" && x.strategy !== "E_dip_hunt" && x.strategy !== "DRILL"),
    sell,
  };

  const meta: Record<string, { name: string | null; symbol: string | null; icon: string | null }> = {};
  const movers = d.movers?.() ?? null;
  const mints = [...new Set([...signals.map((s) => s.mint), ...launched.map((t) => t.mint), ...quickPassed.map((t) => t.mint), ...sell.map((t) => t.mint), ...((movers?.list ?? []) as { mint?: string }[]).map((m) => m.mint).filter((m): m is string => !!m)])];
  // Live price per coin on screen: the newest trade we hold for it.
  const live: Record<string, { price: number; at: number }> = {};
  if (mints.length) {
    for (const r of q<{ mint: string; price_sol: number; received_at: number }>(`SELECT t.mint, t.price_sol, t.received_at FROM trades t JOIN (SELECT mint, MAX(id) id FROM trades WHERE mint IN (${mints.map(() => "?").join(",")}) GROUP BY mint) m ON m.id = t.id`, ...mints)) {
      live[r.mint] = { price: r.price_sol, at: r.received_at };
    }
  }
  if (mints.length) {
    for (const r of q<{ mint: string; name: string | null; symbol: string | null; icon_url: string | null }>(`SELECT mint, name, symbol, icon_url FROM token_meta WHERE mint IN (${mints.map(() => "?").join(",")})`, ...mints)) {
      meta[r.mint] = { name: r.name, symbol: r.symbol, icon: r.icon_url && r.icon_url.startsWith("https://") ? r.icon_url : null };
    }
  }

  return {
    now,
    mode: d.mode ?? "PAPER",
    signals,
    board,
    live,
    meta,
    movers,
    watchlist: d.watched?.() ?? [],
    scorecard: d.outcomes?.scorecard(now - 7 * 86_400_000) ?? [],
    scoringStats: d.outcomes?.stats ?? null,
    majors: d.majors?.snapshot() ?? null,
    /** How busy the meme-coin market is right now, from the firehose. */
    memeActivity: movers ? { txSeen: movers.stats.messages ?? 0, failedTx: movers.stats.failedTxs ?? 0, coinsTracked: movers.stats.keys ?? 0, moversNow: movers.list.length } : null,
    noNews: "Price and trade data only. No news feed is connected.",
  };
}
