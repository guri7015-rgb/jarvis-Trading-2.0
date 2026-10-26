import { describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.ts";
import { silentLogger } from "../src/core/log.ts";
import type { TokenCreatedEvent } from "../src/core/types.ts";
import { Assessor } from "../src/assess/assessor.ts";
import { TokenRegistry } from "../src/discovery/registry.ts";
import type { FxService } from "../src/market/fx.ts";
import { parseQuote, QuoteError, type QuoteClient, type QuoteRequest } from "../src/market/quotes.ts";
import { analyzeHolders, INCINERATOR } from "../src/risk/holders.ts";
import { DEFAULT_POLICY } from "../src/risk/policy.ts";
import { addressToBytes, derivePumpBondingCurve } from "../src/solana/address.ts";
import { MINTS, PROGRAMS } from "../src/solana/programs.ts";
import { CallBudget, type RawAccount, type SolanaRpc } from "../src/solana/rpc.ts";
import { openDb } from "../src/storage/db.ts";
import { fixtureJson, PUMP_CURVE, PUMP_MINT, rpcFixtureAccounts } from "./helpers.ts";

const fx = rpcFixtureAccounts();
const SUPPLY = 1_000_000_000_000_000n;
const W1 = "7GhWwhaMgbKiRWxF93Bud6HnHMci6NCLTJyTxG8zFH51";
const W2 = "6kus2N4vwjCd55V3UaSPJQGqg2zWy5QgeA7v16Mpmt3p";
const CREATOR = "G288fELCkpe6PgjfXvNwDoniafuAb7jBzFKBkr83c3pV";
const TA = ["11111111111111111111111111111112", "11111111111111111111111111111113", "11111111111111111111111111111114", "11111111111111111111111111111115"];

function tokenAccount(mint: string, owner: string, amount: bigint): RawAccount {
  const d = new Uint8Array(165);
  d.set(addressToBytes(mint), 0);
  d.set(addressToBytes(owner), 32);
  new DataView(d.buffer).setBigUint64(64, amount, true);
  d[108] = 1;
  return { owner: PROGRAMS.TOKEN_2022, lamports: 1, data: d };
}

/** Holder layout: curve vault 70%, W1 9%, creator 3%, incinerator 5%. */
function holderRpc(extra: Record<string, RawAccount | null> = {}) {
  const largest = [
    { address: TA[0]!, amount: (SUPPLY * 70n) / 100n },
    { address: TA[1]!, amount: (SUPPLY * 9n) / 100n },
    { address: TA[2]!, amount: (SUPPLY * 5n) / 100n },
    { address: TA[3]!, amount: (SUPPLY * 3n) / 100n },
  ];
  const accounts: Record<string, RawAccount | null> = {
    [TA[0]!]: tokenAccount(PUMP_MINT, PUMP_CURVE, largest[0]!.amount),
    [TA[1]!]: tokenAccount(PUMP_MINT, W1, largest[1]!.amount),
    [TA[2]!]: tokenAccount(PUMP_MINT, INCINERATOR, largest[2]!.amount),
    [TA[3]!]: tokenAccount(PUMP_MINT, CREATOR, largest[3]!.amount),
    [PUMP_CURVE]: fx.accounts[1]!, // owned by the pump program → pool
    [W1]: { owner: "11111111111111111111111111111111", lamports: 1, data: new Uint8Array() },
    [CREATOR]: { owner: "11111111111111111111111111111111", lamports: 1, data: new Uint8Array() },
    [PUMP_MINT]: fx.accounts[0]!,
    ...extra,
  };
  let calls = 0;
  const rpc = {
    async getTokenLargestAccounts() {
      calls++;
      return { slot: 7, accounts: largest };
    },
    async getMultipleAccounts(addrs: string[]) {
      calls++;
      return { slot: 8, accounts: addrs.map((a) => accounts[a] ?? null) };
    },
    async getRecentPrioritizationFees() {
      calls++;
      return [0, 1000, 3000];
    },
  } as unknown as SolanaRpc;
  return { rpc, calls: () => calls };
}

describe("holder analysis", () => {
  it("separates curve vaults and burned tokens from wallet holders", async () => {
    const { rpc } = holderRpc();
    const r = await analyzeHolders(rpc, PUMP_MINT, SUPPLY, CREATOR);
    expect(r.holders.map((h) => h.class)).toEqual(["pool", "wallet", "burn", "wallet"]);
    expect(r.poolPct).toBe(70);
    expect(r.top10WalletPct).toBe(12);
    expect(r.largestWalletPct).toBe(9);
    expect(r.creatorPct).toBe(3);
    expect(r.evidence).toBe("ONCHAIN_CONFIRMED");
  });

  it("doesn't trust a token account that belongs to another mint", async () => {
    const { rpc } = holderRpc({ [TA[1]!]: tokenAccount(MINTS.USDC, W2, (SUPPLY * 9n) / 100n) });
    const r = await analyzeHolders(rpc, PUMP_MINT, SUPPLY, CREATOR);
    expect(r.holders[1]!.class).toBe("unknown");
    expect(r.holders[1]!.owner).toBe("?");
  });
});

describe("Assessor end to end (fake network)", () => {
  const T0 = Date.parse("2026-10-26T08:00:00Z");
  const create: TokenCreatedEvent = {
    kind: "token_created",
    provider: "pumpportal",
    providerEventId: "create:s",
    dedupeKey: `create:${PUMP_MINT}`,
    receivedAt: T0,
    evidence: "PROVIDER_REPORTED",
    mint: PUMP_MINT,
    venue: "pump_curve",
    venueRaw: "pump",
  };
  const fakeFx = { solCad: async () => ({ solCad: 140, solUsd: 100, usdCad: 1.4, solUsdAt: T0, usdCadDate: "2026-10-23", evidence: "DERIVED" as const }) } as unknown as FxService;
  // Reuse the real PumpSwap quote payloads, re-addressed to the test mint.
  function fakeQuotes(sellFails = false) {
    const asked: QuoteRequest[] = [];
    const qc = {
      async quote(req: QuoteRequest) {
        asked.push(req);
        const isBuy = req.inputMint === MINTS.WSOL;
        if (!isBuy && sellFails) throw new QuoteError("NO_ROUTE");
        const r = fixtureJson<any>(isBuy ? "jupiter-quote-pumpswap-buy.json" : "jupiter-quote-pumpswap-sell.json");
        const swap = (m: string) => (m === MINTS.WSOL ? m : PUMP_MINT);
        r.inputMint = swap(r.inputMint);
        r.outputMint = swap(r.outputMint);
        r.inAmount = req.amount.toString();
        for (const leg of r.routePlan) {
          leg.swapInfo.inputMint = swap(leg.swapInfo.inputMint);
          leg.swapInfo.outputMint = swap(leg.swapInfo.outputMint);
        }
        return parseQuote(r, req, T0);
      },
    } as unknown as QuoteClient;
    return { qc, asked };
  }

  async function setup(sellFails = false) {
    const clock = new FakeClock(T0);
    const db = openDb(":memory:");
    const registry = new TokenRegistry(db);
    registry.ingest(create);
    db.prepare("UPDATE tokens SET confirm_status='CONFIRMED' WHERE mint=?").run(PUMP_MINT);
    const derived = await derivePumpBondingCurve(PUMP_MINT);
    const { rpc, calls } = holderRpc({ [derived]: fx.accounts[1]! });
    const q = fakeQuotes(sellFails);
    const a = new Assessor({ db, registry, rpc, budget: new CallBudget(10_000, clock), quotes: q.qc, fx: fakeFx, clock, logger: silentLogger, policy: DEFAULT_POLICY });
    return { a, db, asked: q.asked, calls, clock };
  }

  it("assesses a candidate, sells exactly what the buy returns, and stores the evidence", async () => {
    const { a, db, asked, calls } = await setup();
    a.addCandidates([{ mint: PUMP_MINT, source: "test", liquidityUsd: 50_000 }]);
    const rec = await a.tick();
    expect(rec?.gate.verdict).toBe("PASS");
    expect(asked[0]!.amount).toBe(214_285_714n); // CAD 30 at 140 CAD/SOL
    expect(asked[1]!.amount).toBe(rec!.buy!.outAmount);
    expect(calls()).toBe(5); // accounts, largest, token accounts, owners, priority
    const row = db.prepare("SELECT * FROM assessments").get() as Record<string, unknown>;
    expect(row).toMatchObject({ verdict: "PASS", buy_route: "Pump.fun Amm", top10_wallet_pct: 12, creator_pct: 3, size_cad: 30, sol_cad: 140 });
  });

  it("rejects a token you could buy but not sell, and waits before looking again", async () => {
    const { a, db, clock } = await setup(true);
    a.addCandidates([{ mint: PUMP_MINT, source: "test", liquidityUsd: 50_000 }]);
    const rec = await a.tick();
    expect(rec?.gate.rejects.map((r) => r.rule)).toEqual(["NO_SELL_ROUTE"]);
    a.addCandidates([{ mint: PUMP_MINT, source: "test", liquidityUsd: 50_000 }]);
    expect(await a.tick()).toBeUndefined(); // cooling down
    await clock.advance(DEFAULT_POLICY.recheckAfterMarketRejectMs + 1);
    expect((await a.tick())?.mint).toBe(PUMP_MINT);
    expect((db.prepare("SELECT COUNT(*) n FROM assessments").get() as { n: number }).n).toBe(2);
  });

  it("skips low-liquidity candidates, unconfirmed tokens, and runs only with RPC budget to spare", async () => {
    const { a, db } = await setup();
    a.addCandidates([{ mint: PUMP_MINT, source: "test", liquidityUsd: 100 }]);
    expect(a.candidateCount).toBe(0);
    db.prepare("UPDATE tokens SET confirm_status='PENDING'").run();
    a.addCandidates([{ mint: PUMP_MINT, source: "test", liquidityUsd: 50_000 }]);
    expect(await a.tick()).toBeUndefined();
    db.prepare("UPDATE tokens SET confirm_status='CONFLICT'").run();
    expect(await a.tick()).toBeUndefined();
    expect(a.candidateCount).toBe(0); // conflicts are dropped for good
  });

  it("drops tokens without a launch venue (e.g. majors in a trending list)", async () => {
    const { a, db } = await setup();
    db.prepare("UPDATE tokens SET launch_venue = NULL").run();
    a.addCandidates([{ mint: PUMP_MINT, source: "test", liquidityUsd: 50_000 }]);
    expect(await a.tick()).toBeUndefined();
    expect(a.candidateCount).toBe(0);
  });

  it("pauses holder checks after the RPC rate-limits them, and retries data-only rejects sooner", async () => {
    const { a, clock } = await setup();
    let largestCalls = 0;
    const rpc = (a as unknown as { d: { rpc: SolanaRpc } }).d.rpc as unknown as Record<string, unknown>;
    rpc.getTokenLargestAccounts = async () => {
      largestCalls++;
      throw new Error("rate limited (429)");
    };
    a.addCandidates([{ mint: PUMP_MINT, source: "test", liquidityUsd: 50_000 }]);
    const first = await a.tick();
    expect(first?.gate.rejects.map((r) => r.rule)).toEqual(["HOLDER_READ"]);
    await clock.advance(DEFAULT_POLICY.recheckAfterDataRejectMs + 1);
    a.addCandidates([{ mint: PUMP_MINT, source: "test", liquidityUsd: 50_000 }]);
    const second = await a.tick();
    expect(second?.gate.rejects.find((r) => r.rule === "HOLDER_READ")?.observed).toMatch(/paused/);
    expect(largestCalls).toBe(1);
  });

  it("does nothing when the RPC budget is nearly used up", async () => {
    const clock = new FakeClock(T0);
    const db = openDb(":memory:");
    const budget = new CallBudget(100, clock); // below minRpcBudgetToAssess
    const { qc } = fakeQuotes();
    const a = new Assessor({ db, registry: new TokenRegistry(db), rpc: {} as SolanaRpc, budget, quotes: qc, fx: fakeFx, clock, logger: silentLogger, policy: DEFAULT_POLICY });
    expect(await a.tick()).toBeUndefined();
    expect(a.stats.skippedBudget).toBe(1);
  });
});
