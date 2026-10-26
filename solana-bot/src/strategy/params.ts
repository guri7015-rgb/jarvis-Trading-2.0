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
