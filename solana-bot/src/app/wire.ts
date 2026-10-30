/**
 * Builds real network clients. Kept separate so tests never import it.
 *
 * If HTTPS_PROXY / HTTP_PROXY is set (as in some cloud sandboxes), requests go
 * through it. On a normal home machine nothing is set and connections are direct.
 */
import { resolve } from "node:path";
import { EnvHttpProxyAgent, fetch as undiciFetch, WebSocket, type Dispatcher } from "undici";
import { systemClock } from "../core/clock.ts";
import type { AppConfig } from "../core/config.ts";
import { createLogger } from "../core/log.ts";
import { HealthMonitor } from "../health/monitor.ts";
import { HttpClient, type FetchLike } from "../net/http.ts";
import { RateLimiter } from "../net/rateLimiter.ts";
import type { WsFactory, WsLike } from "../net/wsClient.ts";
import { CallBudget, SolanaRpc } from "../solana/rpc.ts";
import { openDb } from "../storage/db.ts";
import { budgetStore } from "../storage/sessions.ts";
import { registerProviders, type ServiceDeps } from "./discoveryService.ts";
import { Assessor } from "../assess/assessor.ts";
import { TokenRegistry } from "../discovery/registry.ts";
import { fetchJupiterAudit } from "../providers/jupiterTokens.ts";
import { holderReportFromProvider } from "../risk/holders.ts";
import { FxService } from "../market/fx.ts";
import { QuoteClient } from "../market/quotes.ts";
import { DEFAULT_POLICY, type RiskPolicy } from "../risk/policy.ts";

function dispatcher(): Dispatcher | undefined {
  const env = process.env;
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy ? new EnvHttpProxyAgent() : undefined;
}

export function buildDeps(cfg: AppConfig): ServiceDeps {
  const clock = systemClock;
  const logger = createLogger("solana-bot");
  const disp = dispatcher();

  const fetchImpl: FetchLike = async (url, init) => {
    // Never follow redirects: a keyed request must not carry its x-api-key to another host.
    const res = await undiciFetch(url, { ...init, redirect: "error", ...(disp ? { dispatcher: disp } : {}) });
    return res;
  };
  const wsFactory: WsFactory = (url) => new WebSocket(url, disp ? { dispatcher: disp } : undefined) as unknown as WsLike;

  const health = new HealthMonitor(clock);
  registerProviders(health, cfg);

  // Limits sit below each provider's documented free tier.
  // Jupiter limits are per account, so every Jupiter endpoint shares one bucket.
  // Keyless 0.5 req/s, free key 1 req/s; we stay at half of that. Burst 3 lets a
  // buy and sell quote go out back to back so they describe the same market.
  const jupiter = new RateLimiter(3, cfg.JUPITER_API_KEY ? 0.5 : 0.25, clock);
  const rpcLimiter = new RateLimiter(3, 2, clock);
  const limiters = {
    // Documented ~30/min keyless; we observed 429s sooner, so stay well under.
    geckoterminal: new RateLimiter(2, 10 / 60, clock),
    jupiter_tokens: jupiter,
    jupiter_quote: jupiter,
    jupiter_price: jupiter,
    bankofcanada: new RateLimiter(1, 0.5, clock),
    // Coinbase Exchange public market data: documented 10 req/s; we poll 8 products a minute.
    coinbase: new RateLimiter(4, 2, clock),
    // 300/min documented.
    dexscreener: new RateLimiter(5, 2, clock),
    // Public RPC: 40 req/10s per method. Helius free: 10 req/s.
    solana_rpc: rpcLimiter,
    solana_rpc_holders: rpcLimiter,
  };
  const http = new HttpClient({ fetch: fetchImpl, clock, health, limiters });

  const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
  const budget = new CallBudget(cfg.RPC_DAILY_CALL_BUDGET, clock, budgetStore(db));
  const rpc = new SolanaRpc(http, cfg.SOLANA_RPC_URL, budget);

  return { cfg, clock, logger, db, http, health, rpc, budget, wsFactory };
}

/** Phase 3 assessor on top of the discovery deps. Read-only: quotes, never transactions. */
export function buildAssessor(d: ServiceDeps, policy: RiskPolicy = DEFAULT_POLICY, o: { providerHolders?: boolean } = {}): Assessor {
  return new Assessor({
    providerHolders: o.providerHolders
      ? async (mint) => {
          const audit = await fetchJupiterAudit(d.http, d.cfg.JUPITER_API_KEY, mint);
          return audit ? holderReportFromProvider(audit) : new Error("provider has no holder summary for this coin");
        }
      : undefined,
    db: d.db,
    registry: new TokenRegistry(d.db),
    rpc: d.rpc,
    budget: d.budget,
    quotes: new QuoteClient(d.http, () => d.clock.now(), d.cfg.JUPITER_API_KEY),
    fx: new FxService(d.http, () => d.clock.now(), { maxUsdCadAgeDays: 5, solUsdCacheMs: 60_000, usdCadCacheMs: 6 * 3_600_000, apiKey: d.cfg.JUPITER_API_KEY }),
    clock: d.clock,
    logger: d.logger,
    policy,
  });
}
