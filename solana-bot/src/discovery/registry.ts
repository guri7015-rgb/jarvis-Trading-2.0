/**
 * Token registry: the single place where discovery events become token state.
 *
 * - Tokens are keyed by mint address only. Names and symbols are never identity.
 * - A provider repeating an event is a duplicate (unique on provider + event id).
 * - The same fact from several providers is merged, and each provider's first
 *   sighting is kept for the coverage report.
 * - Out-of-order events can't move a token backwards: first-observed only goes
 *   earlier, stage only moves forward, creation time only gets stronger evidence.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  EVIDENCE_RANK,
  STAGE_ORDER,
  type DiscoveryEvent,
  type Evidence,
  type ProviderId,
  type TokenCategory,
  type TokenStage,
  type Venue,
} from "../core/types.ts";
import { tx } from "../storage/db.ts";
import { utcDay } from "../solana/rpc.ts";

export interface IngestResult {
  duplicate: boolean;
  newToken: boolean;
  /** Another provider had already reported this same fact. */
  crossProviderRepeat: boolean;
}

export interface TokenRow {
  mint: string;
  first_observed_at: number;
  first_source: ProviderId;
  created_at: number | null;
  created_at_evidence: Evidence | null;
  created_at_source: string | null;
  launch_venue: Venue | null;
  stage: TokenStage;
  stage_evidence: Evidence | null;
  confirm_status: ConfirmStatus;
  confirm_note: string | null;
  confirm_attempts: number;
  confirmed_at: number | null;
  confirmed_slot: number | null;
  mint_program: string | null;
  mint_authority: string | null;
  freeze_authority: string | null;
  decimals: number | null;
  supply: string | null;
  extensions: string | null;
  creator: string | null;
  creator_evidence: Evidence | null;
  provider_curve: string | null;
  curve_key_matches: number | null;
  curve_complete: number | null;
  curve_virtual_quote: string | null;
  curve_virtual_token: string | null;
  curve_real_quote: string | null;
  curve_quote_mint: string | null;
  curve_quote_mint_assumed: number | null;
  updated_at: number;
}

/**
 * CONFLICT: the chain contradicts what a provider told us (for example the
 * provider's bonding-curve address doesn't belong to this mint). The token's
 * provider-derived facts are not trusted until a later phase re-checks them.
 */
export type ConfirmStatus = "PENDING" | "CONFIRMED" | "NOT_FOUND" | "NOT_A_MINT" | "ERROR" | "CONFLICT";

export interface CategoryResult {
  category: TokenCategory;
  ageMs?: number;
  basis: string;
}

/** Stage implied by an event, if any. */
function stageFor(ev: DiscoveryEvent): TokenStage | undefined {
  if (ev.kind === "migrated") return "MIGRATED";
  if (ev.kind === "token_created" && ev.venue === "pump_curve") return "BONDING";
  if (ev.kind === "pool_observed" && ev.venue === "pumpswap") return "MIGRATED";
  return undefined;
}

/** Best creation-time claim an event carries. */
function createdClaim(ev: DiscoveryEvent): { at: number; evidence: Evidence; source: string } | undefined {
  if (ev.kind === "token_created") {
    if (ev.createdAt !== undefined) return { at: ev.createdAt, evidence: ev.evidence, source: `${ev.provider}:created_at` };
    // We saw the create as it happened. Receipt time is an upper bound on creation time.
    return { at: ev.receivedAt, evidence: "DERIVED", source: `${ev.provider}:create_received` };
  }
  // A token's first pool is created at or after the mint. For a launchpad pool
  // (curve) that is the launch itself; for an AMM pool it is only an upper bound.
  if (ev.kind === "pool_observed" && ev.poolCreatedAt !== undefined) {
    const launchVenue = ev.venue === "pump_curve" || ev.venue === "raydium_launchlab" || ev.venue === "meteora_dbc";
    return { at: ev.poolCreatedAt, evidence: launchVenue ? ev.evidence : "DERIVED", source: `${ev.provider}:${launchVenue ? "launch_pool_created" : "pool_created_upper_bound"}` };
  }
  return undefined;
}

export class TokenRegistry {
  constructor(private readonly db: DatabaseSync) {}

  ingest(ev: DiscoveryEvent): IngestResult {
    return tx(this.db, () => {
      const ins = this.db
        .prepare(
          `INSERT OR IGNORE INTO events (provider, provider_event_id, dedupe_key, kind, mint, venue, venue_raw, evidence, received_at, payload)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(ev.provider, ev.providerEventId, ev.dedupeKey, ev.kind, ev.mint, ev.venue, ev.venueRaw, ev.evidence, ev.receivedAt, JSON.stringify(ev));
      if (ins.changes === 0) {
        this.bumpStat(ev.provider, ev.receivedAt, "duplicates");
        return { duplicate: true, newToken: false, crossProviderRepeat: false };
      }

      const priorSameFact = this.db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE dedupe_key = ? AND provider != ?")
        .get(ev.dedupeKey, ev.provider) as { n: number };

      this.db
        .prepare(
          `INSERT INTO token_sources (mint, provider, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (mint, provider) DO UPDATE SET
             first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
             last_seen_at = MAX(last_seen_at, excluded.last_seen_at),
             events = events + 1`,
        )
        .run(ev.mint, ev.provider, ev.receivedAt, ev.receivedAt);

      const existing = this.get(ev.mint);
      const newToken = !existing;
      if (!existing) {
        this.db
          .prepare(`INSERT INTO tokens (mint, first_observed_at, first_source, updated_at) VALUES (?, ?, ?, ?)`)
          .run(ev.mint, ev.receivedAt, ev.provider, ev.receivedAt);
      } else if (ev.receivedAt < existing.first_observed_at) {
        // Out-of-order arrival (replay, backfill): keep the earliest sighting.
        this.db.prepare("UPDATE tokens SET first_observed_at = ?, first_source = ? WHERE mint = ?").run(ev.receivedAt, ev.provider, ev.mint);
      }
      const cur = this.get(ev.mint)!;

      // Creation time: stronger evidence wins; on equal evidence, the earlier time wins.
      const claim = createdClaim(ev);
      if (claim) {
        const curRank = cur.created_at_evidence ? EVIDENCE_RANK[cur.created_at_evidence] : -1;
        const newRank = EVIDENCE_RANK[claim.evidence];
        if (newRank > curRank || (newRank === curRank && (cur.created_at === null || claim.at < cur.created_at))) {
          this.db
            .prepare("UPDATE tokens SET created_at = ?, created_at_evidence = ?, created_at_source = ? WHERE mint = ?")
            .run(claim.at, claim.evidence, claim.source, ev.mint);
        }
      }

      // Stage only moves forward.
      const stage = stageFor(ev);
      if (stage && STAGE_ORDER[stage] > STAGE_ORDER[cur.stage]) {
        this.db.prepare("UPDATE tokens SET stage = ?, stage_evidence = ? WHERE mint = ?").run(stage, ev.evidence, ev.mint);
      }

      if (ev.kind === "token_created") {
        if (!cur.launch_venue) this.db.prepare("UPDATE tokens SET launch_venue = ? WHERE mint = ?").run(ev.venue, ev.mint);
        if (ev.creator && !cur.creator) this.db.prepare("UPDATE tokens SET creator = ?, creator_evidence = ? WHERE mint = ?").run(ev.creator, ev.evidence, ev.mint);
        if (ev.bondingCurve && !cur.provider_curve) this.db.prepare("UPDATE tokens SET provider_curve = ? WHERE mint = ?").run(ev.bondingCurve, ev.mint);
      }
      if (ev.kind === "pool_observed") {
        const launchVenue = ev.venue === "pump_curve" || ev.venue === "raydium_launchlab" || ev.venue === "meteora_dbc";
        if (launchVenue && !cur.launch_venue) this.db.prepare("UPDATE tokens SET launch_venue = ? WHERE mint = ?").run(ev.venue, ev.mint);
        this.db
          .prepare(
            `INSERT INTO pools (pool, mint, venue, venue_raw, first_source, first_seen_at, pool_created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (pool) DO UPDATE SET first_seen_at = MIN(first_seen_at, excluded.first_seen_at),
               pool_created_at = COALESCE(pool_created_at, excluded.pool_created_at)`,
          )
          .run(ev.pool, ev.mint, ev.venue, ev.venueRaw, ev.provider, ev.receivedAt, ev.poolCreatedAt ?? null);
      }

      this.db.prepare("UPDATE tokens SET updated_at = ? WHERE mint = ?").run(Math.max(ev.receivedAt, cur.updated_at), ev.mint);
      return { duplicate: false, newToken, crossProviderRepeat: priorSameFact.n > 0 };
    });
  }

  get(mint: string): TokenRow | undefined {
    return this.db.prepare("SELECT * FROM tokens WHERE mint = ?").get(mint) as TokenRow | undefined;
  }

  sources(mint: string): { provider: ProviderId; first_seen_at: number; events: number }[] {
    return this.db.prepare("SELECT provider, first_seen_at, events FROM token_sources WHERE mint = ? ORDER BY first_seen_at").all(mint) as never;
  }

  recordRejected(provider: ProviderId, at: number, n = 1): void {
    if (n > 0) this.bumpStat(provider, at, "rejected", n);
  }

  private bumpStat(provider: ProviderId, at: number, col: "duplicates" | "rejected", n = 1): void {
    this.db
      .prepare(`INSERT INTO provider_stats (provider, day, ${col}) VALUES (?, ?, ?) ON CONFLICT (provider, day) DO UPDATE SET ${col} = ${col} + ?`)
      .run(provider, utcDay(at), n, n);
  }

  /** Tokens waiting for on-chain confirmation, oldest first. */
  pendingConfirmation(limit: number, maxAttempts: number): TokenRow[] {
    return this.db
      .prepare(
        `SELECT * FROM tokens WHERE (confirm_status = 'PENDING' OR (confirm_status IN ('NOT_FOUND','ERROR') AND confirm_attempts < ?))
         ORDER BY first_observed_at LIMIT ?`,
      )
      .all(maxAttempts, limit) as unknown as TokenRow[];
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM tokens").get() as { n: number }).n;
  }
}

/**
 * Age category. Uses only a creation time we actually have, and says which
 * evidence it rests on. No creation time → UNKNOWN_AGE, never NEW_LAUNCH.
 */
export function categorize(
  t: Pick<TokenRow, "created_at" | "created_at_evidence" | "created_at_source"> & Partial<Pick<TokenRow, "confirm_status">>,
  now: number,
  cfg: { newLaunchMaxAgeMs: number; earlyMaxAgeMs: number },
): CategoryResult {
  if (t.confirm_status === "CONFLICT" || t.confirm_status === "NOT_A_MINT") return { category: "UNKNOWN_AGE", basis: `on-chain check failed (${t.confirm_status})` };
  if (t.created_at === null || !t.created_at_evidence) return { category: "UNKNOWN_AGE", basis: "no creation time" };
  const ageMs = Math.max(0, now - t.created_at);
  const basis = `${t.created_at_evidence} (${t.created_at_source ?? "?"})`;
  // An upper-bound creation time from an AMM pool can't prove a token is new.
  const upperBoundOnly = t.created_at_source?.includes("upper_bound") ?? false;
  if (ageMs <= cfg.newLaunchMaxAgeMs && !upperBoundOnly) return { category: "NEW_LAUNCH", ageMs, basis };
  if (ageMs <= cfg.earlyMaxAgeMs && !upperBoundOnly) return { category: "EARLY", ageMs, basis };
  if (upperBoundOnly && ageMs <= cfg.earlyMaxAgeMs) return { category: "UNKNOWN_AGE", ageMs, basis: `${basis}; pool time is only an upper bound` };
  return { category: "ESTABLISHED", ageMs, basis };
}
