/**
 * Hard risk limits (spec §9 and §16). Defaults are the spec's starting caps.
 *
 * Overrides can come from a JSON file. Any override that LOOSENS a limit is
 * refused unless a confirmation file contains the SHA-256 of the override file:
 * a deliberate, separate step by the owner. Tightening needs no confirmation.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

export interface RiskLimits {
  referenceEquityCad: number;
  maxPositionCad: number;
  /** Below this a trade isn't worth its fixed costs; skip rather than size up. */
  minPositionCad: number;
  /** Planned loss at the stop, including costs and a stress allowance. */
  maxLossPerTradeCad: number;
  dailyLossLimitCad: number;
  maxEntriesPerDay: number;
  maxOpenPositions: number;
  /** Consecutive losing trades before a cool-down. */
  maxConsecutiveLosses: number;
  /** Extra adverse move assumed on top of the stop distance (gaps, slow exits). */
  stressPct: number;
  /** Expected net move must exceed break-even by at least this. */
  minEdgeOverBreakEvenPct: number;
  minRewardToRisk: number;
  /** A gate assessment older than this can't support an entry. */
  maxAssessmentAgeMs: number;
}

export const DEFAULT_LIMITS: RiskLimits = {
  referenceEquityCad: 500,
  maxPositionCad: 35,
  minPositionCad: 15,
  maxLossPerTradeCad: 2.5,
  dailyLossLimitCad: 10,
  maxEntriesPerDay: 3,
  maxOpenPositions: 1,
  maxConsecutiveLosses: 3,
  stressPct: 0.02,
  minEdgeOverBreakEvenPct: 0.02,
  minRewardToRisk: 1.5,
  maxAssessmentAgeMs: 2 * 60_000,
};

/**
 * Explore mode (paper only). Every MONEY cap is identical to the defaults:
 * same position size, same loss per trade, same daily loss, same entry count.
 * Only the two edge floors are lowered so that paper fills actually happen and
 * the fill-versus-quote gap, failure rate and stress allowance can be measured.
 * Trades made under these limits never count toward live eligibility.
 */
export const EXPLORE_LIMITS: RiskLimits = {
  ...DEFAULT_LIMITS,
  minEdgeOverBreakEvenPct: 0,
  minRewardToRisk: 1.0,
};

/**
 * Drill mode (paper only, started by the owner on purpose): a forced paper entry
 * every few minutes to exercise fills and exits. The edge floors are off, the
 * entry count is effectively unlimited and the daily paper loss cap is CAD 25
 * so a session lasts long enough to produce data. Position size and loss per
 * trade are unchanged. Nothing from this mode counts toward live eligibility.
 */
export const DRILL_LIMITS: RiskLimits = {
  ...DEFAULT_LIMITS,
  minEdgeOverBreakEvenPct: -1,
  minRewardToRisk: 0,
  maxEntriesPerDay: 500,
  maxConsecutiveLosses: 500,
  dailyLossLimitCad: 25,
};

/** For each limit: does a bigger number mean more risk? */
const HIGHER_IS_LOOSER: Record<keyof RiskLimits, boolean> = {
  referenceEquityCad: true,
  maxPositionCad: true,
  minPositionCad: false,
  maxLossPerTradeCad: true,
  dailyLossLimitCad: true,
  maxEntriesPerDay: true,
  maxOpenPositions: true,
  maxConsecutiveLosses: true,
  stressPct: false,
  minEdgeOverBreakEvenPct: false,
  minRewardToRisk: false,
  maxAssessmentAgeMs: true,
};

const OverrideSchema = z
  .object(Object.fromEntries(Object.keys(DEFAULT_LIMITS).map((k) => [k, z.number().finite().nonnegative().optional()])) as Record<keyof RiskLimits, z.ZodOptional<z.ZodNumber>>)
  .strict();

export interface LimitsLoad {
  limits: RiskLimits;
  /** Loosened limits that were refused for lack of confirmation (defaults kept for them). */
  refused: string[];
  loosenedConfirmed: string[];
}

export function loadRiskLimits(overridePath?: string, confirmPath?: string): LimitsLoad {
  const limits: RiskLimits = { ...DEFAULT_LIMITS };
  const refused: string[] = [];
  const loosenedConfirmed: string[] = [];
  if (!overridePath || !existsSync(overridePath)) return { limits, refused, loosenedConfirmed };
  const raw = readFileSync(overridePath, "utf8");
  const parsed = OverrideSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`invalid risk limits file: ${parsed.error.issues[0]?.path.join(".")}`);
  const hash = createHash("sha256").update(raw).digest("hex");
  const confirmed = !!confirmPath && existsSync(confirmPath) && readFileSync(confirmPath, "utf8").trim() === hash;
  for (const [k, v] of Object.entries(parsed.data) as [keyof RiskLimits, number | undefined][]) {
    if (v === undefined) continue;
    const looser = HIGHER_IS_LOOSER[k] ? v > DEFAULT_LIMITS[k] : v < DEFAULT_LIMITS[k];
    if (looser && !confirmed) {
      refused.push(k);
      continue;
    }
    if (looser) loosenedConfirmed.push(k);
    limits[k] = v;
  }
  return { limits, refused, loosenedConfirmed };
}
