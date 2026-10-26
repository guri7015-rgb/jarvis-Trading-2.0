/**
 * GeckoTerminal public API (keyless, ~30 calls/min documented; tighter in practice).
 * Used for: new-pool cross-check across venues. All values are PROVIDER_REPORTED.
 */
import { z } from "zod";
import type { PoolObservedEvent } from "../core/types.ts";
import type { HttpClient } from "../net/http.ts";
import { isValidAddress } from "../solana/address.ts";
import { mapVenue } from "./venues.ts";

export const GECKO_NEW_POOLS_URL = "https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1";

const numStr = z
  .string()
  .max(120)
  .nullable()
  .optional()
  .transform((s) => {
    if (s === null || s === undefined) return undefined;
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  });

const solanaId = z
  .string()
  .max(80)
  .transform((s) => (s.startsWith("solana_") ? s.slice(7) : ""));

const Pool = z.object({
  id: z.string().max(100),
  type: z.literal("pool"),
  attributes: z.object({
    address: z.string().max(60),
    pool_created_at: z.string().max(40).nullable().optional(),
    base_token_price_usd: numStr,
    reserve_in_usd: numStr,
  }),
  relationships: z.object({
    base_token: z.object({ data: z.object({ id: solanaId }) }),
    quote_token: z.object({ data: z.object({ id: solanaId }) }),
    dex: z.object({ data: z.object({ id: z.string().max(60) }) }),
  }),
});

export const GeckoNewPoolsSchema = z.object({ data: z.array(z.unknown()).max(200) });

export interface GeckoParseResult {
  events: PoolObservedEvent[];
  rejected: number;
}

/** Items are validated one by one so one bad pool doesn't discard the page. */
export function parseGeckoNewPools(body: z.infer<typeof GeckoNewPoolsSchema>, receivedAt: number): GeckoParseResult {
  const events: PoolObservedEvent[] = [];
  let rejected = 0;
  for (const item of body.data) {
    const p = Pool.safeParse(item);
    if (!p.success) {
      rejected++;
      continue;
    }
    const a = p.data.attributes;
    const mint = p.data.relationships.base_token.data.id;
    const quoteMint = p.data.relationships.quote_token.data.id;
    if (!isValidAddress(mint) || !isValidAddress(a.address)) {
      rejected++;
      continue;
    }
    const created = a.pool_created_at ? Date.parse(a.pool_created_at) : NaN;
    const venueRaw = p.data.relationships.dex.data.id;
    events.push({
      kind: "pool_observed",
      provider: "geckoterminal",
      providerEventId: `pool:${a.address}`,
      dedupeKey: `pool:${a.address}`,
      receivedAt,
      evidence: "PROVIDER_REPORTED",
      mint,
      venue: mapVenue("geckoterminal", venueRaw),
      venueRaw,
      pool: a.address,
      quoteMint: isValidAddress(quoteMint) ? quoteMint : undefined,
      poolCreatedAt: Number.isFinite(created) ? created : undefined,
      liquidityUsd: a.reserve_in_usd,
      priceUsd: a.base_token_price_usd,
    });
  }
  return { events, rejected };
}

export async function fetchGeckoNewPools(http: HttpClient, now: () => number): Promise<GeckoParseResult> {
  const body = await http.request({ provider: "geckoterminal", url: GECKO_NEW_POOLS_URL, schema: GeckoNewPoolsSchema, maxRetries: 0 });
  return parseGeckoNewPools(body, now());
}
