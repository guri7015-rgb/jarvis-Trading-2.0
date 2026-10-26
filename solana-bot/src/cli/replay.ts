/**
 * Replay the recorded trade tape through the features and strategies.
 *
 *   npm run replay                 # every token with stored trades
 *   npm run replay -- --step 5     # decision step in seconds (default 5)
 *
 * This is a SIGNAL COUNT, not a backtest: it says how often each strategy
 * would have fired on the recorded data, with the same arrival-time look-ahead
 * guard the live engine uses. No fills, no costs, no P&L. Phase 5 adds those.
 */
import { resolve } from "node:path";
import { loadConfig } from "../core/config.ts";
import { openDb } from "../storage/db.ts";
import { computeFeatures, type Trade } from "../strategy/features.ts";
import { strategyA } from "../strategy/strategyA.ts";
import { strategyB } from "../strategy/strategyB.ts";
import { strategyC } from "../strategy/strategyC.ts";
import { strategyD } from "../strategy/strategyD.ts";

const args = process.argv.slice(2);
const sIdx = args.indexOf("--step");
const stepMs = (sIdx >= 0 ? Number(args[sIdx + 1]) : 5) * 1000;
const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));

const mints = (db.prepare("SELECT mint, COUNT(*) n, MIN(received_at) a, MAX(received_at) b FROM trades GROUP BY mint ORDER BY n DESC").all() as { mint: string; n: number; a: number; b: number }[]);
const gaps = (db.prepare("SELECT from_ms, to_ms FROM gaps WHERE provider IN ('all','solana_ws')").all() as { from_ms: number; to_ms: number }[]).map((g) => ({ from: g.from_ms, to: g.to_ms }));
const out: string[] = [`# Replay (signal counts only, step ${stepMs / 1000}s) — ${new Date().toISOString()}`];

for (const m of mints) {
  const rows = db
    .prepare("SELECT signature, event_index, slot, block_time_ms, received_at, side, wallet, quote_amount, price_sol, real_quote_reserves FROM trades WHERE mint = ? ORDER BY slot, event_index")
    .all(m.mint) as { signature: string; event_index: number; slot: number; block_time_ms: number; received_at: number; side: "buy" | "sell"; wallet: string; quote_amount: string; price_sol: number; real_quote_reserves: string | null }[];
  const tape: Trade[] = rows.map((r) => ({
    mint: m.mint,
    signature: r.signature,
    eventIndex: r.event_index,
    slot: r.slot,
    blockTimeMs: r.block_time_ms,
    receivedAt: r.received_at,
    side: r.side,
    wallet: r.wallet,
    quoteSol: Number(r.quote_amount) / 1e9,
    priceSol: r.price_sol,
    realQuoteSol: r.real_quote_reserves ? Number(r.real_quote_reserves) / 1e9 : undefined,
  }));
  const counts = { steps: 0, dataOk: 0, A: 0, B_retest: 0, B_no_retest: 0, C: 0, D_veto: 0 };
  const firstReasons = new Map<string, number>();
  for (let now = m.a + 60_000; now <= m.b; now += stepMs) {
    counts.steps++;
    const f = computeFeatures(m.mint, tape.filter((t) => t.blockTimeMs >= now - 300_000), now, gaps);
    if (f.quality.ok) counts.dataOk++;
    if (strategyD(f).action === "VETO") counts.D_veto++;
    const sigs = { A: strategyA(f, {}), B_retest: strategyB(f, {}, "retest"), B_no_retest: strategyB(f, {}, "no_retest"), C: strategyC(f, { tokenAgeMs: 60 * 60_000 }) };
    for (const [k, s] of Object.entries(sigs)) {
      if (s.action === "ENTER") counts[k as keyof typeof counts]++;
      else {
        const r = `${k}: ${s.reasons[0]?.split("(")[0]?.trim() ?? "?"}`;
        firstReasons.set(r, (firstReasons.get(r) ?? 0) + 1);
      }
    }
  }
  out.push(`\n## ${m.mint}  trades=${m.n}  span=${Math.round((m.b - m.a) / 60_000)} min`);
  out.push(`  steps=${counts.steps} dataOk=${counts.dataOk}  signals: A=${counts.A} B_retest=${counts.B_retest} B_no_retest=${counts.B_no_retest} C=${counts.C}  D vetoes=${counts.D_veto}`);
  out.push("  why not (top reasons):");
  for (const [k, v] of [...firstReasons].sort((a, b) => b[1] - a[1]).slice(0, 8)) out.push(`    ${String(v).padStart(5)}  ${k}`);
}
out.push("\nC was given a fake token age of 60 min here, so its 'not new' reason is expected; live, age comes from the registry.");
process.stdout.write(out.join("\n") + "\n");
db.close();
