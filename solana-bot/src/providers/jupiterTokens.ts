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
  name: z.string().max(200).nullable().optional(),
  symbol: z.string().max(64).nullable().optional(),
  icon: z.string().max(500).nullable().optional(),
  launchpad: z.string().max(60).nullable().optional(),
  tokenProgram: z.string().max(60).optional(),
  liquidity: z.number().finite().nullable().optional(),
  usdPrice: z.number().finite().nullable().optional(),
  /** Set once a launchpad token has graduated to an AMM pool (seen live for pump.fun → PumpSwap). */
  graduatedPool: z.string().max(60).nullable().optional(),
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
      topHoldersPercentage: z.number().finite().min(0).max(100).optional(),
      devBalancePercentage: z.number().finite().min(0).max(100).optional(),
    })
    .partial()
    .optional(),
});

export interface JupiterParseResult {
  events: PoolObservedEvent[];
  rejected: number;
}

export interface TokenMeta {
  mint: string;
  name?: string;
  symbol?: string;
  iconUrl?: string;
}

/** Only https URLs are kept; the browser loads them with no referrer. Anything else is dropped. */
export function safeIconUrl(u: string | null | undefined): string | undefined {
  if (!u || u.length > 500) return undefined;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function tokenMeta(t: { id: string; name?: string | null; symbol?: string | null; icon?: string | null }): Omit<TokenMeta, "mint"> {
  const out: Omit<TokenMeta, "mint"> = {};
  if (t.name?.trim()) out.name = t.name.trim();
  if (t.symbol?.trim()) out.symbol = t.symbol.trim();
  const icon = safeIconUrl(t.icon);
  if (icon) out.iconUrl = icon;
  return out;
}

/** Tokens v2 `/search` answers with the same token shape as `/recent`, for up to 100 mints per call. */
export function parseJupiterTokenMeta(body: unknown[]): TokenMeta[] {
  const out: TokenMeta[] = [];
  for (const item of body) {
    const p = Token.safeParse(item);
    if (!p.success || !isValidAddress(p.data.id)) continue;
    out.push({ mint: p.data.id, ...tokenMeta(p.data) });
  }
  return out;
}

export async function fetchJupiterTokenMeta(http: HttpClient, apiKey: string | undefined, mints: string[]): Promise<TokenMeta[]> {
  if (!mints.length) return [];
  const body = await http.request({
    provider: "jupiter_tokens",
    url: `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mints.slice(0, 100).join(","))}`,
    schema: JupiterRecentSchema,
    headers: apiKey ? { "x-api-key": apiKey } : {},
    maxRetries: 0,
  });
  return parseJupiterTokenMeta(body);
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
      ...tokenMeta(t),
      poolCreatedAt: Number.isFinite(created) ? created : undefined,
      liquidityUsd: t.liquidity ?? undefined,
      priceUsd: t.usdPrice ?? undefined,
    });
    // A pump.fun token's graduated pool is PumpSwap. Other launchpads graduate elsewhere; not mapped.
    if (t.graduatedPool && isValidAddress(t.graduatedPool) && venueRaw === "pump.fun") {
      events.push({
        kind: "pool_observed",
        provider: "jupiter_tokens",
        providerEventId: `gradpool:${t.id}`,
        dedupeKey: `pool:${t.graduatedPool}`,
        receivedAt,
        evidence: "PROVIDER_REPORTED",
        mint: t.id,
        venue: "pumpswap",
        venueRaw: "pump.fun:graduatedPool",
        pool: t.graduatedPool,
        ...tokenMeta(t),
        liquidityUsd: t.liquidity ?? undefined,
        priceUsd: t.usdPrice ?? undefined,
      });
    }
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

export type JupiterCategory = "toptrending" | "toptraded" | "toporganicscore";

/**
 * Jupiter's activity lists (e.g. top trending over 5 minutes). Same token shape
 * as /recent. Used to pick which tokens are worth a full assessment; the list
 * itself is a provider opinion, not evidence of anything.
 */
export async function fetchJupiterCategory(
  http: HttpClient,
  apiKey: string | undefined,
  category: JupiterCategory,
  interval: "5m" | "1h",
  now: () => number,
): Promise<JupiterParseResult> {
  const body = await http.request({
    provider: "jupiter_tokens",
    url: `https://api.jup.ag/tokens/v2/${category}/${interval}?limit=50`,
    schema: JupiterRecentSchema,
    headers: apiKey ? { "x-api-key": apiKey } : {},
    maxRetries: 0,
  });
  return parseJupiterRecent(body, now());
}

/** Jupiter's holder summary for one coin, or undefined if it reports none. */
export async function fetchJupiterAudit(http: HttpClient, apiKey: string | undefined, mint: string): Promise<{ topHoldersPercentage?: number; devBalancePercentage?: number } | undefined> {
  const body = await http.request({
    provider: "jupiter_tokens",
    url: `https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`,
    schema: JupiterRecentSchema,
    headers: apiKey ? { "x-api-key": apiKey } : {},
    maxRetries: 0,
  });
  for (const item of body) {
    const p = Token.safeParse(item);
    if (p.success && p.data.id === mint) return p.data.audit ?? undefined;
  }
  return undefined;
}
