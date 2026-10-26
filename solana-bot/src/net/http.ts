/**
 * HTTP client for provider APIs.
 *
 * - One rate limiter per provider. A 429 blocks that provider until its reset time.
 * - Bounded retries with backoff on 429, 5xx and network errors. Other 4xx fail fast.
 * - Response size cap, so a hostile or broken provider can't exhaust memory.
 * - Every payload is validated with a schema before anyone uses it.
 * - Optional TTL cache for GETs.
 */
import type { z } from "zod";
import type { Clock } from "../core/clock.ts";
import type { ProviderId } from "../core/types.ts";
import type { HealthMonitor } from "../health/monitor.ts";
import { backoffDelay } from "./backoff.ts";
import type { RateLimiter } from "./rateLimiter.ts";
import { TtlCache } from "./ttlCache.ts";

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export class SchemaError extends Error {}

/**
 * A 4xx the provider uses for a normal answer (e.g. Jupiter's 400 "no route").
 * The provider is healthy; the answer is just "no". Carries the parsed JSON body.
 */
export class ExpectedHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(`HTTP ${status}`);
  }
}

export interface RequestOptions<S extends z.ZodType> {
  provider: ProviderId;
  url: string;
  schema: S;
  method?: "GET" | "POST";
  body?: unknown;
  headers?: Record<string, string>;
  cacheTtlMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** 4xx statuses that are normal answers, not provider failures. */
  expectedErrorStatuses?: number[];
}

export interface HttpClientOptions {
  fetch: FetchLike;
  clock: Clock;
  health: HealthMonitor;
  limiters: Partial<Record<ProviderId, RateLimiter>>;
  maxBodyBytes?: number;
  random?: () => number;
}

/** Parse a provider's rate-limit reset hint into an absolute ms time. */
export function rateLimitResetAt(headers: { get(name: string): string | null }, now: number, fallbackMs: number): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0 && secs < 3600) return now + secs * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date) && date > now && date - now < 3_600_000) return date;
  }
  const reset = headers.get("x-ratelimit-reset");
  if (reset) {
    const n = Number(reset);
    // Jupiter sends unix seconds. Some providers send seconds-until-reset.
    if (Number.isFinite(n)) {
      if (n > 1e9 && n * 1000 > now && n * 1000 - now < 3_600_000) return n * 1000;
      if (n >= 0 && n < 3600) return now + n * 1000;
    }
  }
  return now + fallbackMs;
}

export class HttpClient {
  private cache: TtlCache<unknown>;
  private readonly maxBody: number;

  constructor(private readonly o: HttpClientOptions) {
    this.cache = new TtlCache(o.clock);
    this.maxBody = o.maxBodyBytes ?? 4 * 1024 * 1024;
  }

  async request<S extends z.ZodType>(opts: RequestOptions<S>): Promise<z.infer<S>> {
    const method = opts.method ?? "GET";
    const cacheKey = method === "GET" && opts.cacheTtlMs ? opts.url : undefined;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit !== undefined) return hit as z.infer<S>;
    }
    const maxRetries = opts.maxRetries ?? 2;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const value = await this.once(opts, method);
        if (cacheKey) this.cache.set(cacheKey, value, opts.cacheTtlMs!);
        return value;
      } catch (e) {
        lastErr = e;
        if (e instanceof ExpectedHttpError) throw e;
        const retryable = e instanceof HttpError ? e.retryable : !(e instanceof SchemaError);
        if (!retryable || attempt === maxRetries) break;
        await this.o.clock.sleep(backoffDelay(attempt, { baseMs: 500, maxMs: 8_000, random: this.o.random }));
      }
    }
    throw lastErr;
  }

  private async once<S extends z.ZodType>(opts: RequestOptions<S>, method: string): Promise<z.infer<S>> {
    const { provider } = opts;
    const limiter = this.o.limiters[provider];
    if (limiter) await limiter.acquire();

    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10_000);
    let res;
    try {
      const headers: Record<string, string> = { accept: "application/json", ...(opts.headers ?? {}) };
      if (opts.body !== undefined) headers["content-type"] = "application/json";
      res = await this.o.fetch(opts.url, {
        method,
        headers,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      const msg = ctrl.signal.aborted ? "timeout" : `network: ${(e as Error).message}`;
      this.o.health.recordFailure(provider, msg);
      throw new HttpError(msg, 0, true);
    }

    try {
      if (res.status === 429) {
        const until = rateLimitResetAt(res.headers, this.o.clock.now(), 10_000);
        limiter?.penalize(until);
        this.o.health.recordRateLimited(provider, until);
        throw new HttpError("rate limited (429)", 429, true);
      }
      const text = await readCapped(res, this.maxBody);
      if (res.status >= 500) {
        this.o.health.recordFailure(provider, `HTTP ${res.status}`);
        throw new HttpError(`HTTP ${res.status}`, res.status, true);
      }
      if (res.status >= 400 && opts.expectedErrorStatuses?.includes(res.status)) {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
        this.o.health.recordSuccess(provider);
        throw new ExpectedHttpError(res.status, body);
      }
      if (res.status >= 400) {
        this.o.health.recordFailure(provider, `HTTP ${res.status}`);
        throw new HttpError(`HTTP ${res.status}`, res.status, false);
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        this.o.health.recordFailure(provider, "invalid JSON");
        this.o.health.recordSchemaReject(provider);
        throw new SchemaError(`${provider}: invalid JSON`);
      }
      const parsed = opts.schema.safeParse(json);
      if (!parsed.success) {
        this.o.health.recordFailure(provider, "schema mismatch");
        this.o.health.recordSchemaReject(provider);
        throw new SchemaError(`${provider}: response failed schema: ${parsed.error.issues[0]?.path.join(".") ?? "?"}`);
      }
      this.o.health.recordSuccess(provider);
      return parsed.data;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readCapped(res: { text(): Promise<string>; headers: { get(n: string): string | null } }, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new HttpError(`response too large (${declared} bytes)`, 0, false);
  const text = await res.text();
  if (text.length > max) throw new HttpError(`response too large (${text.length} chars)`, 0, false);
  return text;
}
