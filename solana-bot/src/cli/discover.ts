/**
 * Run token discovery. Read-only: no wallet, no transactions.
 *
 *   npm run discover                 # until Ctrl+C
 *   npm run discover -- --minutes 30 # stop after 30 minutes
 */
import { buildDeps } from "../app/wire.ts";
import { DiscoveryService } from "../app/discoveryService.ts";
import { describeRpc, LIVE_TRADING_ENABLED, loadConfig } from "../core/config.ts";

const args = process.argv.slice(2);
const minutesIdx = args.indexOf("--minutes");
const minutes = minutesIdx >= 0 ? Number(args[minutesIdx + 1]) : undefined;
const statusEveryMs = 15_000;

const cfg = loadConfig();
const deps = buildDeps(cfg);
const svc = new DiscoveryService(deps);

function age(ms?: number): string {
  if (ms === undefined) return "?";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

function printStatus(): void {
  const s = svc.status();
  const lines: string[] = [];
  lines.push(`\n=== discovery ${new Date(s.now).toISOString()}  mode=PAPER-RESEARCH live=${LIVE_TRADING_ENABLED ? "ON" : "OFF"} ===`);
  lines.push(`gate: ${s.gate.open ? "OPEN" : "CLOSED"}${s.gate.reasons.length ? "  (" + s.gate.reasons.join("; ") + ")" : ""}`);
  for (const h of s.health) {
    if (h.provider === "dexscreener") continue;
    const ok = h.kind === "stream" ? `events=${s.counters.events[h.provider] ?? 0}` : `ok=${h.totalSuccesses}`;
    lines.push(`  ${h.provider.padEnd(15)} ${h.status.padEnd(9)} ${h.reason}  ${ok} fail=${h.totalFailures} 429=${h.rateLimitHits} rejects=${h.schemaRejects}`);
  }
  lines.push(`tokens=${s.tokens}  new by source=${JSON.stringify(s.counters.newTokens)}  dupes=${JSON.stringify(s.counters.duplicates)}`);
  lines.push(`confirm: ${JSON.stringify(s.confirm)}  rpc budget used today=${s.rpcBudget.usedToday} left=${s.rpcBudget.remaining}  slot=${s.lastSlot ?? "?"}`);
  lines.push(`stream: ${JSON.stringify(s.stream)}`);
  for (const r of s.recent) lines.push(`  ${r.mint}  ${r.category.padEnd(11)} age=${age(r.ageMs).padEnd(5)} stage=${r.stage.padEnd(8)} ${r.confirm}`);
  process.stdout.write(lines.join("\n") + "\n");
}

deps.logger.info("starting discovery", { rpc: describeRpc(cfg.SOLANA_RPC_URL), jupiterKey: cfg.JUPITER_API_KEY ? "set" : "keyless", dataDir: cfg.DATA_DIR });
svc.start();
const timer = setInterval(printStatus, statusEveryMs);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  deps.logger.info("stopping", { signal });
  clearInterval(timer);
  svc.stop();
  printStatus();
  deps.db.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (minutes && Number.isFinite(minutes) && minutes > 0) setTimeout(() => shutdown("duration reached"), minutes * 60_000);
