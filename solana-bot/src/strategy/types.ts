import type { Features } from "./features.ts";

export type StrategyId = "A_continuation" | "B_breakout_retest" | "B_breakout_no_retest" | "C_early_acceleration";

/**
 * An entry idea. Strategies only describe the setup; the risk manager decides
 * whether, and how much. Prices are SOL per whole token.
 */
export interface Signal {
  strategy: StrategyId;
  action: "ENTER" | "NONE";
  /** Why it fired, or the first reasons it didn't. */
  reasons: string[];
  /** Price the setup was read at (last trade). */
  refPrice?: number;
  /** Don't pay more than this; beyond it the setup is too extended. */
  maxEntryPrice?: number;
  /** The setup is wrong below this price. Drives the stop and the position size. */
  invalidationPrice?: number;
  /** Rule-based objective, not a prediction. */
  targetPrice?: number;
  /** (target − ref) / ref, gross, before costs. */
  expectedMovePct?: number;
  timeStopMs?: number;
  /** After a failed or rejected signal, wait this long before firing again on the same token. */
  cooldownMs: number;
}

export interface FailureSignal {
  action: "EXIT" | "VETO" | "NONE";
  reasons: string[];
}

export type Strategy = (f: Features, ctx: StrategyContext) => Signal;

export interface StrategyContext {
  /** Token age in ms from on-chain-supported creation time, if known. */
  tokenAgeMs?: number;
}

export function none(strategy: StrategyId, reasons: string[], cooldownMs: number): Signal {
  return { strategy, action: "NONE", reasons, cooldownMs };
}
