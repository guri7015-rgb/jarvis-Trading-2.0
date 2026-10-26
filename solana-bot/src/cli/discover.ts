/**
 * Run token discovery. Read-only: no wallet, no transactions.
 *
 *   npm run discover                 # until Ctrl+C
 *   npm run discover -- --minutes 30 # stop after 30 minutes
 *   npm run discover -- --assess     # also assess candidates (Phase 3, quotes only)
 *   npm run discover -- --assess --signals --paper --dashboard
 *        # --dashboard serves http://127.0.0.1:4777 (local only). Add --port N to change it.
 *        # Phase 5: approved signals open PAPER positions (real quotes, simulated fills). No wallet, no transactions.
 *   npm run discover -- --assess --signals [--research]
 *        # Phase 4: watch up to 3 tokens' live trades and record strategy/risk decisions (paper only).
 *        # --research also watches tokens rejected only for missing data; they can never be approved.
 */
import { buildAssessor, buildDeps } from "../app/wire.ts";
import { DiscoveryService } from "../app/discoveryService.ts";
import { describeRpc, LIVE_TRADING_ENABLED, loadConfig } from "../core/config.ts";
import { resolve } from "node:path";
import { TokenRegistry } from "../discovery/registry.ts";
import { TradeStream } from "../market/tradeStream.ts";
import { loadRiskLimits } from "../risk/limits.ts";
import { RiskStateStore } from "../risk/riskState.ts";
import { SessionStore } from "../storage/sessions.ts";
import { SignalEngine } from "../strategy/engine.ts";
import { Ledger } from "../paper/ledger.ts";
import { CONSERVATIVE_SIM, PaperExecutor } from "../paper/executor.ts";
import { PaperTrader } from "../paper/trader.ts";
import { FxService } from "../market/fx.ts";
import { QuoteClient } from "../market/quotes.ts";
import { DEFAULT_POLICY } from "../risk/policy.ts";
import { priorityEstimate } from "../risk/costs.ts";
import { loadStrategyParams } from "../strategy/params.ts";
import { startDashboard } from "../dashboard/server.ts";
import type { Server } from "node:http";

const args = process.argv.slice(2);
const minutesIdx = args.indexOf("--minutes");
const minutes = minutesIdx >= 0 ? Number(args[minutesIdx + 1]) : undefined;
const statusEveryMs = 15_000;

const cfg = loadConfig();
const deps = buildDeps(cfg);
// --assess: also run the Phase 3 tradability assessor (read-only quotes).
const assess = args.includes("--assess");
const assessor = assess ? buildAssessor(deps) : undefined;
const svc = new DiscoveryService({ ...deps, assessor });

let engine: SignalEngine | undefined;
let stream: TradeStream | undefined;
let paperLedger: Ledger | undefined;
let dashboard: Server | undefined;
let paperTrader: PaperTrader | undefined;
const strategyParams = loadStrategyParams(resolve(cfg.DATA_DIR, "strategy-params.json"));
let riskLimits = loadRiskLimits(resolve(cfg.DATA_DIR, "risk-limits.json"), resolve(cfg.DATA_DIR, "risk-limits.confirmed"));
if (args.includes("--signals")) {
  if (!assess) throw new Error("--signals needs --assess (the watchlist comes from gate assessments)");
  const lim = riskLimits;
  if (lim.refused.length) deps.logger.warn("refused unconfirmed limit increases; entries will be blocked", { limits: lim.refused });
  const sessions = new SessionStore(deps.db);
  stream = new TradeStream({
    url: cfg.SOLANA_WS_URL,
    factory: deps.wsFactory,
    clock: deps.clock,
    health: deps.health,
    logger: deps.logger,
    onTrades: (t, evs, at) => engine!.onTrades(t, evs, at),
    onGap: (_t, g) => sessions.addGap({ provider: "solana_ws", from_ms: g.from, to_ms: g.to, reason: g.reason }),
  });
  // --paper: approved entries become paper positions. Still no wallet and no transactions.
  let paper: { trader: PaperTrader; ledger: Ledger; fx: FxService } | undefined;
  if (args.includes("--paper")) {
    const fx = new FxService(deps.http, () => deps.clock.now(), { maxUsdCadAgeDays: 5, solUsdCacheMs: 60_000, usdCadCacheMs: 6 * 3_600_000, apiKey: cfg.JUPITER_API_KEY });
    const quotes = new QuoteClient(deps.http, () => deps.clock.now(), cfg.JUPITER_API_KEY);
    const ledger = new Ledger(deps.db, () => deps.clock.now());
    const riskState = new RiskStateStore(deps.db, () => deps.clock.now());
    // Live priority-fee estimate (median of recent non-zero fees, capped), refreshed every 30 s.
    // Until the first sample arrives, budget for the cap rather than for zero.
    let prioEstimate = DEFAULT_POLICY.maxPriorityMicroLamports;
    const refreshPrio = () =>
      deps.rpc
        .getRecentPrioritizationFees()
        .then((f) => {
          prioEstimate = priorityEstimate(f, DEFAULT_POLICY.maxPriorityMicroLamports);
        })
        .catch(() => undefined);
    void refreshPrio();
    setInterval(() => void refreshPrio(), 30_000).unref();
    const prio = () => prioEstimate;
    const executor = new PaperExecutor(quotes, deps.clock, prio, CONSERVATIVE_SIM);
    const trader = new PaperTrader({
      ledger,
      executor,
      quotes,
      riskState,
      clock: deps.clock,
      logger: deps.logger,
      priorityMicroLamports: prio,
      computeUnits: CONSERVATIVE_SIM.computeUnits,
      slippageBps: DEFAULT_POLICY.quoteSlippageBps,
      markEveryMs: 10_000,
      dParams: strategyParams.params.D,
      onAlert: (m, c) => deps.logger.error(`ALERT: ${m}`, c),
    });
    paper = { trader, ledger, fx };
    paperLedger = ledger;
    paperTrader = trader;
    void fx.solCad().then((q) => ledger.initAccount(lim.limits.referenceEquityCad, q.solCad)).catch((e) => deps.logger.error("paper account not initialised: FX unavailable", { err: (e as Error).message }));
  }
  deps.logger.info("strategy params", { source: strategyParams.source, sha256: strategyParams.sha256, overridden: strategyParams.overridden });
  engine = new SignalEngine({
    params: strategyParams.params,
    trader: paper?.trader,
    ledger: paper?.ledger,
    fx: paper?.fx,
    db: deps.db,
    registry: new TokenRegistry(deps.db),
    rpc: deps.rpc,
    stream,
    health: deps.health,
    clock: deps.clock,
    logger: deps.logger,
    limits: lim.limits,
    limitsRefused: lim.refused,
    riskState: new RiskStateStore(deps.db, () => deps.clock.now()),
    research: args.includes("--research"),
    newLaunchMaxAgeMs: cfg.discovery.newLaunchMaxAgeMs,
    earlyMaxAgeMs: cfg.discovery.earlyMaxAgeMs,
  });
}

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
  if (s.assess) lines.push(`assess: ${JSON.stringify(s.assess)}`);
  if (engine && stream) {
    lines.push(`signals: ${JSON.stringify(engine.stats)}`);
    if (paperLedger) {
      const a = paperLedger.account();
      const open = paperLedger.open();
      if (a) lines.push(`paper: cash=${(Number(a.cash) / 1e9).toFixed(4)} SOL (start ${(Number(a.starting) / 1e9).toFixed(4)})  open=${open.length}  closed=${paperLedger.closed().length}`);
      for (const p of open) lines.push(`  position ${p.id} ${p.state} ${p.strategy} entry=${p.entry_price?.toExponential(3)} held=${p.tokens_held}`);
    }
    for (const w of engine.watched()) lines.push(`  watching ${w.mint} ${w.venue}${w.researchOnly ? " (research only)" : ""} ${JSON.stringify(stream.stats.get(stream.watched().find((x) => x.mint === w.mint)?.account ?? "") ?? {})}`);
  }
  for (const r of s.recent) lines.push(`  ${r.mint}  ${r.category.padEnd(11)} age=${age(r.ageMs).padEnd(5)} stage=${r.stage.padEnd(8)} ${r.confirm}`);
  process.stdout.write(lines.join("\n") + "\n");
}

if (args.includes("--dashboard")) {
  const pIdx = args.indexOf("--port");
  dashboard = startDashboard(
    {
      db: deps.db,
      health: deps.health,
      riskState: new RiskStateStore(deps.db, () => deps.clock.now()),
      limits: riskLimits.limits,
      limitsRefused: riskLimits.refused,
      ledger: paperLedger,
      marks: () => paperTrader?.marks() ?? new Map(),
      watched: () => engine?.watched() ?? [],
      rpcBudget: () => ({ usedToday: deps.budget.usedToday, remaining: deps.budget.remaining }),
      now: () => deps.clock.now(),
    },
    deps.logger,
    pIdx >= 0 ? Number(args[pIdx + 1]) : 4777,
  );
}
deps.logger.info("starting discovery", { rpc: describeRpc(cfg.SOLANA_RPC_URL), jupiterKey: cfg.JUPITER_API_KEY ? "set" : "keyless", dataDir: cfg.DATA_DIR });
svc.start();
stream?.start();
engine?.start();
const timer = setInterval(printStatus, statusEveryMs);

let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  deps.logger.info("stopping", { signal });
  clearInterval(timer);
  engine?.stop();
  stream?.stop();
  dashboard?.close();
  svc.stop();
  printStatus();
  deps.db.close();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (minutes && Number.isFinite(minutes) && minutes > 0) setTimeout(() => shutdown("duration reached"), minutes * 60_000);
