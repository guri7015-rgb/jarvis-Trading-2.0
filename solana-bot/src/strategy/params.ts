/**
 * Strategy parameters as one object, so research tools can vary them and the
 * live engine can load a reviewed set from a file.
 *
 * Rules:
 *  - The defaults are the placeholders in strategy{A,B,C,D}.ts.
 *  - A params file (data/strategy-params.json) may override any of them. Its
 *    SHA-256 is logged at start so every decision can be traced to a known set.
 *  - Tune on a TRAIN window, check on VALIDATION, look at TEST once. The tune
 *    tool writes candidates to data/strategy-params.candidate.json; adopting
 *    one is a manual step (rename the file), never automatic.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { A_PARAMS } from "./strategyA.ts";
import { B_PARAMS } from "./strategyB.ts";
import { C_PARAMS } from "./strategyC.ts";
import { D_PARAMS } from "./strategyD.ts";

export interface StrategyParams {
  A: typeof A_PARAMS;
  B: typeof B_PARAMS;
  C: typeof C_PARAMS;
  D: typeof D_PARAMS;
}

export const DEFAULT_PARAMS: StrategyParams = { A: { ...A_PARAMS }, B: { ...B_PARAMS }, C: { ...C_PARAMS }, D: { ...D_PARAMS } };

/**
 * Explore-mode parameters (paper only): the same shapes with looser entry
 * thresholds so setups fire often enough to measure execution. D (the veto)
 * is unchanged. Nothing here is a tuned result.
 */
export const EXPLORE_PARAMS: StrategyParams = {
  A: { ...A_PARAMS, minImpulsePct: 0.05, maxConsolidationRangePct: 0.1, minBuyers60: 5, maxTopBuyerShare: 0.4, maxRepeatedSizeRatio: 0.7, maxExtensionPct: 0.05, targetImpulseFraction: 0.8 },
  B: { ...B_PARAMS, minRangeTrades: 10, minBreakoutPct: 0.01, minRateAccel: 1.5, minBuyers60: 5, maxTopBuyerShare: 0.4, targetRangeFraction: 0.8 },
  C: { ...C_PARAMS, minTrades30: 6, minRateAccel: 1.5, minNewBuyers30: 4, minImbalance60: 0.2, maxTopBuyerShare: 0.4, maxRepeatedSizeRatio: 0.7, minRet60: 0.02, targetPct: 0.15 },
  D: { ...D_PARAMS },
};

/** Drill-mode data quality: the entry fills from a live quote, so the tape only needs a recent price. */
export const DRILL_QUALITY = { minTrades180s: 1, maxSecondsSinceLastTrade: 900, maxMedianLagS: 30, blockingGapMs: 30_000 };

/** Explore-mode data quality: half the trades, a minute of silence allowed. Lag and gap rules unchanged. */
export const EXPLORE_QUALITY = { minTrades180s: 10, maxSecondsSinceLastTrade: 60, maxMedianLagS: 10, blockingGapMs: 2_000 };

const numRecord = (template: Record<string, number>) => z.object(Object.fromEntries(Object.keys(template).map((k) => [k, z.number().finite().optional()]))).strict();
const FileSchema = z
  .object({ A: numRecord(A_PARAMS).optional(), B: numRecord(B_PARAMS).optional(), C: numRecord(C_PARAMS).optional(), D: numRecord(D_PARAMS).optional(), note: z.string().max(500).optional() })
  .strict();

export interface ParamsLoad {
  params: StrategyParams;
  source: "defaults" | "file";
  sha256?: string;
  overridden: string[];
}

export function loadStrategyParams(path?: string): ParamsLoad {
  if (!path || !existsSync(path)) return { params: DEFAULT_PARAMS, source: "defaults", overridden: [] };
  const raw = readFileSync(path, "utf8");
  const parsed = FileSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error(`invalid strategy params file: ${parsed.error.issues[0]?.path.join(".")}`);
  const params: StrategyParams = { A: { ...A_PARAMS }, B: { ...B_PARAMS }, C: { ...C_PARAMS }, D: { ...D_PARAMS } };
  const overridden: string[] = [];
  for (const k of ["A", "B", "C", "D"] as const) {
    for (const [key, v] of Object.entries(parsed.data[k] ?? {})) {
      if (v === undefined) continue;
      (params[k] as Record<string, number>)[key] = v;
      overridden.push(`${k}.${key}`);
    }
  }
  return { params, source: "file", sha256: createHash("sha256").update(raw).digest("hex"), overridden };
}
