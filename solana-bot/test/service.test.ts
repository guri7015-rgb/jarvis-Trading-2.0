/**
 * End-to-end discovery with fake network: stream + pollers → registry → confirmation,
 * including a stream outage.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import { silentLogger } from "../src/core/log.ts";
import { DiscoveryService, registerProviders } from "../src/app/discoveryService.ts";
import { HealthMonitor } from "../src/health/monitor.ts";
import { HttpClient, type FetchLike } from "../src/net/http.ts";
import { CallBudget, SolanaRpc } from "../src/solana/rpc.ts";
import { openDb } from "../src/storage/db.ts";
import { FakeSocket, fixture, fixtureJson, PUMP_CURVE, PUMP_MINT, testConfig } from "./helpers.ts";

/** Route requests by URL to canned bodies. */
function router(clock: FakeClock): FetchLike {
  const rpcFx = fixtureJson<{ result: { value: unknown[] } }>("rpc-getMultipleAccounts.json");
  return async (url, init) => {
    let body: string;
    if (url.includes("geckoterminal")) body = fixture("geckoterminal-new-pools.json");
    else if (url.includes("jup.ag")) body = fixture("jupiter-tokens-recent.json");
    else if (url.includes("rpc.invalid")) {
      const req = JSON.parse(init.body!);
      if (req.method === "getSlot") body = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: Math.floor(clock.now() / 400) });
      else {
        // Serve the real mint + curve fixture for the pump token; null for everything else.
        const value = (req.params[0] as string[]).map((a) => (a === PUMP_MINT ? rpcFx.result.value[0] : a === PUMP_CURVE ? rpcFx.result.value[1] : null));
        body = JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { context: { slot: 999 }, value } });
      }
    } else throw new Error(`unexpected url ${url}`);
    return { status: 200, headers: { get: () => null }, text: async () => body };
  };
}

function setup() {
  FakeSocket.instances = [];
  const clock = new FakeClock(Date.parse("2026-10-26T07:05:00Z"));
  const cfg = testConfig();
  const health = new HealthMonitor(clock);
  registerProviders(health, cfg);
  const http = new HttpClient({ fetch: router(clock), clock, health, limiters: {} });
  const db = openDb(":memory:");
  const budget = new CallBudget(1000, clock);
  const rpc = new SolanaRpc(http, cfg.SOLANA_RPC_URL, budget);
  const svc = new DiscoveryService({ cfg, clock, logger: silentLogger, db, http, health, rpc, budget, wsFactory: (u) => new FakeSocket(u) });
  return { clock, svc, db, health };
}

const ws = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

describe("DiscoveryService", () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  it("ingests stream and poll data, dedupes, confirms on-chain, and opens the gate only when fresh", async () => {
    const { clock, svc, health } = setup();
    svc.start();
    expect(svc.status().gate.open).toBe(false);
    ws().open();
    for (const line of fixture("pumpportal-messages.jsonl").trim().split("\n")) ws().message(line);
    ws().message(fixture("pumpportal-messages.jsonl").trim().split("\n")[2]!); // provider repeats itself
    await clock.advance(1_000);

    const s = svc.status();
    expect(s.counters.duplicates.pumpportal).toBe(1);
    expect(s.counters.newTokens.pumpportal).toBe(4); // 2 creates + 2 migrations of other mints
    // Pollers overlap: a mint is "new" only for whichever provider reported it first.
    const gecko = fixtureJson<{ data: { relationships: { base_token: { data: { id: string } } } }[] }>("geckoterminal-new-pools.json").data.map((p) =>
      p.relationships.base_token.data.id.slice(7),
    );
    const jup = fixtureJson<{ id: string; firstPool?: unknown }[]>("jupiter-tokens-recent.json").filter((t) => t.firstPool).map((t) => t.id);
    const pp = [PUMP_MINT, "532EPZppGdHgf5dwdMf4pmAihrMshbnKCotnEFEDKxHP", "5D71hSvYijvG7nxLEMbU9ZPcjuNPBqFG4Hsjurwapump", "CaMxPgtjG52joSEFEVEixuwpaRbvgMp31wS6akXDpump"];
    expect(s.tokens).toBe(new Set([...gecko, ...jup, ...pp]).size);
    expect((s.counters.newTokens.geckoterminal ?? 0) + (s.counters.newTokens.jupiter_tokens ?? 0)).toBe(s.tokens - 4);
    expect(health.get("solana_rpc").status).toBe("UP");
    expect(s.gate.open).toBe(true);

    // Confirmation does real async work (PDA hashing), which a fake clock can't
    // sequence reliably. Stop the timers, wait out any in-flight batch, then drain.
    svc.stop();
    await new Promise((r) => setTimeout(r, 50));
    while ((await svc.confirmer.runBatch()) > 0) {
      if (svc.registry.get(PUMP_MINT)!.confirm_status === "CONFIRMED") break;
    }
    const t = svc.registry.get(PUMP_MINT)!;
    expect(t.confirm_status).toBe("CONFIRMED");
    expect(t.curve_key_matches).toBe(1);
    expect(t.confirmed_slot).toBe(999);
  });

  it("closes the gate during a stream outage and records the gap", async () => {
    const { clock, svc, db } = setup();
    svc.start();
    ws().open();
    ws().message(fixture("pumpportal-messages.jsonl").trim().split("\n")[2]!);
    await clock.advance(1_000);
    expect(svc.status().gate.open).toBe(true);

    ws().drop();
    expect(svc.status().gate.open).toBe(false);
    expect(svc.status().gate.reasons.join(" ")).toMatch(/no real-time discovery stream/);
    await clock.advance(30_000);
    ws().open();
    ws().message("{}"); // any data counts as freshness only via parsed events/acks
    ws().message('{"message":"Successfully subscribed to token creation events."}');
    expect(svc.status().gate.open).toBe(true);
    const gaps = db.prepare("SELECT * FROM gaps WHERE provider = 'pumpportal'").all();
    expect(gaps).toHaveLength(1);
    svc.stop();
  });

  it("goes stale and closes the gate when the stream stops sending", async () => {
    const { clock, svc } = setup();
    svc.start();
    ws().open();
    ws().message(fixture("pumpportal-messages.jsonl").trim().split("\n")[2]!);
    await clock.advance(59_000);
    expect(svc.status().gate.open).toBe(true);
    await clock.advance(2_000);
    expect(svc.status().gate.open).toBe(false);
    svc.stop();
  });
});
