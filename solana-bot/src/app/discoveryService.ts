/**
 * Wires providers → registry → on-chain confirmation, with health tracking.
 *
 * Read-only. Nothing here can build, sign or send a transaction.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "../core/clock.ts";
import type { AppConfig } from "../core/config.ts";
import type { Logger } from "../core/log.ts";
import type { DiscoveryEvent, ProviderId } from "../core/types.ts";
import { OnChainConfirmer } from "../discovery/confirmer.ts";
import { categorize, TokenRegistry, type TokenRow } from "../discovery/registry.ts";
import { HealthMonitor } from "../health/monitor.ts";
import type { HttpClient } from "../net/http.ts";
import { ReconnectingWs, type WsFactory } from "../net/wsClient.ts";
import { fetchGeckoNewPools } from "../providers/geckoterminal.ts";
import { fetchJupiterCategory, fetchJupiterRecent, type JupiterCategory } from "../providers/jupiterTokens.ts";
import type { Assessor } from "../assess/assessor.ts";
import { Poller } from "../providers/poller.ts";
import { buildSubscribeMessages, parsePumpPortalMessage, PUMPPORTAL_DATA_URL } from "../providers/pumpportal.ts";
import type { CallBudget, SolanaRpc } from "../solana/rpc.ts";
import { SessionStore } from "../storage/sessions.ts";

export interface ServiceDeps {
  cfg: AppConfig;
  clock: Clock;
  logger: Logger;
  db: DatabaseSync;
  http: HttpClient;
  health: HealthMonitor;
  rpc: SolanaRpc;
  budget: CallBudget;
  wsFactory: WsFactory;
  /** Phase 3: when present, candidates are assessed on a timer. */
  assessor?: Assessor;
  assessIntervalMs?: number;
}

export interface Counters {
  events: Record<string, number>;
  newTokens: Record<string, number>;
  duplicates: Record<string, number>;
  crossProviderRepeats: Record<string, number>;
  rejected: Record<string, number>;
}

const RPC_HEALTH_INTERVAL_MS = 60_000;
const CATEGORY_POLL_MS = 60_000;
const HEARTBEAT_MS = 10_000;

/** Register providers with the health monitor using the configured freshness limits. */
export function registerProviders(health: HealthMonitor, cfg: AppConfig): void {
  const d = cfg.discovery;
  health.register("pumpportal", { kind: "stream", maxSilenceMs: d.pumpportalMaxSilenceMs, required: false });
  health.register("geckoterminal", { kind: "poll", maxSilenceMs: d.geckoPollMs * d.pollMaxAgeFactor, required: false });
  health.register("jupiter_tokens", { kind: "poll", maxSilenceMs: d.jupiterRecentPollMs * d.pollMaxAgeFactor, required: false });
  health.register("solana_rpc", { kind: "rpc", maxSilenceMs: RPC_HEALTH_INTERVAL_MS * 3, required: true });
  // Holder reads are tracked apart: a free RPC refusing them is expected and covered by the provider fallback.
  health.register("solana_rpc_holders", { kind: "rpc", maxSilenceMs: 24 * 3_600_000, required: false });
  health.register("dexscreener", { kind: "poll", maxSilenceMs: 24 * 3600_000, required: false });
  // Called on demand by the assessor, so long silences are normal.
  health.register("jupiter_quote", { kind: "poll", maxSilenceMs: 24 * 3600_000, required: false });
  health.register("jupiter_price", { kind: "poll", maxSilenceMs: 24 * 3600_000, required: false });
  health.register("bankofcanada", { kind: "poll", maxSilenceMs: 24 * 3600_000, required: false });
  // Phase 4 trade feed for the watchlist. Quiet tokens can be silent for minutes.
  health.register("solana_ws", { kind: "stream", maxSilenceMs: 5 * 60_000, required: false });
}

export class DiscoveryService {
  readonly registry: TokenRegistry;
  readonly confirmer: OnChainConfirmer;
  readonly sessions: SessionStore;
  private stream: ReconnectingWs;
  private pollers: Poller[] = [];
  private timers: unknown[] = [];
  private running = false;
  private lastSlot: { slot: number; at: number } | undefined;
  readonly counters: Counters = { events: {}, newTokens: {}, duplicates: {}, crossProviderRepeats: {}, rejected: {} };

  constructor(private readonly d: ServiceDeps) {
    this.registry = new TokenRegistry(d.db);
    this.sessions = new SessionStore(d.db);
    this.confirmer = new OnChainConfirmer(d.db, this.registry, d.rpc, d.logger, () => d.clock.now(), d.cfg.discovery.confirmBatchSize);
    this.stream = new ReconnectingWs({
      provider: "pumpportal",
      url: PUMPPORTAL_DATA_URL,
      factory: d.wsFactory,
      subscribeMessages: buildSubscribeMessages(["subscribeNewToken", "subscribeMigration"]),
      maxSilenceMs: d.cfg.discovery.pumpportalMaxSilenceMs,
      clock: d.clock,
      health: d.health,
      logger: d.logger,
      onMessage: (text) => this.onPumpPortal(text),
      onGap: (g) => this.sessions.addGap({ provider: g.provider, from_ms: g.from, to_ms: g.to, reason: g.reason }),
    });
  }

  private bump(map: Record<string, number>, key: string, n = 1): void {
    map[key] = (map[key] ?? 0) + n;
  }

  /** Single entry point for every normalized event. */
  ingest(ev: DiscoveryEvent): void {
    this.bump(this.counters.events, ev.provider);
    this.d.health.recordEvent(ev.provider);
    const r = this.registry.ingest(ev);
    if (r.duplicate) this.bump(this.counters.duplicates, ev.provider);
    if (r.newToken) this.bump(this.counters.newTokens, ev.provider);
    if (r.crossProviderRepeat) this.bump(this.counters.crossProviderRepeats, ev.provider);
  }

  /** Hand polled tokens to the assessor as candidates (it filters by liquidity). */
  private offer(events: DiscoveryEvent[], source: string): void {
    if (!this.d.assessor) return;
    this.d.assessor.addCandidates(
      events.filter((e) => e.kind === "pool_observed").map((e) => ({ mint: e.mint, source, liquidityUsd: e.kind === "pool_observed" ? e.liquidityUsd : undefined })),
    );
  }

  private reject(provider: ProviderId, n: number): void {
    if (n <= 0) return;
    this.bump(this.counters.rejected, provider, n);
    this.registry.recordRejected(provider, this.d.clock.now(), n);
    this.d.health.recordSchemaReject(provider);
  }

  private onPumpPortal(text: string): void {
    const now = this.d.clock.now();
    const p = parsePumpPortalMessage(text, now);
    if (p.type === "event") this.ingest(p.event);
    else if (p.type === "ack") this.d.health.recordEvent("pumpportal");
    else if (p.type === "rejected") {
      this.reject("pumpportal", 1);
      this.d.logger.debug("pumpportal message rejected", { reason: p.reason });
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const { clock, cfg, http, logger } = this.d;
    const gap = this.sessions.start(clock.now());
    if (gap) logger.info("recorded downtime gap since last run", { fromMs: gap.from_ms, toMs: gap.to_ms, reason: gap.reason });

    this.stream.start();
    this.pollers.push(
      new Poller(
        "geckoterminal",
        cfg.discovery.geckoPollMs,
        async () => {
          const r = await fetchGeckoNewPools(http, () => clock.now());
          this.reject("geckoterminal", r.rejected);
          for (const ev of r.events) this.ingest(ev);
          this.offer(r.events, "geckoterminal:new_pools");
        },
        clock,
        logger,
      ),
      new Poller(
        "jupiter_tokens",
        cfg.discovery.jupiterRecentPollMs,
        async () => {
          const r = await fetchJupiterRecent(http, cfg.JUPITER_API_KEY, () => clock.now());
          this.reject("jupiter_tokens", r.rejected);
          for (const ev of r.events) this.ingest(ev);
          this.offer(r.events, "jupiter:recent");
        },
        clock,
        logger,
      ),
      new Poller("solana_rpc", cfg.discovery.confirmIntervalMs, () => this.confirmer.runBatch().then(() => undefined), clock, logger),
      new Poller("solana_rpc", RPC_HEALTH_INTERVAL_MS, () => this.checkSlot(), clock, logger),
    );
    if (this.d.assessor) {
      const cats: JupiterCategory[] = ["toptrending", "toptraded"];
      let n = 0;
      this.pollers.push(
        new Poller(
          "jupiter_tokens",
          CATEGORY_POLL_MS,
          async () => {
            const cat = cats[n++ % cats.length]!;
            const r = await fetchJupiterCategory(http, cfg.JUPITER_API_KEY, cat, "5m", () => clock.now());
            this.reject("jupiter_tokens", r.rejected);
            for (const ev of r.events) this.ingest(ev);
            this.offer(r.events, `jupiter:${cat}`);
          },
          clock,
          logger,
        ),
        new Poller("jupiter_quote", this.d.assessIntervalMs ?? 30_000, () => this.d.assessor!.tick().then(() => undefined), clock, logger),
      );
    }
    for (const p of this.pollers) p.start();
    const beat = () => {
      if (!this.running) return;
      this.sessions.heartbeat(clock.now());
      this.timers.push(clock.setTimeout(beat, HEARTBEAT_MS));
    };
    beat();
  }

  /** RPC freshness: the confirmed slot must keep advancing. */
  private async checkSlot(): Promise<void> {
    const slot = await this.d.rpc.getSlot();
    const now = this.d.clock.now();
    if (this.lastSlot && slot <= this.lastSlot.slot && now - this.lastSlot.at > 30_000) {
      this.d.health.recordFailure("solana_rpc", `slot not advancing (${slot})`);
    }
    if (!this.lastSlot || slot > this.lastSlot.slot) this.lastSlot = { slot, at: now };
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stream.stop();
    for (const p of this.pollers) p.stop();
    for (const t of this.timers) this.d.clock.clearTimeout(t);
    this.sessions.end(this.d.clock.now());
  }

  status() {
    const now = this.d.clock.now();
    const recent = this.d.db
      .prepare("SELECT * FROM tokens ORDER BY first_observed_at DESC LIMIT 8")
      .all() as unknown as TokenRow[];
    return {
      now,
      gate: this.d.health.gate(),
      health: this.d.health.snapshot(),
      counters: this.counters,
      tokens: this.registry.count(),
      confirm: this.confirmer.stats,
      assess: this.d.assessor ? { ...this.d.assessor.stats, candidates: this.d.assessor.candidateCount } : undefined,
      rpcBudget: { usedToday: this.d.budget.usedToday, remaining: this.d.budget.remaining },
      stream: this.stream.stats,
      lastSlot: this.lastSlot?.slot,
      recent: recent.map((t) => ({ mint: t.mint, stage: t.stage, confirm: t.confirm_status, ...categorize(t, now, this.d.cfg.discovery) })),
    };
  }
}
