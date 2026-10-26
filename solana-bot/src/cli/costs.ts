/**
 * Phase 3 cost and tradability report from recorded assessments.
 *
 *   npm run costs
 *   npm run costs -- --hours 6
 *
 * Every cost here comes from executable quotes (buy, then immediately sell the
 * same tokens) plus estimated network fees. It is what a CAD-sized round trip
 * would have cost at that moment, before any price movement. Not a forecast.
 */
import { resolve } from "node:path";
import { loadConfig } from "../core/config.ts";
import { DEFAULT_POLICY } from "../risk/policy.ts";
import { openDb } from "../storage/db.ts";

const args = process.argv.slice(2);
const hIdx = args.indexOf("--hours");
const since = hIdx >= 0 ? Date.now() - Number(args[hIdx + 1]) * 3_600_000 : 0;

const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
const out: string[] = [];

interface Row {
  mint: string;
  verdict: string;
  rejects: string;
  flags: string;
  buy_route: string | null;
  stage: string | null;
  liquidity_usd_reported: number | null;
  total_cost_bps: number | null;
  quote_round_trip_bps: number | null;
  break_even_pct: number | null;
  buy_impact_pct: number | null;
  sell_impact_pct: number | null;
  implied_buy_fee_bps: number | null;
  implied_sell_fee_bps: number | null;
  priority_micro_lamports: number | null;
  sol_cad: number | null;
  size_cad: number | null;
  network_fee_lamports: string | null;
  top10_wallet_pct: number | null;
  creator_pct: number | null;
}
const rows = db.prepare("SELECT * FROM assessments WHERE at >= ? ORDER BY at").all(since) as unknown as Row[];

function pct(arr: number[], p: number): string {
  if (!arr.length) return "-";
  const s = [...arr].sort((a, b) => a - b);
  return String(s[Math.min(s.length - 1, Math.floor(s.length * p))]);
}
function dist(label: string, vals: number[], unit = "bps"): string {
  return `${label.padEnd(26)} n=${String(vals.length).padStart(4)}  p25=${pct(vals, 0.25)} p50=${pct(vals, 0.5)} p75=${pct(vals, 0.75)} p90=${pct(vals, 0.9)} ${unit}`;
}
const band = (usd: number | null) => (usd === null ? "unknown" : usd < 10_000 ? "<$10k" : usd < 50_000 ? "$10k–50k" : usd < 250_000 ? "$50k–250k" : ">$250k");

out.push(`# Tradability and cost report — ${rows.length} assessments${since ? " (window)" : ""} — ${new Date().toISOString()}`);
out.push(`Evaluation size: CAD ${DEFAULT_POLICY.evalSizeCad}. Thresholds are PLACEHOLDERS (src/risk/policy.ts), not validated limits.`);
if (!rows.length) {
  out.push("\nNo assessments yet. Run: npm run discover -- --assess");
} else {
  const pass = rows.filter((r) => r.verdict === "PASS").length;
  out.push(`\nPASS ${pass}   REJECT ${rows.length - pass}   (PASS = no automated check objected; it does not mean safe)`);

  out.push("\n## Why tokens were rejected (a token can fail several rules)");
  const counts = new Map<string, number>();
  for (const r of rows) for (const f of JSON.parse(r.rejects) as { rule: string }[]) counts.set(f.rule, (counts.get(f.rule) ?? 0) + 1);
  for (const [rule, n] of [...counts].sort((a, b) => b[1] - a[1])) out.push(`  ${rule.padEnd(22)} ${n}`);

  const priced = rows.filter((r) => r.total_cost_bps !== null);
  out.push(`\n## Round-trip cost from executable quotes (${priced.length} with both quotes)`);
  out.push("  total = venue fees + price impact both ways + estimated network fees; break-even = price rise needed to get the stake back");
  out.push("  " + dist("all: total cost", priced.map((r) => r.total_cost_bps!)));
  out.push("  " + dist("all: break-even move", priced.map((r) => Math.round(r.break_even_pct! * 100)), "bps"));
  const byVenue = new Map<string, Row[]>();
  for (const r of priced) {
    const v = r.buy_route ?? "?";
    (byVenue.get(v) ?? byVenue.set(v, []).get(v)!).push(r);
  }
  for (const [v, rs] of [...byVenue].sort((a, b) => b[1].length - a[1].length)) out.push("  " + dist(`route ${v.slice(0, 20)}`, rs.map((r) => r.total_cost_bps!)));
  const byBand = new Map<string, Row[]>();
  for (const r of priced) (byBand.get(band(r.liquidity_usd_reported)) ?? byBand.set(band(r.liquidity_usd_reported), []).get(band(r.liquidity_usd_reported))!).push(r);
  for (const b of ["<$10k", "$10k–50k", "$50k–250k", ">$250k", "unknown"]) {
    const rs = byBand.get(b);
    if (rs) out.push("  " + dist(`liquidity ${b} (reported)`, rs.map((r) => r.total_cost_bps!)));
  }
  out.push("  " + dist("buy impact (Jupiter)", priced.map((r) => Math.round(r.buy_impact_pct! * 100))));
  out.push("  " + dist("sell impact (Jupiter)", priced.map((r) => Math.round(r.sell_impact_pct! * 100))));

  const ibf = rows.filter((r) => r.implied_buy_fee_bps !== null).map((r) => r.implied_buy_fee_bps!);
  const isf = rows.filter((r) => r.implied_sell_fee_bps !== null).map((r) => r.implied_sell_fee_bps!);
  out.push(`\n## pump.fun curve fee implied by quotes vs reserves (documented: ${DEFAULT_POLICY.documentedCurveFeeBps} bps per side)`);
  out.push("  " + dist("implied buy fee", ibf));
  out.push("  " + dist("implied sell fee", isf));

  out.push("\n## Inputs");
  out.push("  " + dist("priority fee estimate", rows.map((r) => r.priority_micro_lamports ?? 0), "µlamports/CU"));
  const solCad = rows.map((r) => r.sol_cad).filter((x): x is number => x !== null);
  if (solCad.length) out.push(`  SOL/CAD used: ${Math.min(...solCad).toFixed(2)}–${Math.max(...solCad).toFixed(2)} (Jupiter SOL/USD × Bank of Canada USD/CAD)`);
  const top10 = rows.map((r) => r.top10_wallet_pct).filter((x): x is number => x !== null);
  out.push(`  holder snapshots: ${top10.length}/${rows.length}${top10.length ? `  top-10 wallet share p50=${pct(top10, 0.5)}%` : "  (none: this RPC refused holder data)"}`);
}
process.stdout.write(out.join("\n") + "\n");
db.close();
