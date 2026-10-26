/**
 * Jupiter Tokens API v2, `/recent` (newest tokens by first-pool time).
 * Keyless 0.5 req/s; free key 1 req/s (limits are per organisation and shared
 * with quotes later). All values are PROVIDER_REPORTED.
 *
 * Note: "recent" means first pool created, not mint created.
 */
import { z } from "zod";
import type { PoolObservedEvent } from "../core/types.ts";
import type { HttpClient } from "../net/http.ts";
import { isValidAddress } from "../solana/address.ts";
import { mapVenue } from "./venues.ts";

export const JUPITER_RECENT_URL = "https://api.jup.ag/tokens/v2/recent";

export const JupiterRecentSchema = z.array(z.unknown()).max(500);

const Token = z.object({
  id: z.string().max(60),
  launchpad: z.string().max(60).nullable().optional(),
  tokenProgram: z.string().max(60).optional(),
  liquidity: z.number().finite().nullable().optional(),
  usdPrice: z.number().finite().nullable().optional(),
  firstPool: z
    .object({
      id: z.string().max(60),
      createdAt: z.string().max(40),
    })
    .optional(),
  audit: z
    .object({
      mintAuthorityDisabled: z.boolean().optional(),
      freezeAuthorityDisabled: z.boolean().optional(),
    })
    .partial()
    .optional(),
});

export interface JupiterParseResult {
  events: PoolObservedEvent[];
  rejected: number;
}

export function parseJupiterRecent(body: unknown[], receivedAt: number): JupiterParseResult {
  const events: PoolObservedEvent[] = [];
  let rejected = 0;
  for (const item of body) {
    const p = Token.safeParse(item);
    if (!p.success || !isValidAddress(p.data.id)) {
      rejected++;
      continue;
    }
    const t = p.data;
    const pool = t.firstPool && isValidAddress(t.firstPool.id) ? t.firstPool.id : undefined;
    if (!pool) {
      rejected++;
      continue;
    }
    const created = t.firstPool ? Date.parse(t.firstPool.createdAt) : NaN;
    const venueRaw = t.launchpad ?? "unknown";
    events.push({
      kind: "pool_observed",
      provider: "jupiter_tokens",
      providerEventId: `firstpool:${t.id}`,
      dedupeKey: `pool:${pool}`,
      receivedAt,
      evidence: "PROVIDER_REPORTED",
      mint: t.id,
      venue: mapVenue("jupiter_tokens", venueRaw),
      venueRaw,
      pool,
      poolCreatedAt: Number.isFinite(created) ? created : undefined,
      liquidityUsd: t.liquidity ?? undefined,
      priceUsd: t.usdPrice ?? undefined,
    });
  }
  return { events, rejected };
}

export async function fetchJupiterRecent(http: HttpClient, apiKey: string | undefined, now: () => number): Promise<JupiterParseResult> {
  const body = await http.request({
    provider: "jupiter_tokens",
    url: JUPITER_RECENT_URL,
    schema: JupiterRecentSchema,
    headers: apiKey ? { "x-api-key": apiKey } : {},
    maxRetries: 0,
  });
  return parseJupiterRecent(body, now());
}
