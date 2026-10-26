/**
 * Program and mint addresses, with where each was verified (2026-10-26).
 * See docs/PROVIDER-RESEARCH.md for the source links.
 */
export const PROGRAMS = {
  /** pump.fun bonding curve. Source: github.com/pump-fun/pump-public-docs (idl/pump.json "address"). */
  PUMP_CURVE: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  /** PumpSwap AMM. Source: pump-public-docs idl/pump_amm.json "address". */
  PUMPSWAP: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
  /** SPL Token program. Source: solana.com/docs/tokens. */
  TOKEN: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  /** Token-2022 program. Source: solana.com/docs/tokens/extensions. */
  TOKEN_2022: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
} as const;

export const MINTS = {
  WSOL: "So11111111111111111111111111111111111111112",
  USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
} as const;

/**
 * pump.fun BondingCurve account discriminator, from idl/pump.json `accounts`.
 * pump-public-docs commit 639b87fb (2026-10-13).
 */
export const PUMP_BONDING_CURVE_DISCRIMINATOR = Uint8Array.from([23, 183, 248, 55, 96, 216, 172, 96]);

/** PDA seed for a pump.fun bonding curve: ["bonding-curve", mint]. Source: idl/pump.json `buy.accounts.bonding_curve.pda`. */
export const PUMP_BONDING_CURVE_SEED = "bonding-curve";
