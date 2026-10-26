/**
 * Minimal Solana JSON-RPC client.
 *
 * Read-only by construction: only the read methods below exist. Nothing here
 * can submit, simulate or sign a transaction (test/safety.test.ts enforces it).
 *
 * A daily call budget protects the Helius free plan (1M credits/month).
 */
import { z } from "zod";
import type { Clock } from "../core/clock.ts";
import type { HttpClient } from "../net/http.ts";

export interface BudgetStore {
  load(day: string): number;
  save(day: string, count: number): void;
}

export class CallBudget {
  private day: string;
  private used: number;

  constructor(
    private readonly limitPerDay: number,
    private readonly clock: Clock,
    private readonly store?: BudgetStore,
  ) {
    this.day = utcDay(clock.now());
    this.used = store?.load(this.day) ?? 0;
  }

  /** Reserve `n` calls. Returns false (and reserves nothing) if that would exceed today's budget. */
  tryConsume(n = 1): boolean {
    const d = utcDay(this.clock.now());
    if (d !== this.day) {
      this.day = d;
      this.used = this.store?.load(d) ?? 0;
    }
    if (this.used + n > this.limitPerDay) return false;
    this.used += n;
    this.store?.save(this.day, this.used);
    return true;
  }

  get remaining(): number {
    return Math.max(0, this.limitPerDay - this.used);
  }
  get usedToday(): number {
    return this.used;
  }
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class BudgetExhaustedError extends Error {}
export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
  }
}

const AccountSchema = z
  .object({
    data: z.tuple([z.string().max(2_000_000), z.literal("base64")]),
    owner: z.string().min(32).max(44),
    lamports: z.number().int().nonnegative(),
    executable: z.boolean(),
  })
  .passthrough();

const RpcEnvelope = <T extends z.ZodType>(result: T) =>
  z.union([
    z.object({ jsonrpc: z.literal("2.0"), id: z.union([z.number(), z.string()]), result }),
    z.object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.number(), z.string(), z.null()]),
      error: z.object({ code: z.number(), message: z.string().max(2000) }),
    }),
  ]);

const MultipleAccountsResult = z.object({
  context: z.object({ slot: z.number().int().nonnegative() }),
  value: z.array(AccountSchema.nullable()),
});

export interface RawAccount {
  owner: string;
  lamports: number;
  data: Uint8Array;
}

export class SolanaRpc {
  private id = 1;

  constructor(
    private readonly http: HttpClient,
    private readonly url: string,
    private readonly budget: CallBudget,
  ) {}

  private async call<T extends z.ZodType>(method: string, params: unknown[], result: T): Promise<z.infer<T>> {
    if (!this.budget.tryConsume(1)) throw new BudgetExhaustedError(`daily RPC budget exhausted (${method})`);
    const res = await this.http.request({
      provider: "solana_rpc",
      url: this.url,
      method: "POST",
      body: { jsonrpc: "2.0", id: this.id++, method, params },
      schema: RpcEnvelope(result),
      timeoutMs: 10_000,
      maxRetries: 1,
    });
    const r = res as { result?: unknown; error?: { code: number; message: string } };
    if (r.error) throw new RpcError(`${method}: ${r.error.message}`, r.error.code);
    return r.result as z.infer<T>;
  }

  getSlot(): Promise<number> {
    return this.call("getSlot", [{ commitment: "confirmed" }], z.number().int().nonnegative());
  }

  /** The 20 largest token accounts for a mint (standard RPC method). */
  async getTokenLargestAccounts(mint: string): Promise<{ slot: number; accounts: { address: string; amount: bigint }[] }> {
    const r = await this.call(
      "getTokenLargestAccounts",
      [mint, { commitment: "confirmed" }],
      z.object({
        context: z.object({ slot: z.number().int().nonnegative() }),
        value: z.array(z.object({ address: z.string().min(32).max(44), amount: z.string().regex(/^\d{1,20}$/) })).max(20),
      }),
    );
    return { slot: r.context.slot, accounts: r.value.map((a) => ({ address: a.address, amount: BigInt(a.amount) })) };
  }

  /**
   * Recent prioritization fees (micro-lamports per CU) seen by the node. A market estimate, not a quote.
   * With `writableAccounts`, only transactions that locked those accounts count (e.g. the pool we'd trade on).
   */
  async getRecentPrioritizationFees(writableAccounts: string[] = []): Promise<number[]> {
    const r = await this.call(
      "getRecentPrioritizationFees",
      writableAccounts.length ? [writableAccounts.slice(0, 128)] : [],
      z.array(z.object({ slot: z.number().int(), prioritizationFee: z.number().int().nonnegative() })).max(500),
    );
    return r.map((x) => x.prioritizationFee);
  }

  /** Up to 100 accounts in one call. Returns the slot the snapshot was read at. */
  async getMultipleAccounts(addresses: string[]): Promise<{ slot: number; accounts: (RawAccount | null)[] }> {
    if (addresses.length === 0) return { slot: 0, accounts: [] };
    if (addresses.length > 100) throw new Error("getMultipleAccounts takes at most 100 addresses");
    const r = await this.call("getMultipleAccounts", [addresses, { encoding: "base64", commitment: "confirmed" }], MultipleAccountsResult);
    if (r.value.length !== addresses.length) throw new RpcError("getMultipleAccounts: result length mismatch", -1);
    return {
      slot: r.context.slot,
      accounts: r.value.map((a) => (a ? { owner: a.owner, lamports: a.lamports, data: Uint8Array.from(Buffer.from(a.data[0], "base64")) } : null)),
    };
  }
}
