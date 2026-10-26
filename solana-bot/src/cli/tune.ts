/**
 * Threshold search on the TRAIN window, scored on VALIDATION. Never touches TEST.
 *
 *   npm run tune
 *   npm run tune -- --strategy A --worst
 *
 * For each strategy, a small, fixed grid of its binding thresholds is run through
 * the full backtest (strategies, risk manager, exits, modelled fills) on every
 * tape's train window. Candidates are ranked by validation expectancy, with a
 * minimum trade count. The best candidate is WRITTEN TO A CANDIDATE FILE ONLY:
 *   data/strategy-params.candidate.json
 * Adopting it is a manual step (rename to strategy-params.json). Nothing here
 * changes what the live bot does.
 *
 * With a few hours of tape the output is noise. The tool exists so that the
 * same procedure runs unchanged once there are days of tape.
 */
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../core/config.ts";
import { backtestTape, COST_MODELS, COST_MODELS_WORST, splitWindows, summarize, type BacktestTrade } from "../paper/backtest.ts";
import { DEFAULT_LIMITS } from "../risk/limits.ts";
import { openDb } from "../storage/db.ts";
import type { Trade } from "../strategy/features.ts";
import { DEFAULT_PARAMS, type StrategyParams } from "../strategy/params.ts";
import type { StrategyId } from "../strategy/types.ts";

const args = process.argv.slice(2);
const only = (() => {
  const i = args.indexOf("--strategy");
  return i >= 0 ? args[i + 1] : undefined;
})();
const worst = args.includes("--worst");
const MIN_TRADES = 20;

// Fixed grids over the thresholds the calibration report showed as binding.
const GRIDS: Record<"A" | "B" | "C", Record<string, number[]>> = {
  A: { maxConsolidationRangePct: [0.06, 0.1, 0.15], maxTopBuyerShare: [0.3, 0.45, 0.6], maxRepeatedSizeRatio: [0.35, 0.5], targetImpulseFraction: [0.5, 0.75, 1.0] },
  B: { minBreakoutPct: [0.01, 0.02, 0.04], minRateAccel: [1.2, 1.5, 2], targetRangeFraction: [0.5, 1.0] },
  C: { minRateAccel: [1.2, 1.5, 2], minNewBuyers30: [3, 6], targetPct: [0.08, 0.12, 0.2] },
};
const STRATS: Record<"A" | "B" | "C", StrategyId[]> = { A: ["A_continuation"], B: ["B_breakout_retest", "B_breakout_no_retest"], C: ["C_early_acceleration"] };

function* combos(grid: Record<string, number[]>): Generator<Record<string, number>> {
  const keys = Object.keys(grid);
  const idx = keys.map(() => 0);
  for (;;) {
    yield Object.fromEntries(keys.map((k, i) => [k, grid[k]![idx[i]!]!]));
    let i = keys.length - 1;
    while (i >= 0 && ++idx[i]! >= grid[keys[i]!]!.length) idx[i--] = 0;
    if (i < 0) return;
  }
}

let x = 7;
const random = () => {
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return ((x >>> 0) % 1_000_000) / 1_000_000;
};

const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
const solCad = (db.prepare("SELECT sol_cad FROM assessments WHERE sol_cad IS NOT NULL ORDER BY at DESC LIMIT 1").get() as { sol_cad: number } | undefined)?.sol_cad ?? 140;
const mints = db.prepare("SELECT mint, venue, COUNT(*) n, MIN(received_at) a, MAX(received_at) b FROM trades GROUP BY mint, venue HAVING n >= 50").all() as { mint: string; venue: "pump_curve" | "pumpswap"; n: number; a: number; b: number }[];
const gaps = (db.prepare("SELECT from_ms, to_ms FROM gaps WHERE provider IN ('all','solana_ws')").all() as { from_ms: number; to_ms: number }[]).map((g) => ({ from: g.from_ms, to: g.to_ms }));
const tapes = mints.map((m) => {
  const rows = db.prepare("SELECT signature, event_index, slot, block_time_ms, received_at, side, wallet, quote_amount, price_sol, real_quote_reserves FROM trades WHERE mint = ? ORDER BY slot, event_index").all(m.mint) as { signature: string; event_index: number; slot: number; block_time_ms: number; received_at: number; side: "buy" | "sell"; wallet: string; quote_amount: string; price_sol: number; real_quote_reserves: string | null }[];
  const tape: Trade[] = rows.map((r) => ({ mint: m.mint, signature: r.signature, eventIndex: r.event_index, slot: r.slot, blockTimeMs: r.block_time_ms, receivedAt: r.received_at, side: r.side, wallet: r.wallet, quoteSol: Number(r.quote_amount) / 1e9, priceSol: r.price_sol, realQuoteSol: r.real_quote_reserves ? Number(r.real_quote_reserves) / 1e9 : undefined }));
  return { ...m, tape, w: splitWindows(m.a, m.b) };
});

function run(params: StrategyParams, strategies: StrategyId[], window: "train" | "validation"): BacktestTrade[] {
  const out: BacktestTrade[] = [];
  for (const t of tapes) {
    const [s, e] = t.w[window];
    const slice = t.tape.filter((x) => x.receivedAt >= s - 300_000 && x.receivedAt <= e);
    if (slice.length < 30) continue;
    out.push(...backtestTape(t.mint, t.venue, slice, gaps, { limits: DEFAULT_LIMITS, stepMs: 5000, sizeCad: 30, solCad, random, params, strategies, costModels: worst ? COST_MODELS_WORST : COST_MODELS }).trades);
  }
  return out;
}

const out: string[] = [`# Tune (${worst ? "WORST-quartile" : "median"} cost model, MODELLED fills) — ${tapes.length} tapes — ${new Date().toISOString()}`, "Grid on TRAIN, scored on VALIDATION. TEST is not touched. Output is a candidate file, never applied automatically."];
const candidate: Record<string, Record<string, number>> = {};
for (const k of ["A", "B", "C"] as const) {
  if (only && only !== k) continue;
  out.push(`\n## Strategy ${k}`);
  const rows: { combo: Record<string, number>; train: ReturnType<typeof summarize>; val: ReturnType<typeof summarize> }[] = [];
  for (const combo of combos(GRIDS[k])) {
    const params: StrategyParams = { ...DEFAULT_PARAMS, [k]: { ...DEFAULT_PARAMS[k], ...combo } };
    const train = summarize(run(params, STRATS[k], "train"));
    const val = summarize(run(params, STRATS[k], "validation"));
    rows.push({ combo, train, val });
  }
  rows.sort((a, b) => b.val.expectancyPct - a.val.expectancyPct);
  out.push(`  ${"candidate".padEnd(70)} train n/exp      validation n/exp`);
  for (const r of rows.slice(0, 8)) out.push(`  ${JSON.stringify(r.combo).padEnd(70)} ${String(r.train.n).padStart(4)}/${(r.train.expectancyPct * 100).toFixed(2).padStart(6)}%   ${String(r.val.n).padStart(4)}/${(r.val.expectancyPct * 100).toFixed(2).padStart(6)}%`);
  const best = rows.find((r) => r.train.n >= MIN_TRADES && r.val.n >= MIN_TRADES && r.train.expectancyPct > 0 && r.val.expectancyPct > 0);
  if (best) {
    candidate[k] = best.combo;
    out.push(`  candidate: ${JSON.stringify(best.combo)} (train ${best.train.n} trades, validation ${best.val.n} trades, both positive)`);
  } else out.push(`  no candidate: nothing reached ${MIN_TRADES} trades with positive expectancy on BOTH windows. Keep defaults; record more tape.`);
}
if (Object.keys(candidate).length) {
  const file = resolve(cfg.DATA_DIR, "strategy-params.candidate.json");
  writeFileSync(file, JSON.stringify({ note: `tune ${new Date().toISOString()} ${worst ? "worst" : "median"} model; review before adopting`, ...candidate }, null, 2));
  out.push(`\nWrote ${file}. To adopt: review it, then rename to strategy-params.json and restart the bot. Then judge it ONCE on the test window with npm run backtest.`);
}
process.stdout.write(out.join("\n") + "\n");
db.close();
