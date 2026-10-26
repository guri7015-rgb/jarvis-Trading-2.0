/**
 * Coverage report from the local discovery database.
 *
 *   npm run coverage                  # whole database
 *   npm run coverage -- --hours 2     # last 2 hours
 *   npm run coverage -- --dexscreener # also cross-check 30 recent mints on DexScreener
 *
 * Answers: which provider sees which venues, who sees tokens first and by how
 * much, how many provider claims were confirmed on-chain, and where the gaps are.
 */
import { resolve } from "node:path";
import { buildDeps } from "../app/wire.ts";
import { loadConfig } from "../core/config.ts";
import { fetchDexScreenerTokens } from "../providers/dexscreener.ts";
import { openDb } from "../storage/db.ts";

const args = process.argv.slice(2);
const hIdx = args.indexOf("--hours");
const hours = hIdx >= 0 ? Number(args[hIdx + 1]) : undefined;
const since = hours ? Date.now() - hours * 3_600_000 : 0;

const cfg = loadConfig();
const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
const out: string[] = [];
const q = <T>(sql: string, ...p: (string | number)[]) => db.prepare(sql).all(...p) as unknown as T[];

out.push(`# Discovery coverage report (${hours ? `last ${hours}h` : "all data"}) — generated ${new Date().toISOString()}`);

const span = q<{ a: number | null; b: number | null; n: number }>("SELECT MIN(first_observed_at) a, MAX(first_observed_at) b, COUNT(*) n FROM tokens WHERE first_observed_at >= ?", since)[0]!;
out.push(`\nTokens: ${span.n}   window: ${span.a ? new Date(span.a).toISOString() : "-"} → ${span.b ? new Date(span.b).toISOString() : "-"}`);

out.push("\n## Distinct mints by provider and venue (provider-reported venue labels)");
const vm = q<{ provider: string; venue: string; venue_raw: string; n: number }>(
  "SELECT provider, venue, venue_raw, COUNT(DISTINCT mint) n FROM events WHERE received_at >= ? GROUP BY provider, venue, venue_raw ORDER BY provider, n DESC",
  since,
);
for (const r of vm) out.push(`  ${r.provider.padEnd(15)} ${r.venue.padEnd(18)} raw=${r.venue_raw.padEnd(18)} ${r.n}`);

out.push("\n## Who saw each token first, and how far behind the others were");
const firsts = q<{ first_source: string; n: number }>("SELECT first_source, COUNT(*) n FROM tokens WHERE first_observed_at >= ? GROUP BY first_source", since);
for (const r of firsts) out.push(`  first: ${r.first_source.padEnd(15)} ${r.n}`);
const lags = q<{ provider: string; lag: number }>(
  `SELECT s.provider, s.first_seen_at - t.first_observed_at AS lag FROM token_sources s JOIN tokens t USING (mint)
   WHERE t.first_observed_at >= ? AND s.provider != t.first_source`,
  since,
);
const byProv = new Map<string, number[]>();
for (const l of lags) (byProv.get(l.provider) ?? byProv.set(l.provider, []).get(l.provider)!).push(l.lag);
for (const [p, arr] of byProv) {
  arr.sort((a, b) => a - b);
  const pct = (x: number) => Math.round(arr[Math.min(arr.length - 1, Math.floor(arr.length * x))]! / 1000);
  out.push(`  ${p.padEnd(15)} when not first: n=${arr.length} lag p50=${pct(0.5)}s p90=${pct(0.9)}s max=${pct(1)}s`);
}

out.push("\n## Overlap: tokens seen by N providers");
for (const r of q<{ k: number; n: number }>(
  "SELECT k, COUNT(*) n FROM (SELECT mint, COUNT(*) k FROM token_sources WHERE first_seen_at >= ? GROUP BY mint) GROUP BY k ORDER BY k",
  since,
))
  out.push(`  ${r.k} provider(s): ${r.n}`);

out.push("\n## On-chain confirmation (ONCHAIN_CONFIRMED facts)");
for (const r of q<{ confirm_status: string; n: number }>("SELECT confirm_status, COUNT(*) n FROM tokens WHERE first_observed_at >= ? GROUP BY confirm_status", since))
  out.push(`  ${r.confirm_status.padEnd(11)} ${r.n}`);
for (const r of q<{ mint_program: string; n: number }>("SELECT mint_program, COUNT(*) n FROM tokens WHERE confirm_status='CONFIRMED' AND first_observed_at >= ? GROUP BY mint_program", since))
  out.push(`  program ${String(r.mint_program).padEnd(10)} ${r.n}`);
const auth = q<{ ma: number; fa: number; n: number }>(
  "SELECT SUM(mint_authority IS NOT NULL) ma, SUM(freeze_authority IS NOT NULL) fa, COUNT(*) n FROM tokens WHERE confirm_status='CONFIRMED' AND first_observed_at >= ?",
  since,
)[0]!;
out.push(`  mint authority still set: ${auth.ma ?? 0}/${auth.n}   freeze authority still set: ${auth.fa ?? 0}/${auth.n}`);
const exts = new Map<string, number>();
for (const r of q<{ extensions: string }>("SELECT extensions FROM tokens WHERE confirm_status='CONFIRMED' AND extensions IS NOT NULL AND first_observed_at >= ?", since)) {
  for (const e of JSON.parse(r.extensions) as string[]) exts.set(e, (exts.get(e) ?? 0) + 1);
}
out.push(`  token-2022 extensions seen: ${[...exts].map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
const curve = q<{ m: number; mm: number; c: number; n: number }>(
  `SELECT SUM(curve_key_matches = 1) m, SUM(curve_key_matches = 0) mm, SUM(curve_complete = 1) c, SUM(curve_virtual_quote IS NOT NULL) n
   FROM tokens WHERE first_observed_at >= ?`,
  since,
)[0]!;
out.push(`  pump curves read on-chain: ${curve.n ?? 0}  complete: ${curve.c ?? 0}  provider curve key matched our derivation: ${curve.m ?? 0}, mismatched: ${curve.mm ?? 0}`);
for (const r of q<{ first_source: string; confirm_note: string; n: number }>(
  "SELECT first_source, confirm_note, COUNT(*) n FROM tokens WHERE confirm_status='CONFLICT' AND first_observed_at >= ? GROUP BY first_source, confirm_note",
  since,
))
  out.push(`  CONFLICT (chain disagrees with ${r.first_source}): ${r.n}  — ${r.confirm_note}`);

out.push("\n## Age categories (creation-time evidence)");
for (const r of q<{ e: string | null; s: string | null; n: number }>(
  "SELECT created_at_evidence e, created_at_source s, COUNT(*) n FROM tokens WHERE first_observed_at >= ? GROUP BY e, s ORDER BY n DESC",
  since,
))
  out.push(`  ${String(r.e).padEnd(18)} ${String(r.s).padEnd(40)} ${r.n}`);

out.push("\n## Duplicates and rejected payloads by provider/day");
for (const r of q<{ provider: string; day: string; duplicates: number; rejected: number }>("SELECT * FROM provider_stats ORDER BY day, provider"))
  out.push(`  ${r.day} ${r.provider.padEnd(15)} duplicates=${r.duplicates} rejected=${r.rejected}`);

out.push("\n## Data gaps (events in these windows may be missing)");
const gaps = q<{ provider: string; from_ms: number; to_ms: number; reason: string }>("SELECT * FROM gaps WHERE to_ms >= ? ORDER BY from_ms", since);
if (gaps.length === 0) out.push("  none recorded");
for (const g of gaps) out.push(`  ${g.provider.padEnd(12)} ${new Date(g.from_ms).toISOString()} → ${new Date(g.to_ms).toISOString()} (${Math.round((g.to_ms - g.from_ms) / 1000)}s) ${g.reason}`);

if (args.includes("--dexscreener")) {
  const deps = buildDeps(cfg);
  const mints = q<{ mint: string }>("SELECT mint FROM tokens WHERE confirm_status='CONFIRMED' ORDER BY first_observed_at DESC LIMIT 30").map((r) => r.mint);
  try {
    const r = await fetchDexScreenerTokens(deps.http, mints);
    const seen = new Set(r.pairs.map((p) => p.mint));
    const venues = new Map<string, number>();
    for (const p of r.pairs) venues.set(p.venueRaw, (venues.get(p.venueRaw) ?? 0) + 1);
    out.push(`\n## DexScreener cross-check of ${mints.length} recent confirmed mints`);
    out.push(`  known to DexScreener: ${seen.size}/${mints.length}   pair venues: ${[...venues].map(([k, v]) => `${k}=${v}`).join(", ")}`);
    out.push(`  pairs with no liquidity figure: ${r.pairs.filter((p) => p.liquidityUsd === null).length}/${r.pairs.length}`);
  } catch (e) {
    out.push(`\n## DexScreener cross-check failed: ${(e as Error).message}`);
  }
  deps.db.close();
}

process.stdout.write(out.join("\n") + "\n");
db.close();
