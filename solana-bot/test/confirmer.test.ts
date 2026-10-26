import { describe, expect, it } from "vitest";
import { silentLogger } from "../src/core/log.ts";
import type { TokenCreatedEvent } from "../src/core/types.ts";
import { MAX_CONFIRM_ATTEMPTS, OnChainConfirmer } from "../src/discovery/confirmer.ts";
import { categorize, TokenRegistry } from "../src/discovery/registry.ts";
import { BudgetExhaustedError, type RawAccount, type SolanaRpc } from "../src/solana/rpc.ts";
import { openDb } from "../src/storage/db.ts";
import { fixtureJson, PUMP_CURVE, PUMP_MINT, rpcFixtureAccounts, USDC } from "./helpers.ts";

const T0 = 1_800_000_000_000;
const catCfg = { newLaunchMaxAgeMs: 10 * 60_000, earlyMaxAgeMs: 2 * 3_600_000 };
const fx = rpcFixtureAccounts();

const createEv = (mint: string, curve?: string): TokenCreatedEvent => ({
  kind: "token_created",
  provider: "pumpportal",
  providerEventId: `create:${mint}`,
  dedupeKey: `create:${mint}`,
  receivedAt: T0,
  evidence: "PROVIDER_REPORTED",
  mint,
  venue: "pump_curve",
  venueRaw: "pump",
  bondingCurve: curve,
});

/** Fake RPC that serves accounts by address. */
function fakeRpc(byAddr: Record<string, RawAccount | null>, opts: { exhausted?: boolean } = {}) {
  const calls: string[][] = [];
  const rpc = {
    async getMultipleAccounts(addrs: string[]) {
      if (opts.exhausted) throw new BudgetExhaustedError("budget");
      calls.push(addrs);
      return { slot: 123, accounts: addrs.map((a) => byAddr[a] ?? null) };
    },
  } as unknown as SolanaRpc;
  return { rpc, calls };
}

function setup(rpc: SolanaRpc) {
  const db = openDb(":memory:");
  const registry = new TokenRegistry(db);
  const c = new OnChainConfirmer(db, registry, rpc, silentLogger, () => T0 + 1000);
  return { db, registry, c };
}

describe("OnChainConfirmer", () => {
  it("confirms mint and curve on-chain, at the read slot, and checks the provider's curve key", async () => {
    const { rpc, calls } = fakeRpc({ [PUMP_MINT]: fx.accounts[0]!, [PUMP_CURVE]: fx.accounts[1]! });
    const { registry, c } = setup(rpc);
    registry.ingest(createEv(PUMP_MINT, PUMP_CURVE));
    await c.runBatch();
    expect(calls[0]).toEqual([PUMP_MINT, PUMP_CURVE]); // curve address derived locally
    const t = registry.get(PUMP_MINT)!;
    expect(t).toMatchObject({
      confirm_status: "CONFIRMED",
      confirmed_slot: 123,
      mint_program: "token2022",
      mint_authority: null,
      freeze_authority: null,
      curve_key_matches: 1,
      curve_complete: 0,
      stage: "BONDING",
      stage_evidence: "ONCHAIN_CONFIRMED",
      creator_evidence: "ONCHAIN_CONFIRMED",
    });
  });

  it("flags a provider curve address that doesn't match our derivation", async () => {
    const { rpc } = fakeRpc({ [PUMP_MINT]: fx.accounts[0]!, [PUMP_CURVE]: fx.accounts[1]! });
    const { registry, c } = setup(rpc);
    registry.ingest(createEv(PUMP_MINT, USDC));
    await c.runBatch();
    expect(registry.get(PUMP_MINT)).toMatchObject({ curve_key_matches: 0, confirm_status: "CONFLICT" });
    expect(c.stats.curveMismatch).toBe(1);
  });

  it("regression: a token-paired launch reported with the quote mint as `mint` is not called a new launch", async () => {
    // Real accounts captured 2026-10-26. PumpPortal sent mint=PUMP (pumpCmX…) and the
    // curve of the actual new coin (CueqC1…). The PDA derived from PUMP is an empty system account.
    const d = fixtureJson<{ result: { value: { owner: string; data: [string, string] }[] } }>("rpc-quote-paired-create.json").result.value;
    const acc = (i: number): RawAccount => ({ owner: d[i]!.owner, lamports: 1, data: Uint8Array.from(Buffer.from(d[i]!.data[0], "base64")) });
    const PUMP_TOKEN = "pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn";
    const { rpc } = fakeRpc({ [PUMP_TOKEN]: acc(0), H15XgDRavM1bBjjjcXwW3jm21h3P7WXjf9bargCasY6q: acc(1), "26LB6Hc3dKX86XDye2tTmZbUCpZq6Zt8qFQkeZ1CaQFG": acc(2) });
    const { registry, c } = setup(rpc);
    registry.ingest(createEv(PUMP_TOKEN, "26LB6Hc3dKX86XDye2tTmZbUCpZq6Zt8qFQkeZ1CaQFG"));
    expect(categorize(registry.get(PUMP_TOKEN)!, T0, catCfg).category).toBe("NEW_LAUNCH"); // before the chain check
    await c.runBatch();
    const t = registry.get(PUMP_TOKEN)!;
    expect(t.confirm_status).toBe("CONFLICT");
    expect(t.confirm_note).toMatch(/does not derive/);
    expect(t.created_at).toBeNull();
    expect(categorize(t, T0, catCfg).category).toBe("UNKNOWN_AGE");
  });

  it("flags a pump.fun token with no curve at the derived address even without a provider curve", async () => {
    const { rpc } = fakeRpc({ [PUMP_MINT]: fx.accounts[0]! });
    const { registry, c } = setup(rpc);
    registry.ingest(createEv(PUMP_MINT));
    await c.runBatch();
    expect(registry.get(PUMP_MINT)).toMatchObject({ confirm_status: "CONFLICT", confirm_note: expect.stringMatching(/no pump.fun bonding curve/) });
  });

  it("records an address that is not a token mint and never confirms it", async () => {
    const { rpc } = fakeRpc({ [PUMP_MINT]: { ...fx.accounts[1]! } }); // curve account bytes at the mint address
    const { registry, c } = setup(rpc);
    registry.ingest(createEv(PUMP_MINT));
    await c.runBatch();
    expect(registry.get(PUMP_MINT)!.confirm_status).toBe("NOT_A_MINT");
  });

  it("retries a mint that isn't visible yet, then gives up", async () => {
    const { rpc, calls } = fakeRpc({});
    const { registry, c } = setup(rpc);
    registry.ingest(createEv(PUMP_MINT));
    for (let i = 0; i < MAX_CONFIRM_ATTEMPTS + 2; i++) await c.runBatch();
    expect(calls).toHaveLength(MAX_CONFIRM_ATTEMPTS);
    expect(registry.get(PUMP_MINT)).toMatchObject({ confirm_status: "NOT_FOUND", confirm_attempts: MAX_CONFIRM_ATTEMPTS });
  });

  it("pauses without changing state when the RPC budget is used up", async () => {
    const { rpc } = fakeRpc({}, { exhausted: true });
    const { registry, c } = setup(rpc);
    registry.ingest(createEv(PUMP_MINT));
    expect(await c.runBatch()).toBe(0);
    expect(registry.get(PUMP_MINT)).toMatchObject({ confirm_status: "PENDING", confirm_attempts: 0 });
    expect(c.stats.budgetBlocked).toBe(1);
  });
});
