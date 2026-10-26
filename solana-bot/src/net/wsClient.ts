/**
 * Reconnecting WebSocket for data streams.
 *
 * - Re-sends subscriptions after every reconnect.
 * - Treats a silent stream as dead: closes and reconnects after `maxSilenceMs`.
 * - Records every disconnected window as a data gap, so downstream code knows
 *   events in that window may be missing.
 * - Drops oversized messages instead of parsing them.
 */
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { ProviderId } from "../core/types.ts";
import type { HealthMonitor } from "../health/monitor.ts";
import { backoffDelay } from "./backoff.ts";

/** The subset of the WHATWG WebSocket API we use. */
export interface WsLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WsFactory = (url: string) => WsLike;

export interface DataGap {
  provider: ProviderId;
  from: number;
  to: number;
  reason: string;
}

export interface ReconnectingWsOptions {
  provider: ProviderId;
  url: string;
  factory: WsFactory;
  subscribeMessages: string[];
  maxSilenceMs: number;
  clock: Clock;
  health: HealthMonitor;
  logger: Logger;
  onMessage: (text: string) => void;
  onGap?: (gap: DataGap) => void;
  maxMessageBytes?: number;
  backoff?: { baseMs: number; maxMs: number };
  random?: () => number;
}

export class ReconnectingWs {
  private ws: WsLike | undefined;
  private attempt = 0;
  private stopped = true;
  private silenceTimer: unknown;
  private reconnectTimer: unknown;
  /** Start of the current disconnected window, if any. */
  private downSince: number | undefined;
  private downReason = "starting";

  public stats = { connects: 0, disconnects: 0, messages: 0, oversizeDropped: 0, silenceReconnects: 0 };

  constructor(private readonly o: ReconnectingWsOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.downSince = this.o.clock.now();
    this.downReason = "starting";
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.o.clock.clearTimeout(this.silenceTimer);
    this.o.clock.clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onclose = null;
      ws.onmessage = null;
      ws.onerror = null;
      try {
        ws.close(1000, "stop");
      } catch {
        /* already closed */
      }
    }
    this.o.health.recordConnection(this.o.provider, false);
  }

  private connect(): void {
    if (this.stopped) return;
    let ws: WsLike;
    try {
      ws = this.o.factory(this.o.url);
    } catch (e) {
      this.o.health.recordFailure(this.o.provider, `connect: ${(e as Error).message}`);
      this.scheduleReconnect("connect threw");
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.attempt = 0;
      this.stats.connects++;
      this.o.health.recordConnection(this.o.provider, true);
      if (this.downSince !== undefined && this.stats.connects > 1) {
        this.o.onGap?.({ provider: this.o.provider, from: this.downSince, to: this.o.clock.now(), reason: this.downReason });
      }
      this.downSince = undefined;
      for (const m of this.o.subscribeMessages) ws.send(m);
      this.armSilence();
      this.o.logger.info("stream connected", { provider: this.o.provider });
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      const text = typeof ev.data === "string" ? ev.data : Buffer.isBuffer(ev.data) ? ev.data.toString("utf8") : String(ev.data);
      if (text.length > (this.o.maxMessageBytes ?? 64 * 1024)) {
        this.stats.oversizeDropped++;
        this.o.health.recordSchemaReject(this.o.provider);
        return;
      }
      this.stats.messages++;
      this.armSilence();
      try {
        this.o.onMessage(text);
      } catch (e) {
        this.o.logger.warn("message handler threw", { provider: this.o.provider, err: (e as Error).message });
      }
    };
    ws.onerror = () => {
      // Followed by onclose; reconnect is handled there.
      this.o.health.recordFailure(this.o.provider, "socket error");
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.handleDown(`closed${ev?.code ? ` (${ev.code})` : ""}`);
    };
  }

  private handleDown(reason: string): void {
    this.ws = undefined;
    this.o.clock.clearTimeout(this.silenceTimer);
    this.stats.disconnects++;
    this.o.health.recordConnection(this.o.provider, false);
    if (this.downSince === undefined) {
      this.downSince = this.o.clock.now();
      this.downReason = reason;
    }
    this.o.logger.warn("stream down", { provider: this.o.provider, reason });
    this.scheduleReconnect(reason);
  }

  private scheduleReconnect(reason: string): void {
    if (this.stopped) return;
    const delay = backoffDelay(this.attempt++, { ...(this.o.backoff ?? { baseMs: 1_000, maxMs: 60_000 }), random: this.o.random });
    this.o.logger.info("reconnecting", { provider: this.o.provider, inMs: delay, reason });
    this.reconnectTimer = this.o.clock.setTimeout(() => this.connect(), delay);
  }

  private armSilence(): void {
    this.o.clock.clearTimeout(this.silenceTimer);
    this.silenceTimer = this.o.clock.setTimeout(() => {
      const ws = this.ws;
      if (!ws) return;
      this.stats.silenceReconnects++;
      this.o.health.recordFailure(this.o.provider, "stream silent");
      ws.onclose = null;
      ws.onmessage = null;
      try {
        ws.close(4000, "silent");
      } catch {
        /* ignore */
      }
      this.handleDown("silent");
    }, this.o.maxSilenceMs);
  }

  /** Ms the stream has been down, or 0 if connected. */
  downForMs(): number {
    return this.downSince === undefined ? 0 : this.o.clock.now() - this.downSince;
  }
}
