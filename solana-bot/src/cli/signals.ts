/**
 * Phase 4 report: trade feed quality, and what the strategies and risk manager decided.
 *
 *   npm run signals
 *   npm run signals -- --hours 2
 *
 * PAPER_ELIGIBLE means every risk gate passed at that moment. No position was
 * opened. It says nothing about whether the trade would have made money.
 */
import { resolve } from "node:path";
import { loadConfig } from "../core/config.ts";
import { openDb } from "../storage/db.ts";

const args = process.argv.slice(2);
const hIdx = args.indexOf("--hours");
const since = hIdx >= 0 ? Date.now() - Number(args[hIdx + 1]) * 3_600_000 : 0;
const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
const q = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as unknown as T[];
const out: string[] = [`# Signals report — ${new Date().toISOString()}`];

const pct = (arr: number[], p: number) => {
  if (!arr.length) return "-";
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!.toFixed(1);
};

out.push("\n## Trade feed (on-chain events from logsSubscribe, confirmed commitment)");
const tokens = q<{ mint: string; venue: string; n: number; buys: number; wallets: number; first: number; last: number }>(
  "SELECT mint, venue, COUNT(*) n, SUM(side='buy') buys, COUNT(DISTINCT wallet) wallets, MIN(block_time_ms) first, MAX(block_time_ms) last FROM trades WHERE received_at >= ? GROUP BY mint, venue ORDER BY n DESC",
  since,
);
for (const t of tokens) out.push(`  ${t.mint} ${t.venue.padEnd(10)} trades=${t.n} buys=${t.buys} wallets=${t.wallets} over ${Math.round((t.last - t.first) / 60_000)} min`);
const lags = q<{ l: number }>("SELECT (received_at - block_time_ms) / 1000.0 l FROM trades WHERE received_at >= ?", since).map((r) => r.l);
out.push(`  arrival lag behind on-chain time (s; on-chain time has 1 s precision): p50=${pct(lags, 0.5)} p90=${pct(lags, 0.9)} max=${pct(lags, 1)} (n=${lags.length})`);

out.push("\n## Data quality at snapshot time");
const snaps = q<{ reasons: string }>("SELECT reasons FROM decisions WHERE action='SNAPSHOT' AND at >= ?", since);
const qc = new Map<string, number>();
let okSnaps = 0;
for (const s of snaps) {
  const r = (JSON.parse(s.reasons) as string[]).slice(2);
  if (!r.length) okSnaps++;
  for (const x of r) {
    const k = x.split(":")[0]!;
    qc.set(k, (qc.get(k) ?? 0) + 1);
  }
}
out.push(`  snapshots: ${snaps.length}, data OK: ${okSnaps}${[...qc].map(([k, v]) => `, ${k}: ${v}`).join("")}`);

out.push("\n## Strategy signals and risk decisions");
for (const r of q<{ strategy: string; action: string; n: number }>("SELECT strategy, action, COUNT(*) n FROM decisions WHERE action != 'SNAPSHOT' AND at >= ? GROUP BY strategy, action ORDER BY strategy", since))
  out.push(`  ${r.strategy.padEnd(22)} ${r.action.padEnd(15)} ${r.n}`);
out.push("\n## First failing risk gate for rejected signals");
const firsts = new Map<string, number>();
for (const r of q<{ risk_json: string }>("SELECT risk_json FROM decisions WHERE action='REJECT' AND at >= ?", since)) {
  const k = (JSON.parse(r.risk_json) as { firstFailure?: string }).firstFailure ?? "?";
  firsts.set(k, (firsts.get(k) ?? 0) + 1);
}
for (const [k, v] of [...firsts].sort((a, b) => b[1] - a[1])) out.push(`  ${k.padEnd(15)} ${v}`);
if (!firsts.size) out.push("  none");

out.push("\n## Most recent signals");
for (const r of q<{ at: number; mint: string; strategy: string; action: string; reasons: string }>(
  "SELECT at, mint, strategy, action, reasons FROM decisions WHERE action != 'SNAPSHOT' AND at >= ? ORDER BY at DESC LIMIT 10",
  since,
))
  out.push(`  ${new Date(r.at).toISOString().slice(11, 19)} ${r.mint.slice(0, 8)} ${r.strategy.padEnd(22)} ${r.action.padEnd(14)} ${(JSON.parse(r.reasons) as string[]).join("; ").slice(0, 140)}`);

out.push("\nPAPER_ELIGIBLE = all risk gates passed at that moment. No position was opened; nothing here shows profit.");
process.stdout.write(out.join("\n") + "\n");
db.close();
