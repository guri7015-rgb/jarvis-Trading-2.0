/**
 * Backtest the recorded tapes with modelled costs.
 *
 *   npm run backtest
 *   npm run backtest -- --seed 7 --step 5
 *   npm run backtest -- --explore      (explore-mode limits, params and quality rules)
 *
 * Fills are MODELLED (no historical quotes exist). The report splits each
 * tape by time into train / validation / test and reports each separately,
 * so a threshold tuned on train can be judged on data it never saw.
 */
import { resolve } from "node:path";
import { loadConfig } from "../core/config.ts";
import { backtestTape, splitWindows, summarize, type BacktestTrade } from "../paper/backtest.ts";
import { DEFAULT_LIMITS, EXPLORE_LIMITS } from "../risk/limits.ts";
import { DEFAULT_PARAMS, EXPLORE_PARAMS, EXPLORE_QUALITY } from "../strategy/params.ts";
import { openDb } from "../storage/db.ts";
import type { Trade } from "../strategy/features.ts";

const args = process.argv.slice(2);
const arg = (k: string, d: number) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const seed = arg("--seed", 1);
const stepMs = arg("--step", 5) * 1000;
const explore = args.includes("--explore");
// Deterministic PRNG so a run can be repeated.
let x = seed >>> 0 || 1;
const random = () => {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return ((x >>> 0) % 1_000_000) / 1_000_000;
};

const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
const solCad = (db.prepare("SELECT sol_cad FROM assessments WHERE sol_cad IS NOT NULL ORDER BY at DESC LIMIT 1").get() as { sol_cad: number } | undefined)?.sol_cad ?? 140;
const mints = db.prepare("SELECT mint, venue, COUNT(*) n, MIN(received_at) a, MAX(received_at) b FROM trades GROUP BY mint, venue HAVING n >= 50 ORDER BY n DESC").all() as { mint: string; venue: "pump_curve" | "pumpswap"; n: number; a: number; b: number }[];
const gaps = (db.prepare("SELECT from_ms, to_ms FROM gaps WHERE provider IN ('all','solana_ws')").all() as { from_ms: number; to_ms: number }[]).map((g) => ({ from: g.from_ms, to: g.to_ms }));

const out: string[] = [`# Backtest (${explore ? "EXPLORE rules, " : ""}MODELLED fills, seed ${seed}, step ${stepMs / 1000}s, size CAD ${30} at SOL/CAD ${solCad.toFixed(2)}) — ${new Date().toISOString()}`];
out.push("Costs per venue are from Phase 3 measurements; latency 4–12 s; 10% fill failures; 1–2% no-route. Nothing here is a forecast.");
const all: Record<"train" | "validation" | "test", BacktestTrade[]> = { train: [], validation: [], test: [] };
let totalSteps = 0;
let totalSignals = 0;
const rejected: Record<string, number> = {};

for (const m of mints) {
  const rows = db.prepare("SELECT signature, event_index, slot, block_time_ms, received_at, side, wallet, quote_amount, price_sol, real_quote_reserves FROM trades WHERE mint = ? ORDER BY slot, event_index").all(m.mint) as { signature: string; event_index: number; slot: number; block_time_ms: number; received_at: number; side: "buy" | "sell"; wallet: string; quote_amount: string; price_sol: number; real_quote_reserves: string | null }[];
  const tape: Trade[] = rows.map((r) => ({ mint: m.mint, signature: r.signature, eventIndex: r.event_index, slot: r.slot, blockTimeMs: r.block_time_ms, receivedAt: r.received_at, side: r.side, wallet: r.wallet, quoteSol: Number(r.quote_amount) / 1e9, priceSol: r.price_sol, realQuoteSol: r.real_quote_reserves ? Number(r.real_quote_reserves) / 1e9 : undefined }));
  const w = splitWindows(m.a, m.b);
  out.push(`\n## ${m.mint} (${m.venue}) trades=${m.n} span=${Math.round((m.b - m.a) / 60_000)} min`);
  for (const k of ["train", "validation", "test"] as const) {
    const [s, e] = w[k];
    // Each window sees only its own trades plus 5 min of warm-up before it (visible by arrival time, as live).
    const slice = tape.filter((t) => t.receivedAt >= s - 300_000 && t.receivedAt <= e);
    if (slice.length < 30) {
      out.push(`  ${k}: too few trades (${slice.length})`);
      continue;
    }
    const r = backtestTape(m.mint, m.venue, slice, gaps, { limits: explore ? EXPLORE_LIMITS : DEFAULT_LIMITS, params: explore ? EXPLORE_PARAMS : DEFAULT_PARAMS, quality: explore ? EXPLORE_QUALITY : undefined, stepMs, sizeCad: 30, solCad, random });
    totalSteps += r.steps;
    totalSignals += r.signals;
    for (const [g, n] of Object.entries(r.rejectedByGate)) rejected[g] = (rejected[g] ?? 0) + n;
    if (args.includes("--why")) for (const x of r.rejections) out.push(`    ${new Date(x.at).toISOString().slice(11, 19)} ${x.strategy.padEnd(22)} ${x.gate.padEnd(12)} ${x.detail}`);
    const st = summarize(r.trades);
    all[k].push(...r.trades);
    out.push(`  ${k.padEnd(10)} steps=${r.steps} signals=${r.signals} trades=${st.n} net=${st.netPnlSol.toFixed(4)} SOL exp=${(st.expectancyPct * 100).toFixed(2)}%/trade`);
  }
}

out.push("\n## Summary by window (MODELLED)");
for (const k of ["train", "validation", "test"] as const) {
  const st = summarize(all[k]);
  out.push(`\n### ${k}: ${st.n} trades`);
  if (!st.n) {
    out.push("  no trades");
    continue;
  }
  out.push(`  win rate ${(st.winRate * 100).toFixed(0)}%  avg win ${(st.avgWinPct * 100).toFixed(2)}%  avg loss ${(st.avgLossPct * 100).toFixed(2)}%  expectancy ${(st.expectancyPct * 100).toFixed(2)}%/trade  profit factor ${st.profitFactor.toFixed(2)}`);
  out.push(`  net ${st.netPnlSol.toFixed(4)} SOL (CAD ${(st.netPnlSol * solCad).toFixed(2)})  max drawdown ${st.maxDrawdownSol.toFixed(4)} SOL  largest loss ${st.largestLossSol.toFixed(4)} SOL  max consecutive losses ${st.maxConsecutiveLosses}  time in market ${Math.round(st.timeInMarketMs / 60_000)} min`);
  for (const [s, b] of Object.entries(st.byStrategy)) out.push(`  ${s.padEnd(22)} n=${b.n} net=${b.netPnlSol.toFixed(4)} SOL win=${(b.winRate * 100).toFixed(0)}%`);
  out.push(`  exits: ${Object.entries(st.byReason).map(([r, n]) => `${r}=${n}`).join(", ")}`);
}
out.push(`\nSteps ${totalSteps}, signals ${totalSignals}, rejected by gate: ${JSON.stringify(rejected)}`);
out.push("\nA strategy earns a forward test only if validation AND test are positive after costs with a meaningful sample. Tuning on test is not allowed.");
process.stdout.write(out.join("\n") + "\n");
db.close();
