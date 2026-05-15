/**
 * Five trading strategies — each returns a Signal or null.
 *
 * Signal shape:
 * { instrument, direction, entry, sl, tp, rr, confidence, strategy, reasoning }
 */
import { CONFIG, PIP } from "../config.js";
import { enrich as _enrich, detectRSIDivergence, findKeyLevels } from "../indicators.js";
import { calcStrength, getStrengthSignal } from "../strength.js";
import { classifyRegime, REGIME_STRATEGY_MAP } from "../sessions.js";
import { smcSignal } from "./smc.js";

function rr(entry, sl, tp, dir) {
  const risk   = Math.abs(entry - sl);
  const reward = Math.abs(tp - entry);
  return risk > 0 ? +(reward / risk).toFixed(2) : 0;
}

function nearLevel(price, levels, pipSize, pipBuffer) {
  return levels.some((l) => Math.abs(l.price - price) / pipSize < pipBuffer);
}

// ── Strategy 1: Trend Following ────────────────────────────────────────────────
export function trendFollow(instrument, enriched) {
  const last = enriched[enriched.length - 1];
  const prev = enriched[enriched.length - 2];
  if (!last?.atr || !last?.rsi || !prev) return null;

  const { close: entry, ema20, ema50, macdHist, rsi: rsiVal, atr, adx: adxVal } = last;
  if (!adxVal || adxVal < CONFIG.adxTrendThreshold) return null;  // require trending market

  const crossUp   = ema20 > ema50 && prev.ema20 <= prev.ema50;
  const crossDown = ema20 < ema50 && prev.ema20 >= prev.ema50;
  const macdUp    = macdHist > 0  && prev.macdHist <= 0;
  const macdDown  = macdHist < 0  && prev.macdHist >= 0;

  let direction = null;
  if ((crossUp || macdUp) && rsiVal >= 45 && rsiVal <= 65 && ema20 > ema50)
    direction = "LONG";
  if ((crossDown || macdDown) && rsiVal >= 35 && rsiVal <= 55 && ema20 < ema50)
    direction = "SHORT";
  if (!direction) return null;

  const sl = direction === "LONG" ? entry - atr * CONFIG.atrSlMult : entry + atr * CONFIG.atrSlMult;
  const tp = direction === "LONG" ? entry + atr * CONFIG.atrTpMult : entry - atr * CONFIG.atrTpMult;
  const rrVal = rr(entry, sl, tp, direction);
  if (rrVal < CONFIG.minRR) return null;

  const confidence = 60 + (adxVal > 35 ? 10 : 0) + (crossUp || crossDown ? 10 : 5);

  return {
    instrument, direction, entry, sl, tp, rr: rrVal,
    confidence: Math.min(confidence, 90),
    strategy: "trend_follow",
    reasoning: `EMA${crossUp || crossDown ? " crossover" : "20>50"} + MACD ${direction === "LONG" ? "bullish" : "bearish"} | RSI ${rsiVal.toFixed(1)} | ADX ${adxVal.toFixed(1)}`,
  };
}

// ── Strategy 2: Currency Strength ─────────────────────────────────────────────
export function strengthStrategy(instrument, enriched, candleMap) {
  const last = enriched[enriched.length - 1];
  if (!last?.atr) return null;

  const strength  = calcStrength(candleMap, CONFIG.strengthLookback);
  const sig       = getStrengthSignal(instrument, strength, CONFIG.strengthThreshold);
  if (!sig) return null;

  const entry = last.close;
  const atr   = last.atr;
  const sl    = sig.direction === "LONG" ? entry - atr * CONFIG.atrSlMult : entry + atr * CONFIG.atrSlMult;
  const tp    = sig.direction === "LONG" ? entry + atr * CONFIG.atrTpMult : entry - atr * CONFIG.atrTpMult;
  const rrVal = rr(entry, sl, tp, sig.direction);
  if (rrVal < CONFIG.minRR) return null;

  const confidence = 55 + Math.min(sig.differential * 40, 30);

  return {
    instrument, direction: sig.direction, entry, sl, tp, rr: rrVal,
    confidence: Math.min(+confidence.toFixed(0), 92),
    strategy: "strength",
    reasoning: `${sig.baseCcy} strength ${sig.baseScore > 0 ? "+" : ""}${sig.baseScore} vs ${sig.quoteCcy} ${sig.quoteScore > 0 ? "+" : ""}${sig.quoteScore} (diff ${sig.differential})`,
  };
}

// ── Strategy 3: Mean Reversion ────────────────────────────────────────────────
export function meanReversion(instrument, enriched) {
  const last = enriched[enriched.length - 1];
  const prev = enriched[enriched.length - 2];
  if (!last?.atr || !last?.rsi || !prev) return null;

  const { close: entry, ema20, rsi: rsiVal, atr, macdHist, adx: adxVal } = last;

  // Mean reversion only works in ranging markets — penalize trending
  if (adxVal && adxVal > 35) return null;

  const nearEma = Math.abs(entry - ema20) / ema20 <= 0.002;
  const rsiDiv  = detectRSIDivergence(enriched, enriched.map((c) => c.rsi), CONFIG.rsiDivLookback);

  let direction = null;
  let divBonus  = 0;

  if (rsiVal < 30) { direction = "LONG";  divBonus = rsiDiv?.type === "bullish" ? 15 : 0; }
  if (rsiVal > 70) { direction = "SHORT"; divBonus = rsiDiv?.type === "bearish" ? 15 : 0; }

  // Softer threshold if RSI divergence present
  if (!direction && rsiDiv) {
    if (rsiDiv.type === "bullish" && rsiVal < 40) { direction = "LONG"; divBonus = 10; }
    if (rsiDiv.type === "bearish" && rsiVal > 60) { direction = "SHORT"; divBonus = 10; }
  }
  if (!direction) return null;

  const sl = direction === "LONG" ? entry - atr * CONFIG.atrSlMult : entry + atr * CONFIG.atrSlMult;
  const tp = direction === "LONG" ? entry + atr * CONFIG.atrTpMult : entry - atr * CONFIG.atrTpMult;
  const rrVal = rr(entry, sl, tp, direction);
  if (rrVal < CONFIG.minRR) return null;

  const confidence = 55 + (nearEma ? 8 : 0) + divBonus;

  return {
    instrument, direction, entry, sl, tp, rr: rrVal,
    confidence: Math.min(confidence, 88),
    strategy: "mean_reversion",
    reasoning: `RSI ${rsiVal.toFixed(1)} ${direction === "LONG" ? "oversold" : "overbought"}${rsiDiv ? " + RSI divergence" : ""}${nearEma ? " near EMA20" : ""}`,
  };
}

// ── Strategy 4: Gold / DXY Divergence ────────────────────────────────────────
export function goldDivergence(enrichedGold, enrichedDxy, candleMap) {
  if (!enrichedGold || !enrichedDxy) return null;
  const goldLast = enrichedGold[enrichedGold.length - 1];
  if (!goldLast?.atr) return null;

  // Proxy DXY via USD_JPY + USD_CHF combined strength
  const strength  = calcStrength(candleMap, 12);
  const usdScore  = strength["USD"] || 0;
  const goldScore = strength["XAU"] || 0;

  // Classic inverse: gold up = USD down. Divergence when they move together.
  const divergence = usdScore * goldScore; // both positive or both negative = divergence
  if (divergence > 0) return null;        // normal relationship — no divergence trade

  // Only act when divergence is significant
  const strength_diff = Math.abs(usdScore - goldScore);
  if (strength_diff < 0.5) return null;

  // Trade Gold in direction of its momentum (against USD)
  const direction = goldScore > 0 ? "LONG" : "SHORT";
  const entry = goldLast.close;
  const atr   = goldLast.atr;
  const sl = direction === "LONG" ? entry - atr * CONFIG.atrSlMult : entry + atr * CONFIG.atrSlMult;
  const tp = direction === "LONG" ? entry + atr * CONFIG.atrTpMult : entry - atr * CONFIG.atrTpMult;
  const rrVal = rr(entry, sl, tp, direction);
  if (rrVal < CONFIG.minRR) return null;

  const confidence = 60 + Math.min(strength_diff * 15, 20);

  return {
    instrument: "XAU_USD",
    direction, entry, sl, tp, rr: rrVal,
    confidence: Math.min(+confidence.toFixed(0), 85),
    strategy: "gold_dxy_divergence",
    reasoning: `USD strength ${usdScore > 0 ? "+" : ""}${usdScore.toFixed(2)} diverging from Gold ${goldScore > 0 ? "+" : ""}${goldScore.toFixed(2)} | classic inverse correlation`,
  };
}

// ── Strategy 5: Breakout ──────────────────────────────────────────────────────
export function breakout(instrument, enriched) {
  const last = enriched[enriched.length - 1];
  const prev = enriched[enriched.length - 2];
  if (!last?.atr || !prev) return null;

  const { close: entry, high, low, atr, adx: adxVal, macdHist } = last;
  const pip = PIP[instrument] || 0.0001;

  // Find recent range (last 20 bars)
  const range   = enriched.slice(-21, -1);
  const rangeH  = Math.max(...range.map((c) => c.high));
  const rangeL  = Math.min(...range.map((c) => c.low));
  const rangeW  = rangeH - rangeL;

  if (rangeW < atr * 1.5) return null;   // range too small to be meaningful

  const brokeHigh = entry > rangeH && prev.close <= rangeH;
  const brokeLow  = entry < rangeL && prev.close >= rangeL;
  if (!brokeHigh && !brokeLow) return null;

  // Require ADX building + MACD confirmation
  const prevAdx = enriched[enriched.length - 3]?.adx;
  const adxRising = adxVal && prevAdx && adxVal > prevAdx;
  if (!adxRising) return null;

  const direction = brokeHigh ? "LONG" : "SHORT";
  const sl = direction === "LONG" ? rangeH - atr * 0.5 : rangeL + atr * 0.5;
  const tp = direction === "LONG" ? entry + atr * CONFIG.atrTpMult : entry - atr * CONFIG.atrTpMult;
  const rrVal = rr(entry, sl, tp, direction);
  if (rrVal < CONFIG.minRR) return null;

  // S/R proximity filter — don't enter if immediately back into a key level
  const levels = findKeyLevels(enriched, 50);
  if (nearLevel(tp, levels, pip, CONFIG.srProximityPips))
    return null;  // TP blocked by nearby resistance

  const confidence = 65 + (adxVal > 30 ? 10 : 0) + (macdHist && macdHist > 0 === (direction === "LONG") ? 8 : 0);

  return {
    instrument, direction, entry, sl, tp, rr: rrVal,
    confidence: Math.min(confidence, 88),
    strategy: "breakout",
    reasoning: `${direction === "LONG" ? "Bullish" : "Bearish"} breakout of ${rangeW.toFixed(5)} range | ADX rising to ${adxVal?.toFixed(1)}`,
  };
}

// ── Run all applicable strategies for one instrument ─────────────────────────
export function runStrategies(instrument, enriched, candleMap, regime) {
  const allowed = REGIME_STRATEGY_MAP[regime] || [];
  const signals = [];

  if (allowed.includes("trend_follow")) {
    const s = trendFollow(instrument, enriched); if (s) signals.push(s);
  }
  if (allowed.includes("strength")) {
    const s = strengthStrategy(instrument, enriched, candleMap); if (s) signals.push(s);
  }
  if (allowed.includes("mean_reversion")) {
    const s = meanReversion(instrument, enriched); if (s) signals.push(s);
  }
  if (instrument === "XAU_USD" && allowed.length > 0) {
    const goldEnriched = enriched;
    const usdJpyC = candleMap["USD_JPY"];
    if (usdJpyC) {
      const s = goldDivergence(goldEnriched, enrich(usdJpyC), candleMap);
      if (s) signals.push(s);
    }
  }
  // Breakout is regime-agnostic but only in trending markets
  if (regime.includes("BULL") || regime.includes("BEAR")) {
    const s = breakout(instrument, enriched); if (s) signals.push(s);
  }

  // Strategy 6: SMC — always runs, strongest when structure aligns with regime
  {
    const last = enriched[enriched.length - 1];
    const atr  = last?.atr || 0.001;
    const s    = smcSignal(instrument, enriched, atr);
    if (s) signals.push(s);
  }

  // Return highest-confidence signal per instrument
  return signals.sort((a, b) => b.confidence - a.confidence)[0] || null;
}

// local alias for gold strategy
const enrich = _enrich;
