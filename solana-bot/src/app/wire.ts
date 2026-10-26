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

function dispatcher(): Dispatcher | undefined {
  const env = process.env;
  return env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy ? new EnvHttpProxyAgent() : undefined;
}

export function buildDeps(cfg: AppConfig): ServiceDeps {
  const clock = systemClock;
  const logger = createLogger("solana-bot");
  const disp = dispatcher();

  const fetchImpl: FetchLike = async (url, init) => {
    const res = await undiciFetch(url, { ...init, ...(disp ? { dispatcher: disp } : {}) });
    return res;
  };
  const wsFactory: WsFactory = (url) => new WebSocket(url, disp ? { dispatcher: disp } : undefined) as unknown as WsLike;

  const health = new HealthMonitor(clock);
  registerProviders(health, cfg);

  // Limits sit below each provider's documented free tier.
  const limiters = {
    // Documented ~30/min keyless; we observed 429s sooner, so stay well under.
    geckoterminal: new RateLimiter(2, 10 / 60, clock),
    // Keyless 0.5 req/s, free key 1 req/s. Shared with future quote calls.
    jupiter_tokens: new RateLimiter(1, cfg.JUPITER_API_KEY ? 0.5 : 0.25, clock),
    // 300/min documented.
    dexscreener: new RateLimiter(5, 2, clock),
    // Public RPC: 40 req/10s per method. Helius free: 10 req/s.
    solana_rpc: new RateLimiter(3, 2, clock),
  };
  const http = new HttpClient({ fetch: fetchImpl, clock, health, limiters });

  const db = openDb(resolve(cfg.DATA_DIR, "solana-bot.sqlite"));
  const budget = new CallBudget(cfg.RPC_DAILY_CALL_BUDGET, clock, budgetStore(db));
  const rpc = new SolanaRpc(http, cfg.SOLANA_RPC_URL, budget);

  return { cfg, clock, logger, db, http, health, rpc, budget, wsFactory };
}
