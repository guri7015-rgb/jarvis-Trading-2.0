import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import { silentLogger } from "../src/core/log.ts";
import { HealthMonitor } from "../src/health/monitor.ts";
import type { TradeEvent } from "../src/market/eventDecoder.ts";
import { MoverScanner } from "../src/market/firehose.ts";
import { FakeSocket } from "./helpers.ts";

const T = Date.parse("2026-10-27T02:00:00Z");

function scanner() {
  const clock = new FakeClock(T);
  const health = new HealthMonitor(clock);
  health.register("solana_firehose", { kind: "stream", maxSilenceMs: 60_000, required: false });
  const sc = new MoverScanner({ url: "wss://x", factory: (u) => new FakeSocket(u), clock, health, logger: silentLogger });
  return { sc, clock };
}

const ev = (key: string, side: "buy" | "sell", wallet: string, sol: number, price: number, venue: "pump_curve" | "pumpswap" = "pumpswap"): TradeEvent => ({
  venue,
  signature: `${key}:${wallet}:${sol}`,
  eventIndex: 0,
  slot: 1,
  blockTimeMs: T,
  side,
  wallet,
  mintOrPool: key,
  quoteAmount: BigInt(Math.round(sol * 1e9)),
  tokenAmount: BigInt(Math.round((sol / price) * 1e6)),
});

describe("mover scanner", () => {
  it("ranks a coin with many fresh buyers and a rising price, and ignores quiet or already-run coins", () => {
    const { sc } = scanner();
    // HOT: 20 buyers over 60 s, price up 10%, still trading in the last 15 s.
    for (let i = 0; i < 20; i++) sc.ingest([ev("HOT", "buy", `w${i}`, 0.3, 1e-6 * (1 + i * 0.005))], T - 55_000 + i * 2_800);
    // QUIET: 5 trades only.
    for (let i = 0; i < 5; i++) sc.ingest([ev("QUIET", "buy", `q${i}`, 0.3, 1e-6)], T - 30_000 + i * 1000);
    // RAN: 20 buyers but up 150% already.
    for (let i = 0; i < 20; i++) sc.ingest([ev("RAN", "buy", `r${i}`, 0.3, 1e-6 * (1 + i * 0.08))], T - 55_000 + i * 2_800);
    // DUMP: 20 trades, all sells.
    for (let i = 0; i < 20; i++) sc.ingest([ev("DUMP", "sell", `d${i}`, 0.3, 1e-6 * (1 - i * 0.01))], T - 55_000 + i * 2_800);
    const m = sc.movers(T, 10);
    expect(m.map((x) => x.key)).toEqual(["HOT"]);
    expect(m[0]!.buyers60).toBe(20);
    expect(m[0]!.ret60).toBeCloseTo(0.1, 1);
    expect(m[0]!.trades15).toBeGreaterThanOrEqual(3);
  });

  it("drops trades that cannot be SOL-quoted and forgets idle coins", () => {
    const { sc } = scanner();
    sc.ingest([ev("USDCPOOL", "buy", "w", 25_000, 1)], T);
    expect(sc.stats.notSolQuoted).toBe(1);
    expect(sc.recent("USDCPOOL")).toHaveLength(0);
    sc.ingest([ev("OLD", "buy", "w", 0.1, 1e-6)], T - 400_000);
    sc.movers(T);
    expect(sc.recent("OLD")).toHaveLength(0);
  });

  it("keeps recent ticks for backfilling a new watch, oldest first", () => {
    const { sc } = scanner();
    sc.ingest([ev("K", "buy", "a", 0.1, 1e-6)], T - 20_000);
    sc.ingest([ev("K", "sell", "b", 0.2, 1.1e-6)], T - 10_000);
    const r = sc.recent("K");
    expect(r.map((x) => x.side)).toEqual(["buy", "sell"]);
    expect(r[1]!.price).toBeCloseTo(1.1e-6, 12);
  });
});
