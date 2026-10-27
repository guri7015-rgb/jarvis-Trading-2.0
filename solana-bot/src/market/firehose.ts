/**
 * Mover scanner: every trade on pump.fun and PumpSwap, one firehose, ranked in
 * memory so a coin that starts moving is seen within seconds, not after the
 * assessment queue gets to it.
 *
 * Two `logsSubscribe` subscriptions (one per program), the same event decoder
 * as the watchlist stream, a rolling 180 s window per coin. Nothing here is a
 * trade decision: a mover is only a candidate for the fast safety check.
 *
 * Load: pump.fun alone runs tens of transactions a second. Messages are capped
 * in size, keys are capped in number, and idle coins are dropped.
 */
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { HealthMonitor } from "../health/monitor.ts";
import { ReconnectingWs, type WsFactory } from "../net/wsClient.ts";
import { PROGRAMS } from "../solana/programs.ts";
import { parseTradeLogs, type TradeEvent } from "./eventDecoder.ts";

export interface Mover {
  /** Curve trades: the mint. PumpSwap: the pool address (the mint is resolved later). */
  key: string;
  venue: "pump_curve" | "pumpswap";
  firstSeenAt: number;
  lastTradeAt: number;
  trades60: number;
  trades15: number;
  buyers60: number;
  sellers60: number;
  buySol60: number;
  sellSol60: number;
  /** Last price over the price 60 s ago, minus 1. */
  ret60: number;
  lastPrice: number;
  score: number;
}

export interface ScannerRules {
  minTrades60: number;
  minBuyers60: number;
  minNetBuySol60: number;
  minRet60: number;
  /** Past this it has already run; too late for us. */
  maxRet60: number;
  minTrades15: number;
}

export const DEFAULT_SCANNER_RULES: ScannerRules = { minTrades60: 12, minBuyers60: 8, minNetBuySol60: 0.3, minRet60: 0.03, maxRet60: 0.8, minTrades15: 3 };

interface Tick {
  t: number;
  side: "buy" | "sell";
  wallet: string;
  sol: number;
  price: number;
}

const WINDOW_MS = 180_000;
const IDLE_DROP_MS = 300_000;
const MAX_KEYS = 20_000;

export class MoverScanner {
  private ws: ReconnectingWs;
  private books = new Map<string, { venue: "pump_curve" | "pumpswap"; firstSeenAt: number; ticks: Tick[] }>();
  private subIds = new Set<number>();
  private reqId = 1;
  public stats = { messages: 0, failedTxs: 0, events: 0, keys: 0, spoofed: 0, dropped: 0, notSolQuoted: 0 };

  constructor(
    private readonly o: { url: string; factory: WsFactory; clock: Clock; health: HealthMonitor; logger: Logger; rules?: ScannerRules; decimalsFor?: (key: string, venue: "pump_curve" | "pumpswap") => number },
  ) {
    this.ws = new ReconnectingWs({
      provider: "solana_firehose",
      url: o.url,
      factory: o.factory,
      subscribeMessages: () => {
        this.subIds.clear();
        return [PROGRAMS.PUMP_CURVE, PROGRAMS.PUMPSWAP].map((pgm) => JSON.stringify({ jsonrpc: "2.0", id: this.reqId++, method: "logsSubscribe", params: [{ mentions: [pgm] }, { commitment: "confirmed" }] }));
      },
      maxSilenceMs: 60_000,
      clock: o.clock,
      health: o.health,
      logger: o.logger,
      onMessage: (t) => this.onMessage(t),
      maxMessageBytes: 256 * 1024,
    });
  }

  start(): void {
    this.ws.start();
  }

  stop(): void {
    this.ws.stop();
  }

  private onMessage(text: string): void {
    let m: { id?: number; result?: unknown; method?: string; params?: { subscription?: number; result?: unknown } };
    try {
      m = JSON.parse(text);
    } catch {
      this.o.health.recordSchemaReject("solana_firehose");
      return;
    }
    if (typeof m.id === "number") {
      if (typeof m.result === "number") this.subIds.add(m.result);
      return;
    }
    if (m.method !== "logsNotification" || typeof m.params?.subscription !== "number" || !this.subIds.has(m.params.subscription)) return;
    const r = m.params.result as { context?: { slot?: unknown }; value?: { signature?: unknown; err?: unknown; logs?: unknown } } | undefined;
    const slot = r?.context?.slot;
    const v = r?.value;
    if (typeof slot !== "number" || typeof v?.signature !== "string" || !Array.isArray(v.logs) || v.logs.length > 2000) {
      this.o.health.recordSchemaReject("solana_firehose");
      return;
    }
    this.stats.messages++;
    this.o.health.recordEvent("solana_firehose");
    if (v.err) {
      this.stats.failedTxs++;
      return;
    }
    const p = parseTradeLogs(v.signature, slot, v.logs.filter((l): l is string => typeof l === "string"));
    this.stats.spoofed += p.spoofed;
    if (p.events.length) this.ingest(p.events, this.o.clock.now());
  }

  /** Feed decoded events (also used by tests and by the watchlist backfill). */
  ingest(events: TradeEvent[], now: number): void {
    for (const e of events) {
      if (e.tokenAmount === 0n) continue;
      const decimals = this.o.decimalsFor?.(e.mintOrPool, e.venue) ?? 6;
      const sol = Number(e.quoteAmount) / 1e9;
      const price = sol / (Number(e.tokenAmount) / 10 ** decimals);
      if (!Number.isFinite(price) || price <= 0) continue;
      // A single trade over 200 "SOL" on a meme pool means the quote side is not SOL (USDC or token-paired). Not ours.
      if (sol > 200) {
        this.stats.notSolQuoted++;
        continue;
      }
      let b = this.books.get(e.mintOrPool);
      if (!b) {
        if (this.books.size >= MAX_KEYS) {
          this.stats.dropped++;
          continue;
        }
        b = { venue: e.venue, firstSeenAt: now, ticks: [] };
        this.books.set(e.mintOrPool, b);
      }
      b.ticks.push({ t: now, side: e.side, wallet: e.wallet, sol, price });
      this.stats.events++;
    }
  }

  /** Recent raw ticks for one key, oldest first (for backfilling a new watch). */
  recent(key: string): Tick[] {
    return [...(this.books.get(key)?.ticks ?? [])];
  }

  /** Rank every coin with activity in the last 60 s. Also prunes old data. */
  movers(now: number, limit = 10, rules: ScannerRules = this.o.rules ?? DEFAULT_SCANNER_RULES): Mover[] {
    const out: Mover[] = [];
    for (const [key, b] of this.books) {
      // Prune the window; drop idle coins.
      let i = 0;
      while (i < b.ticks.length && now - b.ticks[i]!.t > WINDOW_MS) i++;
      if (i) b.ticks.splice(0, i);
      const last = b.ticks[b.ticks.length - 1];
      if (!last || now - last.t > IDLE_DROP_MS) {
        this.books.delete(key);
        continue;
      }
      const w60 = b.ticks.filter((x) => now - x.t <= 60_000);
      if (w60.length < rules.minTrades60) continue;
      const w15 = w60.filter((x) => now - x.t <= 15_000);
      const buyers = new Set<string>();
      const sellers = new Set<string>();
      let buySol = 0;
      let sellSol = 0;
      for (const x of w60) {
        if (x.side === "buy") {
          buyers.add(x.wallet);
          buySol += x.sol;
        } else {
          sellers.add(x.wallet);
          sellSol += x.sol;
        }
      }
      const ret60 = last.price / w60[0]!.price - 1;
      const net = buySol - sellSol;
      if (buyers.size < rules.minBuyers60 || net < rules.minNetBuySol60 || ret60 < rules.minRet60 || ret60 > rules.maxRet60 || w15.length < rules.minTrades15) continue;
      const score = buyers.size * (1 + Math.min(ret60, 0.5)) * Math.min(2, 1 + net);
      out.push({ key, venue: b.venue, firstSeenAt: b.firstSeenAt, lastTradeAt: last.t, trades60: w60.length, trades15: w15.length, buyers60: buyers.size, sellers60: sellers.size, buySol60: buySol, sellSol60: sellSol, ret60, lastPrice: last.price, score });
    }
    this.stats.keys = this.books.size;
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }
}
