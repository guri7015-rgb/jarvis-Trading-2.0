/**
 * Shared types for discovery and normalization.
 *
 * Every fact carries an `Evidence` label so downstream code never confuses
 * something we read from the chain with something a provider told us.
 */

/** Where a fact came from. */
export type Evidence =
  /** Read by us from a Solana account or transaction at a known slot. */
  | "ONCHAIN_CONFIRMED"
  /** Reported by a third-party provider. Not checked against the chain. */
  | "PROVIDER_REPORTED"
  /** Computed by us from other facts (inherits the weakest input's evidence). */
  | "DERIVED";

export type ProviderId =
  | "pumpportal"
  | "geckoterminal"
  | "jupiter_tokens"
  | "jupiter_quote"
  | "jupiter_price"
  | "dexscreener"
  | "solana_rpc"
  | "solana_ws"
  | "solana_firehose"
  | "coinbase"
  | "bankofcanada";

/**
 * Launch venues we intend to research. Anything a provider reports that we
 * don't recognise is kept as `other` with the raw label preserved.
 */
export type Venue =
  | "pump_curve"
  | "pumpswap"
  | "raydium_launchlab"
  | "raydium_amm"
  | "raydium_cpmm"
  | "raydium_clmm"
  | "meteora_dbc"
  | "meteora_damm"
  | "meteora_dlmm"
  | "other";

export interface Observed<T> {
  value: T;
  evidence: Evidence;
  source: ProviderId;
  /** Local wall-clock ms when we learned this. */
  observedAt: number;
  /** Slot the fact was read at, when known. */
  slot?: number;
}

interface EventHeader {
  provider: ProviderId;
  /** Provider-scoped id; used to detect a provider repeating itself. */
  providerEventId: string;
  /** Provider-independent key; used to merge the same fact seen by several providers. */
  dedupeKey: string;
  /** Local wall-clock ms when the event arrived. */
  receivedAt: number;
  evidence: Evidence;
  mint: string;
  venue: Venue;
  /** Raw venue label from the provider, kept for audit. */
  venueRaw: string;
}

export interface TokenCreatedEvent extends EventHeader {
  kind: "token_created";
  signature?: string;
  creator?: string;
  name?: string;
  symbol?: string;
  /** Provider-reported bonding-curve account. Re-derived and compared before use. */
  bondingCurve?: string;
  /** Creation time as reported (ms). Absent if the provider didn't say. */
  createdAt?: number;
}

export interface PoolObservedEvent extends EventHeader {
  kind: "pool_observed";
  pool: string;
  /** Display metadata as the provider reports it. Shown on the dashboard, never used as identity. */
  name?: string;
  symbol?: string;
  iconUrl?: string;
  quoteMint?: string;
  /** Pool creation time as reported (ms). */
  poolCreatedAt?: number;
  liquidityUsd?: number;
  priceUsd?: number;
}

export interface MigratedEvent extends EventHeader {
  kind: "migrated";
  signature?: string;
  pool?: string;
}

export type DiscoveryEvent = TokenCreatedEvent | PoolObservedEvent | MigratedEvent;

/**
 * Token age categories. `UNKNOWN_AGE` exists so we never call a token "new"
 * without evidence of when it was created.
 *
 * The spec's "trending" and "already extended" categories need price and trade
 * history. Discovery doesn't collect that yet, so they are not assigned here.
 */
export type TokenCategory = "NEW_LAUNCH" | "EARLY" | "ESTABLISHED" | "UNKNOWN_AGE";

/**
 * BONDING: on the pump.fun curve. COMPLETE: curve finished, migration pending.
 * MIGRATED: trading on an AMM pool. Stages only move forward.
 */
export type TokenStage = "UNKNOWN" | "BONDING" | "COMPLETE" | "MIGRATED";

export const STAGE_ORDER: Record<TokenStage, number> = { UNKNOWN: 0, BONDING: 1, COMPLETE: 2, MIGRATED: 3 };

/** Strength order for evidence, strongest last. */
export const EVIDENCE_RANK: Record<Evidence, number> = { DERIVED: 0, PROVIDER_REPORTED: 1, ONCHAIN_CONFIRMED: 2 };
