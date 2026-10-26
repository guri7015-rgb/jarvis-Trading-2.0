import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import { silentLogger } from "../src/core/log.ts";
import { HealthMonitor } from "../src/health/monitor.ts";
import type { TradeEvent } from "../src/market/eventDecoder.ts";
import { TradeStream, type WatchTarget } from "../src/market/tradeStream.ts";
import { FakeSocket, fixtureJson } from "./helpers.ts";

const MINT = "AkWjwenr7Pg7F4pHgAftefCTXZPShgch9HKrwGstpump";
const CURVE = "GmnK5zJVb1RVFZhzVhLzWLRsCEsZLUDuJTAxrL19tvaS";
const target: WatchTarget = { account: CURVE, mint: MINT, venue: "pump_curve" };
const realTxs = fixtureJson<{ sig: string; slot: number; logs: string[] }[]>("logs-pump-curve.json");

function setup() {
  FakeSocket.instances = [];
  const clock = new FakeClock();
  const health = new HealthMonitor(clock);
  health.register("solana_ws", { kind: "stream", maxSilenceMs: 300_000, required: false });
  const got: TradeEvent[] = [];
  const gaps: string[] = [];
  const s = new TradeStream({
    url: "wss://x.invalid",
    factory: (u) => new FakeSocket(u),
    clock,
    health,
    logger: silentLogger,
    onTrades: (_t, evs) => got.push(...evs),
    onGap: (t) => gaps.push(t.mint),
  });
  return { s, clock, got, gaps };
}
const sock = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;
const ack = (id: number, sub: number) => sock().message(JSON.stringify({ jsonrpc: "2.0", id, result: sub }));
const note = (sub: number, tx: { sig: string; slot: number; logs: string[] }, err: unknown = null) =>
  sock().message(JSON.stringify({ jsonrpc: "2.0", method: "logsNotification", params: { subscription: sub, result: { context: { slot: tx.slot }, value: { signature: tx.sig, err, logs: tx.logs } } } }));

describe("TradeStream", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  it("subscribes, decodes real curve trades, and counts failed transactions without trading them", () => {
    const { s, got } = setup();
    s.add(target);
    s.start();
    sock().open();
    const sent = JSON.parse(sock().sent[0]!);
    expect(sent).toMatchObject({ method: "logsSubscribe", params: [{ mentions: [CURVE] }, { commitment: "confirmed" }] });
    ack(sent.id, 77);
    for (const tx of realTxs) note(77, tx);
    note(77, realTxs[0]!, { InstructionError: [0, "Custom"] });
    expect(got).toHaveLength(9);
    expect(s.stats.get(CURVE)).toMatchObject({ txs: 11, failedTxs: 1, events: 9 });
  });

  it("ignores notifications for unknown subscriptions and malformed payloads", () => {
    const { s, got } = setup();
    s.add(target);
    s.start();
    sock().open();
    ack(JSON.parse(sock().sent[0]!).id, 5);
    note(999, realTxs[0]!);
    sock().message("not json");
    sock().message(JSON.stringify({ method: "logsNotification", params: { subscription: 5, result: { value: { logs: "x" } } } }));
    expect(got).toHaveLength(0);
  });

  it("ignores events for a different mint carried in the same transaction", () => {
    const { s, got } = setup();
    s.add({ ...target, mint: "So11111111111111111111111111111111111111112" });
    s.start();
    sock().open();
    ack(JSON.parse(sock().sent[0]!).id, 5);
    note(5, realTxs[0]!);
    expect(got).toHaveLength(0);
  });

  it("re-subscribes everything after a drop, records the gap, and unsubscribes on remove", async () => {
    const { s, clock, gaps } = setup();
    s.add(target);
    s.start();
    sock().open();
    ack(JSON.parse(sock().sent[0]!).id, 5);
    sock().drop();
    await clock.advance(2_000);
    sock().open();
    expect(JSON.parse(sock().sent[0]!).method).toBe("logsSubscribe");
    expect(gaps).toEqual([MINT]);
    ack(JSON.parse(sock().sent[0]!).id, 6);
    s.remove(CURVE);
    expect(JSON.parse(sock().sent[1]!)).toMatchObject({ method: "logsUnsubscribe", params: [6] });
    expect(s.watched()).toHaveLength(0);
  });
});
