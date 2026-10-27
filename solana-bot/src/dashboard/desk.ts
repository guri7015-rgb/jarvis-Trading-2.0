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

  const meta: Record<string, { name: string | null; symbol: string | null; icon: string | null }> = {};
  const movers = d.movers?.() ?? null;
  const mints = [...new Set([...signals.map((s) => s.mint), ...((movers?.list ?? []) as { mint?: string }[]).map((m) => m.mint).filter((m): m is string => !!m)])];
  if (mints.length) {
    for (const r of q<{ mint: string; name: string | null; symbol: string | null; icon_url: string | null }>(`SELECT mint, name, symbol, icon_url FROM token_meta WHERE mint IN (${mints.map(() => "?").join(",")})`, ...mints)) {
      meta[r.mint] = { name: r.name, symbol: r.symbol, icon: r.icon_url && r.icon_url.startsWith("https://") ? r.icon_url : null };
    }
  }

  return {
    now,
    mode: d.mode ?? "PAPER",
    signals,
    meta,
    movers,
    watchlist: d.watched?.() ?? [],
    scorecard: d.outcomes?.scorecard(now - 7 * 86_400_000) ?? [],
    scoringStats: d.outcomes?.stats ?? null,
    majors: d.majors?.snapshot() ?? null,
  };
}
