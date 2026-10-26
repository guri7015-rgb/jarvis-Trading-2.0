import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import { HealthMonitor } from "../src/health/monitor.ts";

function monitor() {
  const clock = new FakeClock();
  const h = new HealthMonitor(clock);
  h.register("pumpportal", { kind: "stream", maxSilenceMs: 60_000, required: false });
  h.register("geckoterminal", { kind: "poll", maxSilenceMs: 80_000, required: false });
  h.register("solana_rpc", { kind: "rpc", maxSilenceMs: 180_000, required: true });
  return { clock, h };
}

describe("HealthMonitor", () => {
  it("starts UNKNOWN and fails closed", () => {
    const { h } = monitor();
    expect(h.get("pumpportal").status).toBe("UNKNOWN");
    const g = h.gate();
    expect(g.open).toBe(false);
    expect(g.reasons.join(" ")).toMatch(/no real-time discovery stream/);
  });

  it("opens only when a stream is UP and every required provider is UP", () => {
    const { h } = monitor();
    h.recordConnection("pumpportal", true);
    h.recordEvent("pumpportal");
    expect(h.gate().open).toBe(false); // rpc not yet UP
    h.recordSuccess("solana_rpc");
    expect(h.gate()).toEqual({ open: true, reasons: [] });
  });

  it("marks stale data DEGRADED and closes the gate", async () => {
    const { h, clock } = monitor();
    h.recordConnection("pumpportal", true);
    h.recordEvent("pumpportal");
    h.recordSuccess("solana_rpc");
    await clock.advance(61_000);
    expect(h.get("pumpportal").status).toBe("DEGRADED");
    expect(h.get("pumpportal").reason).toMatch(/stale/);
    expect(h.gate().open).toBe(false);
  });

  it("goes DOWN after three consecutive failures and recovers on success", () => {
    const { h } = monitor();
    h.recordSuccess("geckoterminal");
    h.recordFailure("geckoterminal", "HTTP 500");
    expect(h.get("geckoterminal").status).toBe("DEGRADED");
    h.recordFailure("geckoterminal", "HTTP 500");
    h.recordFailure("geckoterminal", "HTTP 500");
    expect(h.get("geckoterminal").status).toBe("DOWN");
    h.recordSuccess("geckoterminal");
    expect(h.get("geckoterminal").status).toBe("UP");
  });

  it("reports rate limiting as DEGRADED until the reset passes", async () => {
    const { h, clock } = monitor();
    h.recordSuccess("geckoterminal");
    h.recordRateLimited("geckoterminal", clock.now() + 10_000);
    expect(h.get("geckoterminal").status).toBe("DEGRADED");
    h.recordSuccess("geckoterminal");
    await clock.advance(11_000);
    h.recordSuccess("geckoterminal");
    expect(h.get("geckoterminal").status).toBe("UP");
  });

  it("a disconnected stream is DOWN and counted", () => {
    const { h } = monitor();
    h.recordConnection("pumpportal", true);
    h.recordEvent("pumpportal");
    h.recordConnection("pumpportal", false);
    expect(h.get("pumpportal").status).toBe("DOWN");
    expect(h.get("pumpportal").disconnects).toBe(1);
  });

  it("a provider that never delivers goes DOWN after its silence window", async () => {
    const { h, clock } = monitor();
    await clock.advance(81_000);
    expect(h.get("geckoterminal").status).toBe("DOWN");
  });
});
