/**
 * Provider health and data freshness.
 *
 * Every provider reports successes, failures, rate limits and events here.
 * `gate()` answers one question for downstream code: is discovery data fresh
 * enough to act on? It fails closed.
 */
import type { Clock } from "../core/clock.ts";
import type { ProviderId } from "../core/types.ts";

export type HealthStatus = "UP" | "DEGRADED" | "DOWN" | "UNKNOWN";

export interface ProviderSpec {
  kind: "stream" | "poll" | "rpc";
  /** No success/event for longer than this means the data is stale. */
  maxSilenceMs: number;
  /** Whether discovery is unusable without this provider. */
  required: boolean;
}

export interface ProviderHealth {
  provider: ProviderId;
  kind: ProviderSpec["kind"];
  status: HealthStatus;
  reason: string;
  lastSuccessAt?: number;
  lastEventAt?: number;
  lastFailureAt?: number;
  lastFailure?: string;
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
  rateLimitHits: number;
  rateLimitedUntil?: number;
  connected?: boolean;
  disconnects: number;
  schemaRejects: number;
  registeredAt: number;
}

const DOWN_AFTER_FAILURES = 3;

export class HealthMonitor {
  private specs = new Map<ProviderId, ProviderSpec>();
  private state = new Map<ProviderId, Omit<ProviderHealth, "status" | "reason">>();

  constructor(private readonly clock: Clock) {}

  register(provider: ProviderId, spec: ProviderSpec): void {
    this.specs.set(provider, spec);
    this.state.set(provider, {
      provider,
      kind: spec.kind,
      consecutiveFailures: 0,
      totalSuccesses: 0,
      totalFailures: 0,
      rateLimitHits: 0,
      disconnects: 0,
      schemaRejects: 0,
      registeredAt: this.clock.now(),
    });
  }

  private s(p: ProviderId) {
    const st = this.state.get(p);
    if (!st) throw new Error(`Provider not registered: ${p}`);
    return st;
  }

  recordSuccess(p: ProviderId): void {
    const st = this.s(p);
    st.lastSuccessAt = this.clock.now();
    st.consecutiveFailures = 0;
    st.totalSuccesses++;
  }

  /** A data event arrived (stream message, polled item). Counts as freshness. */
  recordEvent(p: ProviderId): void {
    const st = this.s(p);
    st.lastEventAt = this.clock.now();
  }

  recordFailure(p: ProviderId, reason: string): void {
    const st = this.s(p);
    st.lastFailureAt = this.clock.now();
    st.lastFailure = reason.slice(0, 200);
    st.consecutiveFailures++;
    st.totalFailures++;
  }

  recordSchemaReject(p: ProviderId): void {
    this.s(p).schemaRejects++;
  }

  recordRateLimited(p: ProviderId, untilMs: number): void {
    const st = this.s(p);
    st.rateLimitHits++;
    st.rateLimitedUntil = Math.max(st.rateLimitedUntil ?? 0, untilMs);
  }

  recordConnection(p: ProviderId, connected: boolean): void {
    const st = this.s(p);
    if (st.connected && !connected) st.disconnects++;
    st.connected = connected;
    if (connected) {
      st.consecutiveFailures = 0;
      st.lastSuccessAt = this.clock.now();
    }
  }

  get(p: ProviderId): ProviderHealth {
    const st = this.s(p);
    const spec = this.specs.get(p)!;
    const now = this.clock.now();
    const { status, reason } = this.evaluate(st, spec, now);
    return { ...st, status, reason };
  }

  private evaluate(st: Omit<ProviderHealth, "status" | "reason">, spec: ProviderSpec, now: number): { status: HealthStatus; reason: string } {
    if (st.consecutiveFailures >= DOWN_AFTER_FAILURES) return { status: "DOWN", reason: `${st.consecutiveFailures} consecutive failures` };
    if (spec.kind === "stream" && st.connected === false) return { status: "DOWN", reason: "disconnected" };
    // Freshness: streams need events, polls/rpc need successful calls.
    const fresh = spec.kind === "stream" ? st.lastEventAt : st.lastSuccessAt;
    if (fresh === undefined) {
      return now - st.registeredAt > spec.maxSilenceMs
        ? { status: "DOWN", reason: "no data since start" }
        : { status: "UNKNOWN", reason: "waiting for first data" };
    }
    const age = now - fresh;
    if (age > spec.maxSilenceMs) return { status: "DEGRADED", reason: `stale: ${Math.round(age / 1000)}s since last data` };
    if (st.rateLimitedUntil && st.rateLimitedUntil > now) return { status: "DEGRADED", reason: "rate limited" };
    if (st.consecutiveFailures > 0) return { status: "DEGRADED", reason: `recent failure: ${st.lastFailure ?? ""}` };
    return { status: "UP", reason: "ok" };
  }

  snapshot(): ProviderHealth[] {
    return [...this.state.keys()].map((p) => this.get(p));
  }

  /**
   * Discovery gate. Open only when every required provider is UP and at least
   * one real-time discovery source is UP. Any doubt keeps it closed.
   */
  gate(): { open: boolean; reasons: string[] } {
    const reasons: string[] = [];
    let anyStreamUp = false;
    for (const [p, spec] of this.specs) {
      const h = this.get(p);
      if (spec.kind === "stream" && h.status === "UP") anyStreamUp = true;
      if (spec.required && h.status !== "UP") reasons.push(`${p} ${h.status}: ${h.reason}`);
    }
    if (!anyStreamUp) reasons.push("no real-time discovery stream is UP");
    return { open: reasons.length === 0, reasons };
  }
}
