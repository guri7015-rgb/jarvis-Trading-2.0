/**
 * Holder concentration from the chain.
 *
 * 3 RPC calls: largest token accounts → those accounts (to get owners) →
 * the owners (to tell wallets from programs). Pool and curve vaults are
 * excluded from "holder" concentration; everything else is counted.
 *
 * Only direct evidence is reported. Two wallets are never assumed to share
 * an owner here; clustering is a separate, labelled inference (not built yet).
 */
import { DecodeError } from "../solana/mint.ts";
import type { SolanaRpc } from "../solana/rpc.ts";
import { decodeTokenAccount } from "../solana/tokenAccount.ts";

/** Programs whose accounts hold pooled liquidity, not a holder's position. */
export const POOL_PROGRAMS = new Set([
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // pump.fun curve
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // PumpSwap
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", // Raydium AMM v4
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", // Raydium CPMM
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", // Raydium CLMM
  "LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj", // Raydium LaunchLab
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", // Meteora DLMM
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB", // Meteora DAMM v1
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG", // Meteora DAMM v2
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN", // Meteora DBC
]);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
/** Solana's well-known incinerator address. Tokens sent here are effectively burned. */
export const INCINERATOR = "1nc1nerator11111111111111111111111111111111";

export type HolderClass = "wallet" | "pool" | "burn" | "other_program" | "unknown";

export interface Holder {
  tokenAccount: string;
  owner: string;
  amount: bigint;
  pctOfSupply: number;
  class: HolderClass;
}

export interface HolderReport {
  slot: number;
  holders: Holder[];
  /** Sum of the 10 largest wallet-class holders, % of supply. */
  top10WalletPct: number;
  largestWalletPct: number;
  /** Creator's direct holding in the top 20, % of supply (0 if not in the top 20). */
  creatorPct: number;
  /** Share of supply in pool/curve vaults among the top 20. */
  poolPct: number;
  evidence: "ONCHAIN_CONFIRMED";
  /** getTokenLargestAccounts returns at most 20 accounts. */
  note: string;
}

export async function analyzeHolders(rpc: SolanaRpc, mint: string, supply: bigint, creator: string | null): Promise<HolderReport> {
  if (supply <= 0n) throw new DecodeError("supply is zero");
  const largest = await rpc.getTokenLargestAccounts(mint);
  const tokenAccs = await rpc.getMultipleAccounts(largest.accounts.map((a) => a.address));
  const owners: (string | undefined)[] = tokenAccs.accounts.map((acc, i) => {
    if (!acc) return undefined;
    try {
      const t = decodeTokenAccount(acc.data, acc.owner);
      // The token account must be for this mint and agree with the reported balance.
      if (t.mint !== mint || t.amount !== largest.accounts[i]!.amount) return undefined;
      return t.owner;
    } catch {
      return undefined;
    }
  });
  const uniqueOwners = [...new Set(owners.filter((o): o is string => !!o))];
  const ownerAccs = uniqueOwners.length ? await rpc.getMultipleAccounts(uniqueOwners) : { slot: 0, accounts: [] };
  const ownerProgram = new Map<string, string | null>();
  uniqueOwners.forEach((o, i) => ownerProgram.set(o, ownerAccs.accounts[i]?.owner ?? null));

  const pct = (a: bigint) => Number((a * 1_000_000n) / supply) / 10_000;
  const holders: Holder[] = largest.accounts.map((a, i) => {
    const owner = owners[i];
    let cls: HolderClass = "unknown";
    if (owner === INCINERATOR) cls = "burn";
    else if (owner) {
      const prog = ownerProgram.get(owner);
      // Pool vaults are owned by an account of the pool program (pump curve, PumpSwap pool).
      // Some AMMs use an authority PDA with no account; those land in "unknown" and are
      // counted as holders, which overstates concentration rather than hiding it.
      if (prog && POOL_PROGRAMS.has(prog)) cls = "pool";
      else if (prog === SYSTEM_PROGRAM) cls = "wallet";
      else if (prog === null) cls = "unknown";
      else cls = "other_program";
    }
    return { tokenAccount: a.address, owner: owner ?? "?", amount: a.amount, pctOfSupply: pct(a.amount), class: cls };
  });

  // An owner with no account (never funded) is still a wallet key in practice,
  // but we can't prove it isn't a PDA, so it counts as a holder to stay conservative.
  const holderLike = holders.filter((h) => h.class === "wallet" || h.class === "unknown" || h.class === "other_program");
  const top10 = holderLike.slice(0, 10).reduce((s, h) => s + h.pctOfSupply, 0);
  return {
    slot: largest.slot,
    holders,
    top10WalletPct: round(top10),
    largestWalletPct: holderLike[0]?.pctOfSupply ?? 0,
    creatorPct: round(holders.filter((h) => creator && h.owner === creator).reduce((s, h) => s + h.pctOfSupply, 0)),
    poolPct: round(holders.filter((h) => h.class === "pool").reduce((s, h) => s + h.pctOfSupply, 0)),
    evidence: "ONCHAIN_CONFIRMED",
    note: "top 20 token accounts only; wallets are not clustered",
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
