/**
 * Provider venue labels → our Venue type.
 *
 * Only labels we have actually seen in provider responses (2026-10-26) or that
 * are documented are mapped. Anything else becomes `other`, with the raw label
 * kept so the coverage report shows what we're missing.
 */
import type { ProviderId, Venue } from "../core/types.ts";

const MAPS: Partial<Record<ProviderId, Record<string, Venue>>> = {
  // PumpPortal `pool` field. "pump" observed live. Others are from PumpPortal's
  // trade-API pool list (pump, pump-amm, raydium, launchlab, raydium-cpmm, bonk).
  pumpportal: {
    pump: "pump_curve",
    "pump-amm": "pumpswap",
    launchlab: "raydium_launchlab",
    bonk: "raydium_launchlab",
    "raydium-cpmm": "raydium_cpmm",
    raydium: "raydium_amm",
  },
  // GeckoTerminal dex ids. pump-fun, pumpswap, meteora-dbc, meteora-damm-v2 observed live.
  geckoterminal: {
    "pump-fun": "pump_curve",
    pumpswap: "pumpswap",
    "meteora-dbc": "meteora_dbc",
    "meteora-damm-v2": "meteora_damm",
    "raydium-launchlab": "raydium_launchlab",
    raydium: "raydium_amm",
    "raydium-clmm": "raydium_clmm",
  },
  // Jupiter Tokens v2 `launchpad`. pump.fun, raydium-launchlab, met-dbc observed live.
  jupiter_tokens: {
    "pump.fun": "pump_curve",
    "raydium-launchlab": "raydium_launchlab",
    "met-dbc": "meteora_dbc",
  },
  // DexScreener dexId. pumpfun, pumpswap observed live; meteoradbc reported in research.
  dexscreener: {
    pumpfun: "pump_curve",
    pumpswap: "pumpswap",
    meteoradbc: "meteora_dbc",
    raydium: "raydium_amm",
  },
};

export function mapVenue(provider: ProviderId, raw: string | null | undefined): Venue {
  if (!raw) return "other";
  return MAPS[provider]?.[raw.toLowerCase()] ?? "other";
}
