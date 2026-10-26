import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import { silentLogger } from "../src/core/log.ts";
import { HealthMonitor } from "../src/health/monitor.ts";
import { ReconnectingWs, type DataGap } from "../src/net/wsClient.ts";
import { FakeSocket } from "./helpers.ts";

function setup() {
  const clock = new FakeClock();
  const health = new HealthMonitor(clock);
  health.register("pumpportal", { kind: "stream", maxSilenceMs: 60_000, required: false });
  const got: string[] = [];
  const gaps: DataGap[] = [];
  const ws = new ReconnectingWs({
    provider: "pumpportal",
    url: "wss://x.invalid",
    factory: (u) => new FakeSocket(u),
    subscribeMessages: ['{"method":"subscribeNewToken"}'],
    maxSilenceMs: 60_000,
    clock,
    health,
    logger: silentLogger,
    onMessage: (t) => got.push(t),
    onGap: (g) => gaps.push(g),
    maxMessageBytes: 100,
    backoff: { baseMs: 1000, maxMs: 10_000 },
    random: () => 1,
  });
  return { clock, health, ws, got, gaps };
}

const last = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

describe("ReconnectingWs", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  it("subscribes on open and delivers messages", () => {
    const { ws, got, health } = setup();
    ws.start();
    last().open();
    expect(last().sent).toEqual(['{"method":"subscribeNewToken"}']);
    last().message('{"a":1}');
    expect(got).toEqual(['{"a":1}']);
    expect(health.get("pumpportal").connected).toBe(true);
  });

  it("reconnects with backoff after a drop, re-subscribes, and records the gap", async () => {
    const { ws, clock, gaps, health } = setup();
    ws.start();
    last().open();
    await clock.advance(5_000);
    last().drop();
    expect(health.get("pumpportal").status).toBe("DOWN");
    expect(FakeSocket.instances).toHaveLength(1);
    await clock.advance(1_000); // backoff attempt 0 with random=1 → 1000ms
    expect(FakeSocket.instances).toHaveLength(2);
    await clock.advance(2_000);
    last().open();
    expect(last().sent).toEqual(['{"method":"subscribeNewToken"}']);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.to - gaps[0]!.from).toBe(3_000);
    expect(gaps[0]!.reason).toMatch(/closed/);
  });

  it("treats a silent stream as dead and reconnects", async () => {
    const { ws, clock } = setup();
    ws.start();
    last().open();
    await clock.advance(61_000);
    expect(ws.stats.silenceReconnects).toBe(1);
    expect(FakeSocket.instances[0]!.closed).toBe(true);
    await clock.advance(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("messages keep the silence timer from firing", async () => {
    const { ws, clock } = setup();
    ws.start();
    last().open();
    for (let i = 0; i < 5; i++) {
      await clock.advance(30_000);
      last().message("{}");
    }
    expect(ws.stats.silenceReconnects).toBe(0);
  });

  it("drops oversized messages without parsing them", () => {
    const { ws, got, health } = setup();
    ws.start();
    last().open();
    last().message("x".repeat(500));
    expect(got).toHaveLength(0);
    expect(ws.stats.oversizeDropped).toBe(1);
    expect(health.get("pumpportal").schemaRejects).toBe(1);
  });

  it("does not reconnect after stop()", async () => {
    const { ws, clock } = setup();
    ws.start();
    last().open();
    ws.stop();
    await clock.advance(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(clock.pendingTimers()).toBe(0);
  });

  it("backs off further on repeated failures", async () => {
    const { ws, clock } = setup();
    ws.start();
    last().drop(); // never opened
    await clock.advance(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
    last().drop();
    await clock.advance(1_000);
    expect(FakeSocket.instances).toHaveLength(2); // second wait is 2000ms
    await clock.advance(1_000);
    expect(FakeSocket.instances).toHaveLength(3);
  });
});
