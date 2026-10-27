/**
 * Why isn't a pattern firing? Replays every strategy over the feature
 * snapshots the engine stores for watched coins (one per coin per 30 s) and
 * tallies the first reason each strategy said no.
 *
 *   npm run why
 *   npm run why -- --hours 6
 */
import { resolve } from "node:path";
import { loadConfig } from "../core/config.ts";
import { openDb } from "../storage/db.ts";
import { EXPLORE_PARAMS, DEFAULT_PARAMS } from "../strategy/params.ts";
import { strategyA } from "../strategy/strategyA.ts";
import { strategyB } from "../strategy/strategyB.ts";
import { strategyC } from "../strategy/strategyC.ts";
import { strategyE } from "../strategy/strategyE.ts";
import type { Features } from "../strategy/features.ts";

const args = process.argv.slice(2);
const hIdx = args.indexOf("--hours");
const hours = hIdx >= 0 ? Number(args[hIdx + 1]) : 3;
const P = args.includes("--default") ? DEFAULT_PARAMS : EXPLORE_PARAMS;
const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
const since = Date.now() - hours * 3_600_000;
const rows = db.prepare("SELECT d.at, d.mint, d.features_json, t.created_at FROM decisions d JOIN tokens t ON t.mint = d.mint WHERE d.action = 'SNAPSHOT' AND d.features_json IS NOT NULL AND d.at >= ?").all(since) as { at: number; mint: string; features_json: string; created_at: number | null }[];
const norm = (s: string) => s.replace(/-?[\d.]+%?/g, "N").replace(/\(N\)/g, "(N)");
const tally = new Map<string, Map<string, number>>();
const bump = (s: string, k: string) => {
  const m = tally.get(s) ?? tally.set(s, new Map()).get(s)!;
  m.set(k, (m.get(k) ?? 0) + 1);
};
let young = 0;
const mints = new Set<string>();
for (const r of rows) {
  const f = JSON.parse(r.features_json) as Features;
  mints.add(r.mint);
  const age = r.created_at ? r.at - r.created_at : undefined;
  if (age !== undefined && age <= P.C.maxTokenAgeMs) young++;
  const ctx = { tokenAgeMs: age };
  for (const [name, sig] of [
    ["A", strategyA(f, ctx, P.A)],
    ["B retest", strategyB(f, ctx, "retest", P.B)],
    ["B no-retest", strategyB(f, ctx, "no_retest", P.B)],
    ["C early", strategyC(f, ctx, P.C)],
    ["E dip", strategyE(f, ctx, P.E)],
  ] as const) bump(name, sig.action === "ENTER" ? "ENTER (setup present)" : norm(sig.reasons[0] ?? "?"));
}
const out = [`# Why patterns did or didn't fire — last ${hours} h — ${rows.length} snapshots on ${mints.size} coins — ${young} snapshots on coins under ${P.C.maxTokenAgeMs / 60_000} min old — ${P === EXPLORE_PARAMS ? "explore" : "default"} params`];
if (!rows.length) out.push("\nNo snapshots. The engine writes one per watched coin every 30 s while --signals runs.");
for (const [s, m] of tally) {
  out.push(`\n## ${s}`);
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  for (const [k, n] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 8)) out.push(`  ${String(Math.round((100 * n) / total)).padStart(3)}%  ${k}`);
}
out.push("\nThe first reason only. Fix the top one and the next appears. 'N' stands in for the numbers.");
process.stdout.write(out.join("\n") + "\n");
db.close();
