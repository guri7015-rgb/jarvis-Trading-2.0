import { describe, expect, it } from "vitest";
import { parseDexScreenerTokens } from "../src/providers/dexscreener.ts";
import { GeckoNewPoolsSchema, parseGeckoNewPools } from "../src/providers/geckoterminal.ts";
import { parseJupiterRecent, parseJupiterTokenMeta } from "../src/providers/jupiterTokens.ts";
import { buildSubscribeMessages, parsePumpPortalMessage } from "../src/providers/pumpportal.ts";
import { mapVenue } from "../src/providers/venues.ts";
import { fixture, fixtureJson, PUMP_CURVE, PUMP_MINT } from "./helpers.ts";

const NOW = 1_800_000_000_000;

describe("PumpPortal", () => {
  const lines = fixture("pumpportal-messages.jsonl").trim().split("\n");

  it("parses real captured create, migrate and ack messages", () => {
    const parsed = lines.map((l) => parsePumpPortalMessage(l, NOW));
    expect(parsed.map((p) => p.type)).toEqual(["ack", "ack", "event", "event", "event", "event"]);
    const create = parsed[2]!;
    if (create.type !== "event" || create.event.kind !== "token_created") throw new Error("expected create");
    expect(create.event).toMatchObject({
      mint: PUMP_MINT,
      venue: "pump_curve",
      evidence: "PROVIDER_REPORTED",
      bondingCurve: PUMP_CURVE,
      dedupeKey: `create:${PUMP_MINT}`,
    });
    // PumpPortal sends no creation timestamp; we must not invent one.
    expect(create.event.createdAt).toBeUndefined();
    const mig = parsed[4]!;
    expect(mig.type === "event" && mig.event.kind).toBe("migrated");
    expect(mig.type === "event" && mig.event.venue).toBe("pumpswap");
  });

  it("rejects malformed and hostile payloads", () => {
    const base = JSON.parse(lines[2]!);
    const cases = [
      "not json",
      "[]",
      "null",
      JSON.stringify({ ...base, mint: "not-an-address" }),
      JSON.stringify({ ...base, mint: 12345 }),
      JSON.stringify({ ...base, signature: "short" }),
      JSON.stringify({ ...base, name: "x".repeat(10_000) }),
      JSON.stringify({ ...base, solAmount: -1 }),
      JSON.stringify({ ...base, traderPublicKey: "0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl" }),
    ];
    for (const c of cases) expect(parsePumpPortalMessage(c, NOW).type).toBe("rejected");
  });

  it("ignores prototype-pollution keys", () => {
    const base = JSON.parse(lines[2]!);
    const evil = `{"__proto__":{"polluted":true},${JSON.stringify(base).slice(1)}`;
    const p = parsePumpPortalMessage(evil, NOW);
    expect(p.type).toBe("event");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("ignores unknown message types instead of guessing", () => {
    expect(parsePumpPortalMessage('{"txType":"buy","mint":"x"}', NOW).type).toBe("ignored");
  });

  it("only allows the approved read-only subscriptions", () => {
    expect(buildSubscribeMessages(["subscribeNewToken", "subscribeMigration"])).toHaveLength(2);
    for (const m of ["subscribeTokenTrade", "subscribeAccountTrade", "trade"]) {
      expect(() => buildSubscribeMessages([m])).toThrow(/not approved/);
    }
  });
});

describe("GeckoTerminal", () => {
  it("parses the captured new_pools page and maps venues", () => {
    const body = GeckoNewPoolsSchema.parse(fixtureJson("geckoterminal-new-pools.json"));
    const r = parseGeckoNewPools(body, NOW);
    expect(r.rejected).toBe(0);
    expect(r.events).toHaveLength(20);
    const venues = new Set(r.events.map((e) => e.venue));
    expect(venues).toEqual(new Set(["pump_curve", "pumpswap", "meteora_dbc", "meteora_damm"]));
    for (const e of r.events) {
      expect(e.evidence).toBe("PROVIDER_REPORTED");
      expect(e.poolCreatedAt).toBeTypeOf("number");
    }
  });

  it("keeps good pools when one item is malformed", () => {
    const body = fixtureJson<{ data: unknown[] }>("geckoterminal-new-pools.json");
    body.data.push({ id: "x", type: "pool", attributes: { address: 5 } });
    body.data.push({ ...(body.data[0] as object), relationships: { base_token: { data: { id: "ethereum_0xabc" } }, quote_token: { data: { id: "solana_x" } }, dex: { data: { id: "pump-fun" } } } });
    const r = parseGeckoNewPools(GeckoNewPoolsSchema.parse(body), NOW);
    expect(r.events).toHaveLength(20);
    expect(r.rejected).toBe(2);
  });
});

describe("Jupiter Tokens /recent", () => {
  it("parses the captured page; venue is the launchpad, created time is first-pool time", () => {
    const r = parseJupiterRecent(fixtureJson("jupiter-tokens-recent.json"), NOW);
    expect(r.events.length + r.rejected).toBe(30);
    const pump = r.events.find((e) => e.venueRaw === "pump.fun")!;
    expect(pump.venue).toBe("pump_curve");
    expect(pump.poolCreatedAt).toBe(Date.parse("2026-10-26T07:00:30Z"));
    expect(r.events.some((e) => e.venueRaw === "met-dbc" && e.venue === "meteora_dbc")).toBe(true);
    expect(pump.name).toBeTruthy();
    expect(pump.symbol).toBeTruthy();
    expect(pump.iconUrl).toMatch(/^https:\/\//);
  });

  it("search results give display metadata; non-https logos are dropped", () => {
    const meta = parseJupiterTokenMeta([
      { id: PUMP_MINT, name: " Coin ", symbol: "C", icon: "https://cdn.example/c.png" },
      { id: PUMP_MINT, name: "X", icon: "ftp://cdn.example/c.png" },
      { id: "not-an-address", name: "Y" },
    ]);
    expect(meta).toEqual([{ mint: PUMP_MINT, name: "Coin", symbol: "C", iconUrl: "https://cdn.example/c.png" }, { mint: PUMP_MINT, name: "X" }]);
  });
});

describe("DexScreener", () => {
  it("parses pairs and keeps a missing liquidity figure as null, not zero", () => {
    const r = parseDexScreenerTokens([
      { chainId: "solana", dexId: "pumpfun", pairAddress: "p1", baseToken: { address: PUMP_MINT }, pairCreatedAt: 1 },
      { chainId: "solana", dexId: "pumpswap", pairAddress: "p2", baseToken: { address: PUMP_MINT }, liquidity: { usd: 100 } },
      { chainId: "ethereum", dexId: "uniswap", pairAddress: "p3", baseToken: { address: PUMP_MINT } },
    ]);
    expect(r.rejected).toBe(1);
    expect(r.pairs[0]).toMatchObject({ venue: "pump_curve", liquidityUsd: null });
    expect(r.pairs[1]).toMatchObject({ venue: "pumpswap", liquidityUsd: 100 });
  });
});

describe("venue mapping", () => {
  it("never guesses an unknown label", () => {
    expect(mapVenue("geckoterminal", "stonkfun")).toBe("other");
    expect(mapVenue("dexscreener", "meteora")).toBe("other");
    expect(mapVenue("pumpportal", undefined)).toBe("other");
  });
});
