/**
 * On-chain confirmation of discovered tokens.
 *
 * For each pending mint we read, in one batched getMultipleAccounts call:
 *   - the mint account (program, authorities, decimals, supply, extensions)
 *   - for pump.fun tokens, the bonding-curve account at the address WE derive
 *     (a provider-supplied curve address is only compared, never trusted)
 *
 * Results are written with ONCHAIN_CONFIRMED evidence and the read slot.
 * Fifty tokens per call keeps the Helius free plan well inside budget.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "../core/log.ts";
import { derivePumpBondingCurve } from "../solana/address.ts";
import { DecodeError, decodeMint } from "../solana/mint.ts";
import { PROGRAMS } from "../solana/programs.ts";
import { decodeBondingCurve } from "../solana/pumpCurve.ts";
import { BudgetExhaustedError, type SolanaRpc } from "../solana/rpc.ts";
import type { TokenRegistry, TokenRow } from "./registry.ts";

export const MAX_CONFIRM_ATTEMPTS = 4;

export interface ConfirmStats {
  batches: number;
  confirmed: number;
  notFound: number;
  notAMint: number;
  curveMismatch: number;
  conflicts: number;
  errors: number;
  budgetBlocked: number;
}

export class OnChainConfirmer {
  public stats: ConfirmStats = { batches: 0, confirmed: 0, notFound: 0, notAMint: 0, curveMismatch: 0, conflicts: 0, errors: 0, budgetBlocked: 0 };

  constructor(
    private readonly db: DatabaseSync,
    private readonly registry: TokenRegistry,
    private readonly rpc: SolanaRpc,
    private readonly logger: Logger,
    private readonly now: () => number,
    private readonly batchSize = 50,
  ) {}

  /** Confirm one batch. Returns the number of tokens processed. */
  async runBatch(): Promise<number> {
    const pending = this.registry.pendingConfirmation(this.batchSize, MAX_CONFIRM_ATTEMPTS);
    if (pending.length === 0) return 0;

    const plan: { token: TokenRow; mintIdx: number; curveIdx?: number; derivedCurve?: string }[] = [];
    const addresses: string[] = [];
    for (const t of pending) {
      const entry: (typeof plan)[number] = { token: t, mintIdx: addresses.push(t.mint) - 1 };
      if (t.launch_venue === "pump_curve") {
        entry.derivedCurve = await derivePumpBondingCurve(t.mint);
        entry.curveIdx = addresses.push(entry.derivedCurve) - 1;
      }
      plan.push(entry);
    }

    let res;
    try {
      res = await this.rpc.getMultipleAccounts(addresses);
    } catch (e) {
      if (e instanceof BudgetExhaustedError) {
        this.stats.budgetBlocked++;
        this.logger.warn("on-chain confirmation paused: daily RPC budget used up");
        return 0;
      }
      this.stats.errors++;
      // Count an attempt so a poison batch can't block the queue forever.
      for (const p of plan) this.mark(p.token.mint, "ERROR");
      throw e;
    }
    this.stats.batches++;
    const at = this.now();

    for (const p of plan) {
      const acc = res.accounts[p.mintIdx];
      if (!acc) {
        this.stats.notFound++;
        this.mark(p.token.mint, "NOT_FOUND");
        continue;
      }
      if (acc.owner !== PROGRAMS.TOKEN && acc.owner !== PROGRAMS.TOKEN_2022) {
        // A provider gave us an address that isn't a token mint. Record it; never use it.
        this.stats.notAMint++;
        this.mark(p.token.mint, "NOT_A_MINT");
        continue;
      }
      let mint;
      try {
        mint = decodeMint(acc.data, acc.owner);
      } catch (e) {
        this.stats.errors++;
        this.logger.warn("mint decode failed", { mint: p.token.mint, err: (e as Error).message });
        this.mark(p.token.mint, e instanceof DecodeError ? "NOT_A_MINT" : "ERROR");
        continue;
      }

      let curve: ReturnType<typeof decodeBondingCurve> | undefined;
      if (p.curveIdx !== undefined) {
        const cAcc = res.accounts[p.curveIdx];
        if (cAcc && cAcc.owner === PROGRAMS.PUMP_CURVE) {
          try {
            curve = decodeBondingCurve(cAcc.data);
          } catch (e) {
            this.logger.warn("curve decode failed", { mint: p.token.mint, err: (e as Error).message });
          }
        }
      }
      const curveMatches = p.derivedCurve && p.token.provider_curve ? (p.derivedCurve === p.token.provider_curve ? 1 : 0) : null;
      if (curveMatches === 0) this.stats.curveMismatch++;

      // The chain must agree with the provider's story. Seen live: PumpPortal
      // reported a token-paired launch with the *quote* mint (PUMP) in its
      // `mint` field, which made a long-existing token look brand new.
      let conflict: string | null = null;
      if (curveMatches === 0) conflict = "provider curve address does not derive from this mint";
      else if (p.derivedCurve && !curve) conflict = "no pump.fun bonding curve at the address derived from this mint";
      if (conflict) {
        this.stats.conflicts++;
        // Creation time that came only from the conflicting provider event is not trusted.
        this.db
          .prepare("UPDATE tokens SET created_at = NULL, created_at_evidence = NULL, created_at_source = NULL WHERE mint = ? AND created_at_source LIKE '%:create_received'")
          .run(p.token.mint);
      }

      this.db
        .prepare(
          `UPDATE tokens SET confirm_status = ?, confirm_note = ?, confirm_attempts = confirm_attempts + 1, confirmed_at = ?, confirmed_slot = ?,
             mint_program = ?, mint_authority = ?, freeze_authority = ?, decimals = ?, supply = ?, extensions = ?,
             curve_key_matches = ?,
             curve_complete = ?, curve_virtual_quote = ?, curve_virtual_token = ?, curve_real_quote = ?,
             curve_quote_mint = ?, curve_quote_mint_assumed = ?,
             creator = COALESCE(?, creator), creator_evidence = CASE WHEN ? IS NOT NULL THEN 'ONCHAIN_CONFIRMED' ELSE creator_evidence END,
             updated_at = ?
           WHERE mint = ?`,
        )
        .run(
          conflict ? "CONFLICT" : "CONFIRMED",
          conflict,
          at,
          res.slot,
          mint.program,
          mint.mintAuthority,
          mint.freezeAuthority,
          mint.decimals,
          mint.supply.toString(),
          JSON.stringify(mint.extensions),
          curveMatches,
          curve ? (curve.complete ? 1 : 0) : null,
          curve?.virtualQuoteReserves.toString() ?? null,
          curve?.virtualTokenReserves.toString() ?? null,
          curve?.realQuoteReserves.toString() ?? null,
          curve?.quoteMint ?? null,
          curve ? (curve.quoteMintAssumed ? 1 : 0) : null,
          curve?.creator ?? null,
          curve?.creator ?? null,
          at,
          p.token.mint,
        );
      // On-chain curve state can move the stage forward, never back.
      if (curve?.complete && (p.token.stage === "UNKNOWN" || p.token.stage === "BONDING")) {
        this.db.prepare("UPDATE tokens SET stage = 'COMPLETE', stage_evidence = 'ONCHAIN_CONFIRMED' WHERE mint = ?").run(p.token.mint);
      } else if (curve && !curve.complete && p.token.stage === "UNKNOWN") {
        this.db.prepare("UPDATE tokens SET stage = 'BONDING', stage_evidence = 'ONCHAIN_CONFIRMED' WHERE mint = ?").run(p.token.mint);
      } else if (curve && !curve.complete && p.token.stage === "BONDING") {
        this.db.prepare("UPDATE tokens SET stage_evidence = 'ONCHAIN_CONFIRMED' WHERE mint = ?").run(p.token.mint);
      }
      if (!conflict) this.stats.confirmed++;
    }
    return plan.length;
  }

  private mark(mint: string, status: "NOT_FOUND" | "NOT_A_MINT" | "ERROR"): void {
    this.db.prepare("UPDATE tokens SET confirm_status = ?, confirm_attempts = confirm_attempts + 1, updated_at = ? WHERE mint = ?").run(status, this.now(), mint);
  }
}
