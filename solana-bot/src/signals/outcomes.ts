/**
 * Signal scorecard. A "valid setup" is any strategy signal that passed gates
 * 1-7 (data, token safety, liquidity, regime, setup, plan, entry price),
 * whether or not the cost or portfolio gates then let it trade. Each one gets
 * its USD price stamped when first seen and again at 1, 5, 30 minutes and 4 h.
 *
 * Returns are measured against the stamp, not the signal's own reference
 * price, because the stamp is what a person reading the screen could have
 * acted on. Nothing here feeds a trade.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { PriceFetcher } from "../market/prices.ts";

export const HORIZONS: { col: "p_1m" | "p_5m" | "p_30m" | "p_4h"; ms: number; label: string }[] = [
  { col: "p_1m", ms: 60_000, label: "1m" },
  { col: "p_5m", ms: 300_000, label: "5m" },
  { col: "p_30m", ms: 1_800_000, label: "30m" },
  { col: "p_4h", ms: 14_400_000, label: "4h" },
];

/** Gates that come after the setup itself is valid. A signal rejected there is still a signal. */
const AFTER_SETUP = new Set(["COSTS", "SIZING", "PORTFOLIO", "EXECUTION"]);

export class OutcomeTracker {
  public stats = { registered: 0, stamped: 0, priced: 0, errors: 0 };

  constructor(
    private readonly db: DatabaseSync,
    private readonly fetch: PriceFetcher,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}

  /** Register new valid setups from the decisions table. */
  register(): number {
    const now = this.clock.now();
    const rows = this.db
      .prepare(
        `SELECT d.id, d.at, d.mint, d.strategy, d.action, d.signal_json, d.risk_json FROM decisions d
          LEFT JOIN signal_outcomes o ON o.decision_id = d.id
         WHERE o.decision_id IS NULL AND d.signal_json IS NOT NULL AND d.action IN ('PAPER_ELIGIBLE','REJECT') AND d.at >= ? AND d.strategy != 'DRILL'
         ORDER BY d.at`,
      )
      .all(now - 6 * 3_600_000) as { id: number; at: number; mint: string; strategy: string; action: string; signal_json: string; risk_json: string | null }[];
    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO signal_outcomes (decision_id, mint, strategy, at, verdict, expected_move_pct, stop_pct, cost_pct, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    let n = 0;
    for (const r of rows) {
      const risk = r.risk_json ? (JSON.parse(r.risk_json) as { approved: boolean; firstFailure?: string; steps?: { gate: string; ok: boolean; detail: string }[] }) : undefined;
      if (!risk) continue;
      const valid = risk.approved || (risk.firstFailure !== undefined && AFTER_SETUP.has(risk.firstFailure));
      if (!valid) continue;
      const sig = JSON.parse(r.signal_json) as { refPrice?: number; invalidationPrice?: number; expectedMovePct?: number };
      const stop = sig.refPrice && sig.invalidationPrice ? 1 - sig.invalidationPrice / sig.refPrice : null;
      const costStep = risk.steps?.find((x) => x.gate === "COSTS")?.detail ?? "";
      const be = /break-even ([\d.]+)%/.exec(costStep);
      const verdict = risk.approved ? "ENTER" : `SETUP:${risk.firstFailure}`;
      n += Number(ins.run(r.id, r.mint, r.strategy, r.at, verdict, sig.expectedMovePct ?? null, stop, be ? Number(be[1]) / 100 : null, now).changes);
    }
    this.stats.registered += n;
    return n;
  }

  /** Stamp p0 for fresh signals and fill any horizon that is due. One price call per tick. */
  async tick(): Promise<void> {
    this.register();
    const now = this.clock.now();
    const open = this.db.prepare("SELECT * FROM signal_outcomes WHERE at >= ? AND (p0 IS NULL OR p_4h IS NULL)").all(now - 5 * 3_600_000) as {
      decision_id: number; mint: string; at: number; p0: number | null; p0_at: number | null; p_1m: number | null; p_5m: number | null; p_30m: number | null; p_4h: number | null;
    }[];
    const need = new Set<string>();
    for (const o of open) {
      if (o.p0 === null && now - o.at <= 180_000) need.add(o.mint);
      for (const h of HORIZONS) if (o[h.col] === null && now - o.at >= h.ms) need.add(o.mint);
    }
    if (!need.size) return;
    let prices: Map<string, number>;
    try {
      prices = await this.fetch([...need]);
    } catch (e) {
      this.stats.errors++;
      this.logger.warn("signal scoring: price fetch failed", { err: (e as Error).message });
      return;
    }
    for (const o of open) {
      const p = prices.get(o.mint);
      if (!p) continue;
      if (o.p0 === null) {
        if (now - o.at <= 180_000) {
          this.db.prepare("UPDATE signal_outcomes SET p0 = ?, p0_at = ?, updated_at = ? WHERE decision_id = ?").run(p, now, now, o.decision_id);
          this.stats.stamped++;
        }
        continue; // horizons are measured from a stamp; a signal that was never stamped stays unscored
      }
      for (const h of HORIZONS) {
        // Fill a horizon only inside its window (up to 50% late), so a stale fill never stands in for an earlier one.
        if (o[h.col] === null && now - o.at >= h.ms && now - o.at <= h.ms * 1.5 + 60_000) {
          this.db.prepare(`UPDATE signal_outcomes SET ${h.col} = ?, updated_at = ? WHERE decision_id = ?`).run(p, now, o.decision_id);
          this.stats.priced++;
        }
      }
    }
  }

  /** Hit rates per strategy, after the signal's own cost estimate. */
  scorecard(sinceMs = 0): { strategy: string; verdict: string; n: number; stamped: number; horizons: { label: string; n: number; avgRetPct: number; positivePct: number; beatCostPct: number }[] }[] {
    const rows = this.db.prepare("SELECT * FROM signal_outcomes WHERE at >= ?").all(sinceMs) as {
      strategy: string; verdict: string; p0: number | null; p_1m: number | null; p_5m: number | null; p_30m: number | null; p_4h: number | null; cost_pct: number | null;
    }[];
    const groups = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = `${r.strategy}|${r.verdict.startsWith("ENTER") ? "ENTER" : "SETUP"}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
    }
    const out = [];
    for (const [k, list] of groups) {
      const [strategy, verdict] = k.split("|") as [string, string];
      const stamped = list.filter((r) => r.p0 !== null);
      const horizons = HORIZONS.map((h) => {
        const have = stamped.filter((r) => r[h.col] !== null);
        const rets = have.map((r) => r[h.col]! / r.p0! - 1);
        const costs = have.map((r) => r.cost_pct ?? 0.04);
        const n = rets.length;
        return {
          label: h.label,
          n,
          avgRetPct: n ? (rets.reduce((a, b) => a + b, 0) / n) * 100 : 0,
          positivePct: n ? (rets.filter((x) => x > 0).length / n) * 100 : 0,
          beatCostPct: n ? (rets.filter((x, i) => x > costs[i]!).length / n) * 100 : 0,
        };
      });
      out.push({ strategy, verdict, n: list.length, stamped: stamped.length, horizons });
    }
    return out.sort((a, b) => b.n - a.n);
  }
}
