/**
 * Promotion evidence: does any strategy meet the bar for live eligibility?
 *
 *   npm run evidence
 *
 * Reads CLOSED and FAILED paper positions (real quotes, simulated fills) and
 * checks each strategy against the rule in docs/TESTING-GUIDE.md §3:
 *   - at least 100 closed forward-paper trades
 *   - expectancy after costs > 0, and still > 0 with every fill 1% worse
 *   - a 95% confidence lower bound on expectancy above 0
 *   - max drawdown and largest loss inside the risk limits
 *   - trades spread over at least 5 distinct UTC days
 *   - failed and stuck positions included
 * Every strategy starts at NOT ELIGIBLE and stays there until all of this holds.
 */
import { resolve } from "node:path";
import { loadConfig } from "../core/config.ts";
import { DEFAULT_LIMITS } from "../risk/limits.ts";
import { openDb } from "../storage/db.ts";

const MIN_TRADES = 100;
const MIN_DAYS = 5;
const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
// Only mode 'paper' counts. Explore-mode positions ran under looser entry rules and are reported separately.
const rows = db.prepare("SELECT strategy, state, opened_at, closed_at, cost_basis_lamports, proceeds_lamports, realized_pnl_lamports, realized_pnl_cad, sol_cad_at_entry FROM positions WHERE mode = 'paper' AND state IN ('CLOSED','FAILED','STUCK')").all() as {
  strategy: string; state: string; opened_at: number | null; closed_at: number | null; cost_basis_lamports: string; proceeds_lamports: string; realized_pnl_lamports: string | null; realized_pnl_cad: number | null; sol_cad_at_entry: number | null;
}[];
const explore = db.prepare("SELECT COUNT(*) n, SUM(state='FAILED') failed, SUM(realized_pnl_cad) pnl FROM positions WHERE mode = 'paper_explore' AND state IN ('CLOSED','FAILED','STUCK')").get() as { n: number; failed: number | null; pnl: number | null };
const drill = db.prepare("SELECT COUNT(*) n, SUM(state='FAILED') failed, SUM(realized_pnl_cad) pnl FROM positions WHERE mode = 'paper_drill' AND state IN ('CLOSED','FAILED','STUCK')").get() as { n: number; failed: number | null; pnl: number | null };

const out: string[] = [`# Promotion evidence — ${rows.length} resolved paper positions — ${new Date().toISOString()}`];
if (drill.n) out.push(`\nDrill mode: ${drill.n} forced entries (${drill.failed ?? 0} failed), net ${(drill.pnl ?? 0) >= 0 ? "+" : ""}CAD ${(drill.pnl ?? 0).toFixed(2)}. No strategy; NOT counted below.`);
if (explore.n) out.push(`\nExplore mode: ${explore.n} resolved positions (${explore.failed ?? 0} failed entries), net ${(explore.pnl ?? 0) >= 0 ? "+" : ""}CAD ${(explore.pnl ?? 0).toFixed(2)}. Looser entry rules; NOT counted below.`);
const byStrategy = new Map<string, typeof rows>();
for (const r of rows) (byStrategy.get(r.strategy) ?? byStrategy.set(r.strategy, []).get(r.strategy)!).push(r);
if (!byStrategy.size) out.push("\nNo resolved paper positions yet. Every strategy: NOT ELIGIBLE.");
for (const [strategy, list] of byStrategy) {
  const pnlPct = list.map((r) => {
    const basis = Number(r.cost_basis_lamports);
    const pnl = r.realized_pnl_lamports !== null ? Number(r.realized_pnl_lamports) : Number(r.proceeds_lamports) - basis; // STUCK: mark as a full loss of what's unrecovered
    return basis > 0 ? pnl / basis : -1;
  });
  const n = pnlPct.length;
  const mean = pnlPct.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(pnlPct.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : Infinity;
  const lower95 = mean - 1.96 * (sd / Math.sqrt(n));
  const worse = mean - 0.02; // every fill 1% worse on each side
  let eq = 0, peak = 0, dd = 0;
  for (const r of [...list].sort((a, b) => (a.opened_at ?? 0) - (b.opened_at ?? 0))) {
    eq += r.realized_pnl_cad ?? 0;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const largestLoss = Math.min(0, ...list.map((r) => r.realized_pnl_cad ?? 0));
  const days = new Set(list.map((r) => new Date(r.closed_at ?? r.opened_at ?? 0).toISOString().slice(0, 10))).size;
  const stuck = list.filter((r) => r.state === "STUCK").length;
  const failed = list.filter((r) => r.state === "FAILED").length;
  const checks: [string, boolean, string][] = [
    [`>= ${MIN_TRADES} resolved trades`, n >= MIN_TRADES, `${n}`],
    ["expectancy > 0 after costs", mean > 0, `${(mean * 100).toFixed(2)}%`],
    ["expectancy > 0 with fills 1% worse each side", worse > 0, `${(worse * 100).toFixed(2)}%`],
    ["95% lower bound > 0", lower95 > 0, `${(lower95 * 100).toFixed(2)}%`],
    [`max drawdown <= CAD ${DEFAULT_LIMITS.dailyLossLimitCad * 3}`, dd <= DEFAULT_LIMITS.dailyLossLimitCad * 3, `CAD ${dd.toFixed(2)}`],
    [`largest loss >= -CAD ${DEFAULT_LIMITS.maxLossPerTradeCad * 2}`, largestLoss >= -DEFAULT_LIMITS.maxLossPerTradeCad * 2, `CAD ${largestLoss.toFixed(2)}`],
    [`>= ${MIN_DAYS} distinct days`, days >= MIN_DAYS, `${days}`],
  ];
  const eligible = checks.every((c) => c[1]);
  out.push(`\n## ${strategy}: ${eligible ? "ELIGIBLE for a live-readiness review" : "NOT ELIGIBLE"}  (includes ${failed} failed entries, ${stuck} stuck)`);
  for (const [label, ok, v] of checks) out.push(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${v}`);
}
out.push("\nELIGIBLE means the numbers clear the bar. It is not approval. Phases 7 and 8 and your written sign-off come next.");
process.stdout.write(out.join("\n") + "\n");
db.close();
