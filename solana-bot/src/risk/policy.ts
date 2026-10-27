/**
 * Risk policy for the Phase 3 tradability gate.
 *
 * EVERY NUMBER HERE IS A PLACEHOLDER. None of them is an industry standard or
 * a validated threshold. They exist so the gate can run and so Phase 3 can
 * measure how many tokens each rule rejects. Phase 5–6 replay and forward-test
 * data will set them. Changing a threshold to let more trades through needs
 * your sign-off, the same as any other risk limit.
 */
export interface RiskPolicy {
  /** Position size used to ask for quotes, in CAD (spec: CAD 25–40). */
  evalSizeCad: number;
  /** Slippage passed to the quote request. Affects minOut only, not outAmount. */
  quoteSlippageBps: number;
  /** A quote older than this is stale and unusable. */
  maxQuoteAgeMs: number;
  /** Buy and sell quotes must be taken this close together to describe the same market. */
  maxQuoteGapMs: number;
  maxBuyImpactPct: number;
  maxSellImpactPct: number;
  /** Executable round trip (buy then immediately sell) plus network fees, in bps of size. */
  maxRoundTripCostBps: number;
  maxRouteHops: number;
  /** Route labels we accept, as Jupiter reports them. Unknown labels are rejected. */
  allowedRouteLabels: string[];
  maxTop10WalletPct: number;
  maxLargestWalletPct: number;
  maxCreatorPct: number;
  /** Token-2022 extensions considered harmless for a spot trade. Anything else is rejected. */
  allowedExtensions: string[];
  /** Compute-unit limit assumed per swap when estimating priority fees (estimate, not measured). */
  assumedComputeUnits: number;
  /** Cap on the priority-fee estimate we will budget for (micro-lamports per CU). */
  maxPriorityMicroLamports: number;
  /** Cool-down before a rejected token is looked at again. */
  recheckAfterMarketRejectMs: number;
  /** A PASS goes stale for entries after maxAssessmentAgeMs (2 min), so re-check sooner than that. */
  recheckAfterPassMs: number;
  recheckAfterStructuralRejectMs: number;
  /** Rejects caused only by missing data (rate limits, outages) are retried sooner. */
  recheckAfterDataRejectMs: number;
  /**
   * A pump.fun curve must hold at least this many times our position in REAL
   * SOL. Sells are paid from real reserves only; virtual reserves set the price
   * but can't pay anyone out.
   */
  minCurveRealSolMultiple: number;
  /** Documented pump.fun curve fee per side, used to flag quotes that disagree with it. */
  documentedCurveFeeBps: number;
  /** Skip candidates whose provider-reported liquidity is below this (saves RPC budget). */
  minCandidateLiquidityUsd: number;
  /** Time between full assessments. Each costs ~4–5 RPC calls and 2 quotes. */
  assessIntervalMs: number;
  /** Don't start an assessment with fewer RPC calls than this left in today's budget. */
  minRpcBudgetToAssess: number;
}

export const DEFAULT_POLICY: RiskPolicy = {
  evalSizeCad: 30,
  quoteSlippageBps: 300,
  maxQuoteAgeMs: 5_000,
  maxQuoteGapMs: 5_000,
  maxBuyImpactPct: 3,
  maxSellImpactPct: 3,
  maxRoundTripCostBps: 600,
  maxRouteHops: 2,
  // Labels observed on live Jupiter quotes are added here only after they are seen and checked.
  // "Whirlpool" (Orca) added after it showed up on live routes for graduated tokens.
  // Seen but NOT allowed yet (unverified venues): GoonFi V2, TesseraV, Kipseli, BisonFi,
  // Manifest, Byreal, Obsidian, Deriverse, PancakeSwap.
  allowedRouteLabels: ["Pump.fun", "Pump.fun Amm", "Raydium Launchlab", "Meteora DBC", "Meteora DAMM v2", "Raydium CPMM", "Raydium", "Meteora DLMM", "Raydium CLMM", "Whirlpool"],
  maxTop10WalletPct: 35,
  maxLargestWalletPct: 10,
  maxCreatorPct: 10,
  allowedExtensions: ["MetadataPointer", "TokenMetadata", "GroupPointer", "TokenGroup", "GroupMemberPointer", "TokenGroupMember"],
  assumedComputeUnits: 200_000,
  maxPriorityMicroLamports: 2_000_000,
  recheckAfterMarketRejectMs: 10 * 60_000,
  recheckAfterPassMs: 90_000,
  recheckAfterStructuralRejectMs: 24 * 3_600_000,
  recheckAfterDataRejectMs: 2 * 60_000,
  minCurveRealSolMultiple: 5,
  documentedCurveFeeBps: 125,
  minCandidateLiquidityUsd: 5_000,
  assessIntervalMs: 30_000,
  minRpcBudgetToAssess: 500,
};
