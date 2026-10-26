/**
 * Live trades for a small watchlist, from Solana `logsSubscribe` (free, on-chain).
 *
 * One WebSocket carries one subscription per watched account: the pump.fun
 * bonding curve while a token is on its curve, or its PumpSwap pool after it
 * graduates. Trades come from the programs' own events (see eventDecoder.ts),
 * at "confirmed" commitment.
 *
 * Failed transactions are counted, not traded: on busy pools most are bots
 * (seen live: 74% of 3,573 transactions in 20 s failed).
 */
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { HealthMonitor } from "../health/monitor.ts";
import { ReconnectingWs, type DataGap, type WsFactory } from "../net/wsClient.ts";
import { parseTradeLogs, type TradeEvent } from "./eventDecoder.ts";

export interface WatchTarget {
  /** Account to subscribe to: bonding curve or PumpSwap pool. */
  account: string;
  mint: string;
  venue: "pump_curve" | "pumpswap";
}

export interface TargetStats {
  txs: number;
  failedTxs: number;
  events: number;
  spoofed: number;
  truncated: number;
  lastEventAt?: number;
}

export interface TradeStreamOptions {
  url: string;
  factory: WsFactory;
  clock: Clock;
  health: HealthMonitor;
  logger: Logger;
  onTrades: (target: WatchTarget, events: TradeEvent[], receivedAt: number) => void;
  onGap?: (target: WatchTarget, gap: DataGap) => void;
  maxSilenceMs?: number;
}

export class TradeStream {
  private targets = new Map<string, WatchTarget>();
  /** RPC subscription id → account, valid for the current connection only. */
  private subIds = new Map<number, string>();
  private pending = new Map<number, string>();
  private reqId = 1;
  private ws: ReconnectingWs;
  public stats = new Map<string, TargetStats>();

  constructor(private readonly o: TradeStreamOptions) {
    this.ws = new ReconnectingWs({
      provider: "solana_ws",
      url: o.url,
      factory: o.factory,
      // Fresh request ids on every connect; old subscription ids die with the socket.
      subscribeMessages: () => {
        this.subIds.clear();
        this.pending.clear();
        return [...this.targets.keys()].map((a) => this.subscribeMsg(a));
      },
      // Quiet curves can go minutes without a trade; the socket itself has no heartbeat.
      maxSilenceMs: o.maxSilenceMs ?? 5 * 60_000,
      clock: o.clock,
      health: o.health,
      logger: o.logger,
      onMessage: (t) => this.onMessage(t),
      onGap: (g) => {
        for (const t of this.targets.values()) o.onGap?.(t, g);
      },
      maxMessageBytes: 256 * 1024,
    });
  }

  private subscribeMsg(account: string): string {
    const id = this.reqId++;
    this.pending.set(id, account);
    return JSON.stringify({ jsonrpc: "2.0", id, method: "logsSubscribe", params: [{ mentions: [account] }, { commitment: "confirmed" }] });
  }

  start(): void {
    this.ws.start();
  }

  stop(): void {
    this.ws.stop();
  }

  watched(): WatchTarget[] {
    return [...this.targets.values()];
  }

  add(t: WatchTarget): void {
    if (this.targets.has(t.account)) return;
    this.targets.set(t.account, t);
    this.stats.set(t.account, { txs: 0, failedTxs: 0, events: 0, spoofed: 0, truncated: 0 });
    if (this.ws.connected) this.ws.send(this.subscribeMsg(t.account));
  }

  remove(account: string): void {
    if (!this.targets.delete(account)) return;
    for (const [sub, acc] of this.subIds) {
      if (acc !== account) continue;
      this.subIds.delete(sub);
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id: this.reqId++, method: "logsUnsubscribe", params: [sub] }));
    }
  }

  private onMessage(text: string): void {
    let m: { id?: number; result?: unknown; error?: unknown; method?: string; params?: { subscription?: number; result?: unknown } };
    try {
      m = JSON.parse(text);
    } catch {
      this.o.health.recordSchemaReject("solana_ws");
      return;
    }
    if (typeof m.id === "number") {
      const acc = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (acc && typeof m.result === "number" && this.targets.has(acc)) this.subIds.set(m.result, acc);
      else if (acc && m.error) this.o.logger.warn("logsSubscribe refused", { account: acc });
      return;
    }
    if (m.method !== "logsNotification" || typeof m.params?.subscription !== "number") return;
    const acc = this.subIds.get(m.params.subscription);
    const target = acc ? this.targets.get(acc) : undefined;
    if (!target) return;
    const r = m.params.result as { context?: { slot?: unknown }; value?: { signature?: unknown; err?: unknown; logs?: unknown } } | undefined;
    const slot = r?.context?.slot;
    const v = r?.value;
    if (typeof slot !== "number" || typeof v?.signature !== "string" || !Array.isArray(v.logs) || v.logs.length > 2000) {
      this.o.health.recordSchemaReject("solana_ws");
      return;
    }
    const st = this.stats.get(target.account)!;
    st.txs++;
    this.o.health.recordEvent("solana_ws");
    if (v.err) {
      st.failedTxs++;
      return;
    }
    const p = parseTradeLogs(v.signature, slot, v.logs.filter((l): l is string => typeof l === "string"));
    st.spoofed += p.spoofed;
    if (p.truncated) st.truncated++;
    // A curve event names its mint; ignore events for other tokens in the same tx.
    const mine = p.events.filter((e) => (target.venue === "pump_curve" ? e.venue === "pump_curve" && e.mintOrPool === target.mint : e.venue === "pumpswap" && e.mintOrPool === target.account));
    if (!mine.length) return;
    st.events += mine.length;
    const now = this.o.clock.now();
    st.lastEventAt = now;
    this.o.onTrades(target, mine, now);
  }
}
