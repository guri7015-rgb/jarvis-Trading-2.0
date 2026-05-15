/**
 * Currency Strength Meter
 *
 * The single most powerful signal in FX.
 * Measures how much each currency has moved in 24h, normalized across all pairs.
 * When a currency is the strongest and paired against the weakest → high-conviction entry.
 *
 * Returns scores from -1.0 (weakest) to +1.0 (strongest).
 */
import { INSTRUMENTS } from "./config.js";

// All pairs and which currencies they represent
const PAIR_CURRENCIES = {
  EUR_USD: { base: "EUR", quote: "USD" },
  GBP_USD: { base: "GBP", quote: "USD" },
  USD_JPY: { base: "USD", quote: "JPY" },
  USD_CHF: { base: "USD", quote: "CHF" },
  AUD_USD: { base: "AUD", quote: "USD" },
  USD_CAD: { base: "USD", quote: "CAD" },
  NZD_USD: { base: "NZD", quote: "USD" },
  XAU_USD: { base: "XAU", quote: "USD" },
};

/**
 * Calculate currency strength from a map of { instrument: candles[] }
 * Returns { EUR: 0.82, USD: -0.12, JPY: -0.74, ... }
 */
export function calcStrength(candleMap, lookback = 24) {
  const scores = {};      // currency → sum of % moves
  const counts = {};      // currency → number of pairs counted

  for (const [inst, candles] of Object.entries(candleMap)) {
    const meta = PAIR_CURRENCIES[inst];
    if (!meta || candles.length < lookback + 1) continue;

    const recent  = candles.slice(-lookback);
    const first   = recent[0].close;
    const last    = recent[recent.length - 1].close;
    if (!first || !last) continue;

    // % change of the pair over lookback bars
    const pairMove = (last - first) / first;

    // base currency moved positively, quote negatively (for a rising pair)
    scores[meta.base] = (scores[meta.base] || 0) + pairMove;
    scores[meta.quote] = (scores[meta.quote] || 0) - pairMove;
    counts[meta.base] = (counts[meta.base] || 0) + 1;
    counts[meta.quote] = (counts[meta.quote] || 0) + 1;
  }

  // Average by pair count
  const raw = {};
  for (const ccy of Object.keys(scores)) {
    raw[ccy] = counts[ccy] ? scores[ccy] / counts[ccy] : 0;
  }

  // Normalize to [-1, +1]
  const values = Object.values(raw);
  const max = Math.max(...values.map(Math.abs));
  const normalized = {};
  for (const [ccy, val] of Object.entries(raw)) {
    normalized[ccy] = max > 0 ? +(val / max).toFixed(4) : 0;
  }

  return normalized;
}

/**
 * Rank currencies from strongest (+1) to weakest (-1)
 */
export function rankCurrencies(strength) {
  return Object.entries(strength)
    .sort((a, b) => b[1] - a[1])
    .map(([ccy, score], rank) => ({ ccy, score, rank: rank + 1 }));
}

/**
 * For a given instrument, return whether there's a meaningful strength divergence
 * between its base and quote currency, and the direction to trade.
 */
export function getStrengthSignal(instrument, strength, threshold = 0.4) {
  const meta = PAIR_CURRENCIES[instrument];
  if (!meta) return null;

  const baseScore  = strength[meta.base]  ?? 0;
  const quoteScore = strength[meta.quote] ?? 0;
  const diff = baseScore - quoteScore;

  if (Math.abs(diff) < threshold) return null;

  return {
    direction:   diff > 0 ? "LONG" : "SHORT",
    differential: +Math.abs(diff).toFixed(4),
    baseScore:   +baseScore.toFixed(4),
    quoteScore:  +quoteScore.toFixed(4),
    baseCcy:     meta.base,
    quoteCcy:    meta.quote,
  };
}

/**
 * Find the single best strength-based trade across all instruments.
 */
export function getBestStrengthPair(candleMap, threshold = 0.4) {
  const strength = calcStrength(candleMap);
  const ranked   = rankCurrencies(strength);
  const strongest = ranked[0];
  const weakest   = ranked[ranked.length - 1];

  // Find the instrument that pairs strongest vs weakest
  for (const [inst, meta] of Object.entries(PAIR_CURRENCIES)) {
    if (!INSTRUMENTS.includes(inst)) continue;
    if (meta.base === strongest.ccy && meta.quote === weakest.ccy)
      return { instrument: inst, direction: "LONG", differential: strongest.score - weakest.score, strength };
    if (meta.base === weakest.ccy && meta.quote === strongest.ccy)
      return { instrument: inst, direction: "SHORT", differential: strongest.score - weakest.score, strength };
  }

  return null;
}
