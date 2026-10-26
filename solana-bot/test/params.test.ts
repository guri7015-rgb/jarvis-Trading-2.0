import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { backtestTape, COST_MODELS, COST_MODELS_WORST } from "../src/paper/backtest.ts";
import { DEFAULT_LIMITS } from "../src/risk/limits.ts";
import { isRoundSize } from "../src/strategy/features.ts";
import { DEFAULT_PARAMS, loadStrategyParams } from "../src/strategy/params.ts";
import { A_PARAMS } from "../src/strategy/strategyA.ts";
import type { Trade } from "../src/strategy/features.ts";

const dir = mkdtempSync(join(tmpdir(), "params-"));

describe("strategy params file", () => {
  it("defaults to the placeholders when there is no file", () => {
    const l = loadStrategyParams(join(dir, "missing.json"));
    expect(l.source).toBe("defaults");
    expect(l.params.A.maxConsolidationRangePct).toBe(A_PARAMS.maxConsolidationRangePct);
  });

  it("applies overrides, records which, and hashes the file", () => {
    const f = join(dir, "p.json");
    writeFileSync(f, JSON.stringify({ A: { maxConsolidationRangePct: 0.1 }, C: { targetPct: 0.2 }, note: "test" }));
    const l = loadStrategyParams(f);
    expect(l.source).toBe("file");
    expect(l.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(l.overridden).toEqual(["A.maxConsolidationRangePct", "C.targetPct"]);
    expect(l.params.A.maxConsolidationRangePct).toBe(0.1);
    expect(l.params.B).toEqual(DEFAULT_PARAMS.B);
    // The defaults object itself is not mutated.
    expect(DEFAULT_PARAMS.A.maxConsolidationRangePct).toBe(A_PARAMS.maxConsolidationRangePct);
  });

  it("rejects unknown keys and non-numbers", () => {
    const f = join(dir, "bad.json");
    writeFileSync(f, JSON.stringify({ A: { leverage: 5 } }));
    expect(() => loadStrategyParams(f)).toThrow(/invalid/);
    writeFileSync(f, JSON.stringify({ A: { minImpulsePct: "ten" } }));
    expect(() => loadStrategyParams(f)).toThrow(/invalid/);
  });
});

describe("round sizes", () => {
  it("treats sizes a person would type as round, and odd sizes as not", () => {
    for (const s of [0.01, 0.1, 0.25, 0.5, 1, 1.5, 10]) expect(isRoundSize(s)).toBe(true);
    for (const s of [0.137421, 0.0103, 0.2501, 1.2345]) expect(isRoundSize(s)).toBe(false);
  });
});

describe("worst-case cost model", () => {
  it("is strictly more pessimistic than the median model on every venue", () => {
    for (const v of ["pump_curve", "pumpswap"] as const) {
      expect(COST_MODELS_WORST[v].impactPerSide).toBeGreaterThan(COST_MODELS[v].impactPerSide);
      expect(COST_MODELS_WORST[v].haircut).toBeGreaterThan(COST_MODELS[v].haircut);
      expect(COST_MODELS_WORST[v].failureRate).toBeGreaterThan(COST_MODELS[v].failureRate);
    }
  });

  it("backtest accepts a cost model and params override", () => {
    const T = 1_800_000_000_000;
    const tape: Trade[] = [];
    for (let s = 0; s < 400; s += 2) tape.push({ mint: "M", signature: `s${s}`, eventIndex: 0, slot: s, blockTimeMs: T + s * 1000, receivedAt: T + s * 1000 + 1000, side: "buy", wallet: `w${s}`, quoteSol: 0.1 + s * 0.0001, priceSol: 1 });
    const r = backtestTape("M", "pumpswap", tape, [], { limits: DEFAULT_LIMITS, stepMs: 5000, sizeCad: 30, solCad: 140, random: () => 0.5, costModels: COST_MODELS_WORST, params: { ...DEFAULT_PARAMS, A: { ...DEFAULT_PARAMS.A, minImpulsePct: 0.5 } } });
    expect(r.label).toBe("MODELLED");
    expect(r.trades).toHaveLength(0); // flat tape, no setups
  });
});
