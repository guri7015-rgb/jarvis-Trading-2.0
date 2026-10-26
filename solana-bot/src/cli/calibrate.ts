/**
 * Calibration report: what the recorded tapes look like against each strategy
 * threshold. It changes nothing. It shows which placeholder rules block every
 * signal, and where the real distributions sit, so thresholds can be set from
 * data on a TRAIN window and judged on data they never saw.
 *
 *   npm run calibrate
 *   npm run calibrate -- --step 5
 */
import { resolve } from "node:path";
import { loadConfig } from "../core/config.ts";
import { openDb } from "../storage/db.ts";
import { computeFeatures, visible, type Features, type Trade } from "../strategy/features.ts";
import { A_PARAMS } from "../strategy/strategyA.ts";
import { B_PARAMS } from "../strategy/strategyB.ts";
import { C_PARAMS } from "../strategy/strategyC.ts";
import { D_PARAMS } from "../strategy/strategyD.ts";

const args = process.argv.slice(2);
const sIdx = args.indexOf("--step");
const stepMs = (sIdx >= 0 ? Number(args[sIdx + 1]) : 5) * 1000;
const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));

const mints = db.prepare("SELECT mint, venue, COUNT(*) n, MIN(received_at) a, MAX(received_at) b FROM trades GROUP BY mint, venue HAVING n >= 50 ORDER BY n DESC").all() as { mint: string; venue: string; n: number; a: number; b: number }[];
const gaps = (db.prepare("SELECT from_ms, to_ms FROM gaps WHERE provider IN ('all','solana_ws')").all() as { from_ms: number; to_ms: number }[]).map((g) => ({ from: g.from_ms, to: g.to_ms }));

const samples: Features[] = [];
for (const m of mints) {
  const rows = db.prepare("SELECT signature, event_index, slot, block_time_ms, received_at, side, wallet, quote_amount, price_sol, real_quote_reserves FROM trades WHERE mint = ? ORDER BY slot, event_index").all(m.mint) as { signature: string; event_index: number; slot: number; block_time_ms: number; received_at: number; side: "buy" | "sell"; wallet: string; quote_amount: string; price_sol: number; real_quote_reserves: string | null }[];
  const tape: Trade[] = rows.map((r) => ({ mint: m.mint, signature: r.signature, eventIndex: r.event_index, slot: r.slot, blockTimeMs: r.block_time_ms, receivedAt: r.received_at, side: r.side, wallet: r.wallet, quoteSol: Number(r.quote_amount) / 1e9, priceSol: r.price_sol, realQuoteSol: r.real_quote_reserves ? Number(r.real_quote_reserves) / 1e9 : undefined }));
  for (let now = m.a + 60_000; now <= m.b; now += stepMs) {
    const f = computeFeatures(m.mint, visible(tape, now).filter((t) => t.blockTimeMs >= now - 300_000), now, gaps);
    if (f.quality.ok) samples.push(f);
  }
}

const pct = (arr: number[], p: number) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]!;
};
const num = (f: (x: Features) => number | null) => samples.map(f).filter((v): v is number => v !== null && Number.isFinite(v));
const fmtPct = (v: number) => (Number.isNaN(v) ? "-" : (v * 100).toFixed(1) + "%");
const fmt = (v: number) => (Number.isNaN(v) ? "-" : v.toFixed(2));
const line = (label: string, vals: number[], limit: string, passShare: number, asPct = true) =>
  `  ${label.padEnd(34)} p10=${(asPct ? fmtPct : fmt)(pct(vals, 0.1)).padStart(7)} p50=${(asPct ? fmtPct : fmt)(pct(vals, 0.5)).padStart(7)} p90=${(asPct ? fmtPct : fmt)(pct(vals, 0.9)).padStart(7)}   rule: ${limit.padEnd(14)} passes: ${(passShare * 100).toFixed(0)}%`;
const share = (vals: number[], ok: (v: number) => boolean) => (vals.length ? vals.filter(ok).length / vals.length : 0);

const out: string[] = [`# Calibration report — ${samples.length} usable 5-second snapshots across ${mints.length} tokens — ${new Date().toISOString()}`];
out.push("Shows where the recorded data sits against each placeholder threshold. It changes nothing. Tune on a train window only; see docs/TESTING-GUIDE.md.");
if (!samples.length) out.push("\nNo usable snapshots. Run discovery with --signals to record trade tapes first.");
else {
  const impulse = num((f) => (f.priorHigh && f.priorLow ? f.priorHigh / f.priorLow - 1 : null));
  const base = num((f) => (f.baseHigh && f.baseLow ? f.baseHigh / f.baseLow - 1 : null));
  const retrace = num((f) => (f.priorHigh && f.priorLow && f.baseLow && f.priorHigh > f.priorLow ? (f.priorHigh - f.baseLow) / (f.priorHigh - f.priorLow) : null));
  const buyers60 = num((f) => f.buyers60);
  const top = num((f) => f.topBuyerShare60);
  const rep = num((f) => f.repeatedSizeRatio60);
  const range = impulse; // same window as B's range
  const brk = num((f) => (f.high60 && f.priorHigh ? f.high60 / f.priorHigh - 1 : null));
  const accel = num((f) => f.rateAccel);
  const imb = num((f) => f.imbalance60);
  const trades30 = num((f) => f.trades30);
  const newBuyers = num((f) => f.newBuyers30);
  const ret60 = num((f) => f.ret60);
  const ret30 = num((f) => f.ret30);
  const sellers = num((f) => f.sellers60);

  out.push("\n## Strategy A: continuation after consolidation");
  out.push(line("prior impulse (−300s..−60s)", impulse, `>= ${fmtPct(A_PARAMS.minImpulsePct)}`, share(impulse, (v) => v >= A_PARAMS.minImpulsePct)));
  out.push(line("base range (−60s..−10s)", base, `<= ${fmtPct(A_PARAMS.maxConsolidationRangePct)}`, share(base, (v) => v <= A_PARAMS.maxConsolidationRangePct)));
  out.push(line("retrace of impulse", retrace, `<= ${fmtPct(A_PARAMS.maxRetraceOfImpulse)}`, share(retrace, (v) => v <= A_PARAMS.maxRetraceOfImpulse)));
  out.push(line("buyers / 60s", buyers60, `>= ${A_PARAMS.minBuyers60}`, share(buyers60, (v) => v >= A_PARAMS.minBuyers60), false));
  out.push(line("top buyer share / 60s", top, `<= ${fmtPct(A_PARAMS.maxTopBuyerShare)}`, share(top, (v) => v <= A_PARAMS.maxTopBuyerShare)));
  out.push(line("repeated-size ratio / 60s", rep, `<= ${fmtPct(A_PARAMS.maxRepeatedSizeRatio)}`, share(rep, (v) => v <= A_PARAMS.maxRepeatedSizeRatio)));
  const aAll = samples.filter((f) => f.priorHigh && f.priorLow && f.baseHigh && f.baseLow && f.priorHigh / f.priorLow - 1 >= A_PARAMS.minImpulsePct && f.baseHigh / f.baseLow - 1 <= A_PARAMS.maxConsolidationRangePct).length;
  out.push(`  snapshots with BOTH an impulse and a tight base: ${aAll} of ${samples.length}`);

  out.push("\n## Strategy B: breakout and retest");
  out.push(line("range width (−300s..−60s)", range, `<= ${fmtPct(B_PARAMS.maxRangePct)}`, share(range, (v) => v <= B_PARAMS.maxRangePct)));
  out.push(line("60s high above range high", brk, `>= ${fmtPct(B_PARAMS.minBreakoutPct)}`, share(brk, (v) => v >= B_PARAMS.minBreakoutPct)));
  out.push(line("rate acceleration (no-retest)", accel, `>= ${B_PARAMS.minRateAccel}x`, share(accel, (v) => v >= B_PARAMS.minRateAccel), false));
  out.push(line("buy imbalance / 60s", imb, `>= 0.10`, share(imb, (v) => v >= 0.1), false));
  const bAll = samples.filter((f) => f.priorHigh && f.priorLow && f.high60 && f.priorHigh / f.priorLow - 1 <= B_PARAMS.maxRangePct && f.high60 / f.priorHigh - 1 >= B_PARAMS.minBreakoutPct).length;
  out.push(`  snapshots with BOTH a defined range and a breakout: ${bAll} of ${samples.length}`);

  out.push("\n## Strategy C: early acceleration (age not applied here)");
  out.push(line("trades / 30s", trades30, `>= ${C_PARAMS.minTrades30}`, share(trades30, (v) => v >= C_PARAMS.minTrades30), false));
  out.push(line("rate acceleration", accel, `>= ${C_PARAMS.minRateAccel}x`, share(accel, (v) => v >= C_PARAMS.minRateAccel), false));
  out.push(line("new buyers / 30s", newBuyers, `>= ${C_PARAMS.minNewBuyers30}`, share(newBuyers, (v) => v >= C_PARAMS.minNewBuyers30), false));
  out.push(line("buy imbalance / 60s", imb, `>= ${C_PARAMS.minImbalance60}`, share(imb, (v) => v >= C_PARAMS.minImbalance60), false));
  out.push(line("60s return", ret60, `${fmtPct(C_PARAMS.minRet60)}..${fmtPct(C_PARAMS.maxRet60)}`, share(ret60, (v) => v >= C_PARAMS.minRet60 && v <= C_PARAMS.maxRet60)));

  out.push("\n## Strategy D: failure vetoes");
  out.push(line("30s return", ret30, `veto <= ${fmtPct(D_PARAMS.maxRet30Drop)}`, share(ret30, (v) => v > D_PARAMS.maxRet30Drop)));
  out.push(line("sellers / 60s", sellers, `veto if >= ${D_PARAMS.minSellers60} & imb <= ${D_PARAMS.sellImbalance}`, share(samples.map((f) => (f.sellers60 >= D_PARAMS.minSellers60 && f.imbalance60 <= D_PARAMS.sellImbalance ? 0 : 1)), (v) => v === 1), false));

  out.push("\n## Reading this");
  out.push("  'passes' is the share of snapshots that clear that one rule. A setup needs all of its rules at once, so the joint counts above matter more.");
  out.push("  A rule that passes under 5% of the time is the binding constraint. Loosening it is a research decision for a TRAIN window, then checked on validation.");
}
process.stdout.write(out.join("\n") + "\n");
db.close();
