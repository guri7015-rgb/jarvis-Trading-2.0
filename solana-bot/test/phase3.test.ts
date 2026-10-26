import { describe, expect, it } from "vitest";
import { HealthMonitor } from "../src/health/monitor.ts";
import { cadToLamports, FxError, FxService, lamportsToCad } from "../src/market/fx.ts";
import { parseQuote, QuoteClient, QuoteError, type Quote } from "../src/market/quotes.ts";
import { HttpClient } from "../src/net/http.ts";
import { computeCosts, priorityEstimate } from "../src/risk/costs.ts";
import { impliedBuyFeeBps, impliedSellFeeBps } from "../src/risk/curveCheck.ts";
import { evaluateGate, recheckDelayMs, type GateInput } from "../src/risk/gate.ts";
import { DEFAULT_POLICY } from "../src/risk/policy.ts";
import { decodeBondingCurve } from "../src/solana/pumpCurve.ts";
import { MINTS } from "../src/solana/programs.ts";
import { fixture, fixtureJson, ImmediateClock, rpcFixtureAccounts, scriptedFetch } from "./helpers.ts";

const PS_MINT = "9yzoAfmCNTk7byXQyP64MraXuEvPhbNNa6BVn7zXpump";
const NOW = 1_800_000_000_000;
const buyReq = { inputMint: MINTS.WSOL, outputMint: PS_MINT, amount: 213_800_000n, slippageBps: 300 };
const sellReq = { inputMint: PS_MINT, outputMint: MINTS.WSOL, amount: 1_198_522_215_371n, slippageBps: 300 };
const raw = (name: string) => fixtureJson<any>(name);
const buy = () => parseQuote(raw("jupiter-quote-pumpswap-buy.json"), buyReq, NOW);
const sell = () => parseQuote(raw("jupiter-quote-pumpswap-sell.json"), sellReq, NOW + 1000);

function http(responses: Parameters<typeof scriptedFetch>[0]) {
  const clock = new ImmediateClock(NOW);
  const health = new HealthMonitor(clock);
  for (const p of ["jupiter_quote", "jupiter_price", "bankofcanada"] as const) health.register(p, { kind: "poll", maxSilenceMs: 1e9, required: false });
  const f = scriptedFetch(responses);
  return { client: new HttpClient({ fetch: f.fetch, clock, health, limiters: {} }), health, calls: f.calls, clock };
}

describe("Jupiter quotes (real captured responses)", () => {
  it("parses a PumpSwap buy and sell", () => {
    const b = buy();
    expect(b).toMatchObject({ inAmount: 213_800_000n, outAmount: 1_198_522_215_371n, hops: 1, routeLabels: ["Pump.fun Amm"] });
    expect(b.priceImpact).toBeCloseTo(0.0243, 4);
    expect(sell().outAmount).toBe(205_766_925n);
  });

  it("parses a two-hop route through USDC into a USDC-paired curve", () => {
    const req = { ...buyReq, outputMint: "GsFVvtVHxViwe27FSGrs1zKChxHYCDMwojxdDvs5pump" };
    const q = parseQuote(raw("jupiter-quote-two-hop.json"), req, NOW);
    expect(q.hops).toBe(2);
    expect(q.routeLabels).toEqual(["Obsidian", "Pump.fun"]);
  });

  it("refuses an answer to a different question", () => {
    expect(() => parseQuote(raw("jupiter-quote-pumpswap-buy.json"), { ...buyReq, amount: 1n }, NOW)).toThrow(/inAmount/);
    expect(() => parseQuote(raw("jupiter-quote-pumpswap-buy.json"), { ...buyReq, outputMint: MINTS.USDC }, NOW)).toThrow(/mints/);
    const r = raw("jupiter-quote-two-hop.json");
    r.routePlan[1].swapInfo.inputMint = MINTS.USDC.replace("E", "F"); // leg from nowhere
    expect(() => parseQuote(r, { ...buyReq, outputMint: r.outputMint }, NOW)).toThrow(/unrelated/);
    const r2 = raw("jupiter-quote-pumpswap-buy.json");
    r2.otherAmountThreshold = "99999999999999";
    expect(() => parseQuote(r2, buyReq, NOW)).toThrow(/minimum/);
  });

  it("maps Jupiter's 400 NO_ROUTES_FOUND to NO_ROUTE without marking Jupiter unhealthy", async () => {
    const h = http([{ status: 400, body: fixture("jupiter-quote-no-route.json") }]);
    const qc = new QuoteClient(h.client, () => NOW);
    await expect(qc.quote(buyReq)).rejects.toThrow(new QuoteError("NO_ROUTE"));
    expect(h.health.get("jupiter_quote").totalFailures).toBe(0);
    expect(h.calls[0]!.url).toMatch(/swap\/v1\/quote\?.*restrictIntermediateTokens=true/);
  });

  it("sends the API key only as a header", async () => {
    const h = http([{ status: 200, body: fixture("jupiter-quote-pumpswap-buy.json") }]);
    await new QuoteClient(h.client, () => NOW, "k-secret").quote(buyReq);
    expect(h.calls[0]!.url).not.toMatch(/k-secret/);
    expect(h.calls[0]!.init.headers["x-api-key"]).toBe("k-secret");
  });
});

describe("FX (Bank of Canada + Jupiter price)", () => {
  it("derives SOL/CAD from both sources and keeps their timestamps", async () => {
    const h = http([
      { status: 200, body: fixture("boc-usdcad.json") },
      { status: 200, body: fixture("jupiter-price-sol.json") },
    ]);
    const fx = new FxService(h.client, () => Date.parse("2026-10-26T08:00:00Z"));
    const q = await fx.solCad();
    expect(q.usdCad).toBe(1.3993);
    expect(q.usdCadDate).toBe("2026-10-23");
    expect(q.solCad).toBeCloseTo(100.268 * 1.3993, 2);
    expect(q.evidence).toBe("DERIVED");
  });

  it("refuses a stale Bank of Canada rate instead of using it", async () => {
    const h = http([{ status: 200, body: fixture("boc-usdcad.json") }]);
    const fx = new FxService(h.client, () => Date.parse("2026-11-10T00:00:00Z"));
    await expect(fx.usdCad()).rejects.toBeInstanceOf(FxError);
  });

  it("converts CAD to lamports and back", () => {
    expect(cadToLamports(30, 140)).toBe(214_285_714n);
    expect(lamportsToCad(214_285_714n, 140)).toBeCloseTo(30, 4);
    expect(() => cadToLamports(30, 0)).toThrow();
  });
});

describe("costs", () => {
  it("measures the real PumpSwap round trip: ~3.76% plus network fees", () => {
    const c = computeCosts({ sizeLamports: 213_800_000n, buy: buy(), sell: sell(), priorityMicroLamportsPerCu: 10_000, computeUnits: 200_000, mintProgram: "token2022" });
    expect(c.quoteRoundTripLossLamports).toBe(213_800_000n - 205_766_925n);
    expect(c.networkFeesLamports).toBe(2n * (5_000n + 2_000n));
    expect(c.totalCostBps).toBe(376); // (8_033_075 + 14_000) / 213_800_000
    expect(c.breakEvenMovePct).toBeCloseTo(3.91, 1);
    expect(c.rentLamports).toBe(2_074_080n);
  });

  it("refuses a sell quote that isn't for the bought amount", () => {
    const s = { ...sell(), inAmount: 1n };
    expect(() => computeCosts({ sizeLamports: 1n, buy: buy(), sell: s, priorityMicroLamportsPerCu: 0, computeUnits: 1, mintProgram: "token" })).toThrow();
  });

  it("estimates priority fees from the median of non-zero samples, capped", () => {
    expect(priorityEstimate([0, 0, 100, 300, 200], 1_000)).toBe(200);
    expect(priorityEstimate([0, 0], 1_000)).toBe(0);
    expect(priorityEstimate([5_000_000], 1_000)).toBe(1_000);
  });
});

describe("curve fee cross-check", () => {
  const curve = decodeBondingCurve(rpcFixtureAccounts().accounts[1]!.data);
  const mkQuote = (over: Partial<Quote>): Quote => ({
    inputMint: MINTS.WSOL, outputMint: "M", inAmount: 0n, outAmount: 0n, minOut: 0n, priceImpact: 0, routeLabels: ["Pump.fun"], ammKeys: ["a"], hops: 1, receivedAt: NOW, ...over,
  });

  it("backs out a 1.25% fee from a buy priced on the curve plus fee", () => {
    const tokens = 5_000_000_000_000n;
    const cost = (curve.virtualQuoteReserves * tokens) / (curve.virtualTokenReserves - tokens) + 1n;
    const paid = (cost * 10_125n) / 10_000n;
    expect(impliedBuyFeeBps(curve, mkQuote({ inAmount: paid, outAmount: tokens }))).toBe(125);
  });

  it("backs out the sell fee", () => {
    const tokens = 5_000_000_000_000n;
    const gross = (curve.virtualQuoteReserves * tokens) / (curve.virtualTokenReserves + tokens);
    const out = (gross * 9_875n) / 10_000n;
    expect(impliedSellFeeBps(curve, mkQuote({ inputMint: "M", outputMint: MINTS.WSOL, inAmount: tokens, outAmount: out }))).toBe(125);
  });

  it("does not guess for routes that don't go straight through the curve", () => {
    expect(impliedBuyFeeBps(curve, mkQuote({ routeLabels: ["Obsidian", "Pump.fun"], hops: 2, inAmount: 1n, outAmount: 1n }))).toBeUndefined();
  });
});

describe("tradability gate", () => {
  const pump = rpcFixtureAccounts();
  const goodMint = { program: "token2022" as const, mintAuthority: null, freezeAuthority: null, supply: 1_000_000_000_000_000n, decimals: 6, isInitialized: true, extensions: ["MetadataPointer", "TokenMetadata"] };
  const holders = { slot: 1, holders: [], top10WalletPct: 20, largestWalletPct: 5, creatorPct: 2, poolPct: 70, evidence: "ONCHAIN_CONFIRMED" as const, note: "" };
  const base = (): GateInput => {
    const b = buy();
    const s = sell();
    return {
      now: NOW + 1500,
      confirmStatus: "CONFIRMED",
      mint: goodMint,
      holders,
      buy: b,
      sell: s,
      costs: computeCosts({ sizeLamports: 213_800_000n, buy: b, sell: s, priorityMicroLamportsPerCu: 0, computeUnits: 200_000, mintProgram: "token2022" }),
    };
  };
  const rules = (i: GateInput) => evaluateGate(i, DEFAULT_POLICY).rejects.map((r) => r.rule);

  it("passes the real PumpSwap example and flags its single-pool exit", () => {
    const r = evaluateGate(base(), DEFAULT_POLICY);
    expect(r.verdict).toBe("PASS");
    expect(r.flags.map((f) => f.rule)).toContain("SINGLE_POOL_EXIT");
  });

  it("rejects authorities and dangerous extensions", () => {
    expect(rules({ ...base(), mint: { ...goodMint, mintAuthority: "X", freezeAuthority: "Y" } })).toEqual(["MINT_AUTHORITY", "FREEZE_AUTHORITY"]);
    expect(rules({ ...base(), mint: { ...goodMint, extensions: ["TokenMetadata", "PermanentDelegate", "unknown(99)"] } })).toEqual(["TOKEN_EXTENSION"]);
  });

  it("fails closed on every missing input", () => {
    const r = rules({ ...base(), confirmStatus: "PENDING", mint: new Error("rpc down"), holders: new Error("budget"), buy: new Error("NO_ROUTE"), sell: undefined, costs: undefined, fxError: "stale" });
    expect(r).toEqual(expect.arrayContaining(["FX_UNAVAILABLE", "NOT_CONFIRMED", "MINT_READ", "NO_BUY_ROUTE", "HOLDER_READ"]));
  });

  it("rejects when a buy works but no sell route exists", () => {
    expect(rules({ ...base(), sell: new QuoteError("NO_ROUTE"), costs: undefined })).toEqual(["NO_SELL_ROUTE"]);
  });

  it("rejects stale quotes, quotes far apart, unknown venues, long routes and heavy impact", () => {
    expect(rules({ ...base(), now: NOW + 10_000 })).toContain("BUY_QUOTE_STALE");
    expect(rules({ ...base(), sell: { ...sell(), receivedAt: NOW + 9_000 }, now: NOW + 9_100 })).toContain("QUOTE_GAP");
    expect(rules({ ...base(), buy: { ...buy(), routeLabels: ["Deriverse", "Pump.fun"], hops: 3 } })).toEqual(expect.arrayContaining(["BUY_ROUTE_VENUE", "BUY_ROUTE_HOPS"]));
    expect(rules({ ...base(), sell: { ...sell(), priceImpact: 1 } })).toContain("SELL_IMPACT");
  });

  it("rejects a round trip that costs too much", () => {
    const i = base();
    expect(rules({ ...i, costs: { ...i.costs!, totalCostBps: 900 } })).toEqual(["ROUND_TRIP_COST"]);
  });

  it("rejects concentrated holders and a big creator stake", () => {
    expect(rules({ ...base(), holders: { ...holders, top10WalletPct: 60, largestWalletPct: 30, creatorPct: 25 } })).toEqual(["TOP10_CONCENTRATION", "LARGEST_WALLET", "CREATOR_HOLDING"]);
  });

  it("rejects buying on a finished curve and flags a fee that disagrees with the docs", () => {
    const curve = { ...decodeBondingCurve(pump.accounts[1]!.data), complete: true };
    const r = evaluateGate({ ...base(), buy: { ...buy(), routeLabels: ["Pump.fun"] }, curve, impliedBuyFeeBps: 300 }, DEFAULT_POLICY);
    expect(r.rejects.map((x) => x.rule)).toContain("CURVE_COMPLETE");
    expect(r.flags.map((x) => x.rule)).toContain("BUY_FEE_DIFFERS");
  });

  it("waits longer before rechecking a structural reject than a market one", () => {
    const structural = evaluateGate({ ...base(), mint: { ...goodMint, mintAuthority: "X" } }, DEFAULT_POLICY);
    const market = evaluateGate({ ...base(), sell: { ...sell(), priceImpact: 1 } }, DEFAULT_POLICY);
    expect(recheckDelayMs(structural, DEFAULT_POLICY)).toBe(DEFAULT_POLICY.recheckAfterStructuralRejectMs);
    expect(recheckDelayMs(market, DEFAULT_POLICY)).toBe(DEFAULT_POLICY.recheckAfterMarketRejectMs);
  });
});
