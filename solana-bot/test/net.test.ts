import { describe, expect, it } from "vitest";
import { z } from "zod";
import { FakeClock } from "../src/core/clock.ts";
import { HealthMonitor } from "../src/health/monitor.ts";
import { backoffDelay } from "../src/net/backoff.ts";
import { HttpClient, HttpError, rateLimitResetAt, SchemaError } from "../src/net/http.ts";
import { RateLimiter } from "../src/net/rateLimiter.ts";
import { TtlCache } from "../src/net/ttlCache.ts";
import { ImmediateClock, scriptedFetch } from "./helpers.ts";

function client(responses: Parameters<typeof scriptedFetch>[0], clock = new ImmediateClock()) {
  const health = new HealthMonitor(clock);
  health.register("geckoterminal", { kind: "poll", maxSilenceMs: 60_000, required: false });
  const limiter = new RateLimiter(2, 1, clock);
  const f = scriptedFetch(responses);
  const http = new HttpClient({ fetch: f.fetch, clock, health, limiters: { geckoterminal: limiter }, random: () => 0.5, maxBodyBytes: 1000 });
  return { http, health, limiter, calls: f.calls, clock };
}
const Ok = z.object({ ok: z.literal(true) });
const req = { provider: "geckoterminal" as const, url: "https://x.invalid/a", schema: Ok };

describe("backoff", () => {
  it("grows exponentially, is capped, and never drops below a quarter step", () => {
    const o = { baseMs: 100, maxMs: 1000 };
    expect(backoffDelay(0, { ...o, random: () => 0 })).toBe(25);
    expect(backoffDelay(3, { ...o, random: () => 1 })).toBe(800);
    expect(backoffDelay(10, { ...o, random: () => 1 })).toBe(1000);
  });
});

describe("RateLimiter", () => {
  it("waits for tokens once the burst is spent", async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(2, 1, clock);
    await rl.acquire();
    await rl.acquire();
    let third = false;
    void rl.acquire().then(() => (third = true));
    await clock.advance(500);
    expect(third).toBe(false);
    await clock.advance(600);
    expect(third).toBe(true);
  });

  it("blocks until a 429 reset time", async () => {
    const clock = new FakeClock();
    const rl = new RateLimiter(5, 5, clock);
    rl.penalize(clock.now() + 10_000);
    let done = false;
    void rl.acquire().then(() => (done = true));
    await clock.advance(9_000);
    expect(done).toBe(false);
    await clock.advance(1_500);
    expect(done).toBe(true);
  });
});

describe("TtlCache", () => {
  it("expires entries and caps size", () => {
    const clock = new FakeClock();
    const c = new TtlCache<number>(clock, 2);
    c.set("a", 1, 1000);
    expect(c.get("a")).toBe(1);
    void clock.advance(1001);
    expect(c.get("a")).toBeUndefined();
    c.set("b", 2, 1000);
    c.set("c", 3, 1000);
    c.set("d", 4, 1000);
    expect(c.size).toBe(2);
    expect(c.get("b")).toBeUndefined();
  });
});

describe("rateLimitResetAt", () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null });
  it("reads Retry-After seconds, Jupiter unix-seconds reset, and falls back", () => {
    const now = 1_700_000_000_000;
    expect(rateLimitResetAt(h({ "retry-after": "7" }), now, 1)).toBe(now + 7000);
    expect(rateLimitResetAt(h({ "x-ratelimit-reset": String(now / 1000 + 30) }), now, 1)).toBe(now + 30_000);
    expect(rateLimitResetAt(h({ "x-ratelimit-reset": "garbage" }), now, 5000)).toBe(now + 5000);
    // A reset hint a day away is ignored, not trusted.
    expect(rateLimitResetAt(h({ "retry-after": "86400" }), now, 5000)).toBe(now + 5000);
  });
});

describe("HttpClient", () => {
  it("on 429 blocks the provider until the reset, records it, then retries", async () => {
    const { http, health, limiter, calls, clock } = client([
      { status: 429, headers: { "x-ratelimit-reset": String(1_700_000_000 + 20) } },
      { status: 200, body: '{"ok":true}' },
    ]);
    await expect(http.request(req)).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(health.get("geckoterminal").rateLimitHits).toBe(1);
    expect(limiter.blockedUntilMs).toBe(1_700_000_020_000);
    expect(clock.now()).toBeGreaterThanOrEqual(1_700_000_020_000);
  });

  it("retries 5xx a bounded number of times, then fails and marks the provider DOWN", async () => {
    const { http, health, calls } = client([{ status: 502 }, { status: 503 }, { status: 500 }]);
    await expect(http.request(req)).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(3);
    expect(health.get("geckoterminal").status).toBe("DOWN");
  });

  it("does not retry a 404", async () => {
    const { http, calls } = client([{ status: 404 }, { status: 200, body: '{"ok":true}' }]);
    await expect(http.request(req)).rejects.toMatchObject({ status: 404, retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("rejects invalid JSON and schema mismatches without retrying", async () => {
    const a = client([{ status: 200, body: "<html>" }]);
    await expect(a.http.request(req)).rejects.toBeInstanceOf(SchemaError);
    expect(a.health.get("geckoterminal").schemaRejects).toBe(1);
    const b = client([{ status: 200, body: '{"ok":"yes"}' }]);
    await expect(b.http.request(req)).rejects.toBeInstanceOf(SchemaError);
    expect(b.calls).toHaveLength(1);
  });

  it("refuses oversized responses", async () => {
    const { http } = client([{ status: 200, body: "x".repeat(5000) }]);
    await expect(http.request({ ...req, maxRetries: 0 })).rejects.toThrow(/too large/);
  });

  it("times out a hung request and counts it as a failure", async () => {
    const { http, health } = client(["hang"]);
    await expect(http.request({ ...req, timeoutMs: 30, maxRetries: 0 })).rejects.toThrow(/timeout/);
    expect(health.get("geckoterminal").lastFailure).toBe("timeout");
  });

  it("serves cached GETs without another request", async () => {
    const { http, calls } = client([{ status: 200, body: '{"ok":true}' }]);
    await http.request({ ...req, cacheTtlMs: 10_000 });
    await http.request({ ...req, cacheTtlMs: 10_000 });
    expect(calls).toHaveLength(1);
  });

  it("recovers after a network error", async () => {
    const { http, health } = client([new Error("ECONNRESET"), { status: 200, body: '{"ok":true}' }]);
    await expect(http.request(req)).resolves.toEqual({ ok: true });
    expect(health.get("geckoterminal").consecutiveFailures).toBe(0);
  });
});
