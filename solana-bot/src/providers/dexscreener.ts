/**
 * DexScreener `tokens/v1/solana/{mints}` (up to 30 mints, 300 req/min).
 * Used only as a coverage cross-check: which pairs does DexScreener know for a
 * token we discovered elsewhere? It has no new-pairs feed. PROVIDER_REPORTED.
 */
import { z } from "zod";
import type { Venue } from "../core/types.ts";
import type { HttpClient } from "../net/http.ts";
import { isValidAddress } from "../solana/address.ts";
import { mapVenue } from "./venues.ts";

const Pair = z.object({
  chainId: z.string().max(30),
  dexId: z.string().max(60),
  pairAddress: z.string().max(60),
  baseToken: z.object({ address: z.string().max(60) }),
  pairCreatedAt: z.number().finite().nullable().optional(),
  liquidity: z.object({ usd: z.number().finite().nullable().optional() }).nullable().optional(),
});

export const DexScreenerTokensSchema = z.array(z.unknown()).max(500);

export interface DexPair {
  mint: string;
  pair: string;
  venue: Venue;
  venueRaw: string;
  pairCreatedAt?: number;
  /** null means DexScreener reported no liquidity figure (seen on bonding curves). */
  liquidityUsd: number | null;
}

export function parseDexScreenerTokens(body: unknown[]): { pairs: DexPair[]; rejected: number } {
  const pairs: DexPair[] = [];
  let rejected = 0;
  for (const item of body) {
    const p = Pair.safeParse(item);
    if (!p.success || p.data.chainId !== "solana" || !isValidAddress(p.data.baseToken.address)) {
      rejected++;
      continue;
    }
    pairs.push({
      mint: p.data.baseToken.address,
      pair: p.data.pairAddress,
      venue: mapVenue("dexscreener", p.data.dexId),
      venueRaw: p.data.dexId,
      pairCreatedAt: p.data.pairCreatedAt ?? undefined,
      liquidityUsd: p.data.liquidity?.usd ?? null,
    });
  }
  return { pairs, rejected };
}

export async function fetchDexScreenerTokens(http: HttpClient, mints: string[]): Promise<{ pairs: DexPair[]; rejected: number }> {
  const valid = mints.filter(isValidAddress).slice(0, 30);
  if (valid.length === 0) return { pairs: [], rejected: 0 };
  const body = await http.request({
    provider: "dexscreener",
    url: `https://api.dexscreener.com/tokens/v1/solana/${valid.join(",")}`,
    schema: DexScreenerTokensSchema,
    cacheTtlMs: 15_000,
  });
  return parseDexScreenerTokens(body);
}
