/**
 * Session awareness + market regime detection.
 *
 * Real traders only trade when the market has volume.
 * 80% of FX volume happens during London + New York sessions.
 */
import { CONFIG } from "./config.js";

// ── Session detection ─────────────────────────────────────────────────────────

export function getActiveSession(utcHour = new Date().getUTCHours()) {
  const { london, newYork, overlap } = CONFIG.sessions;
  const sessions = [];

  if (utcHour >= london.open   && utcHour < london.close)   sessions.push("London");
  if (utcHour >= newYork.open  && utcHour < newYork.close)  sessions.push("New York");
  if (utcHour >= overlap.open  && utcHour < overlap.close)  sessions.push("Overlap");

  // Tokyo: 00:00 - 09:00 UTC
  if (utcHour >= 0 && utcHour < 9)   sessions.push("Tokyo");
  // Sydney: 22:00 - 07:00 UTC
  if (utcHour >= 22 || utcHour < 7)  sessions.push("Sydney");

  return sessions;
}

export function isHighLiquiditySession() {
  const now = new Date();
  const utcHour = now.getUTCHours();
  const utcDay  = now.getUTCDay(); // 0=Sun, 6=Sat

  // Weekend → closed
  if (utcDay === 0 || (utcDay === 6 && utcHour >= 21)) return false;
  // Friday close
  if (utcDay === 5 && utcHour >= 21) return false;

  // London or New York session active
  const { london, newYork } = CONFIG.sessions;
  return (utcHour >= london.open && utcHour < london.close) ||
         (utcHour >= newYork.open && utcHour < newYork.close);
}

export function isWeekend() {
  const now = new Date();
  const day = now.getUTCDay();
  const hr  = now.getUTCHours();
  return day === 0 || day === 6 || (day === 5 && hr >= 21);
}

export function sessionScore() {
  const sessions = getActiveSession();
  if (sessions.includes("Overlap")) return 1.0;   // highest liquidity
  if (sessions.includes("London"))  return 0.85;
  if (sessions.includes("New York")) return 0.75;
  if (sessions.includes("Tokyo"))   return 0.5;
  return 0.3;                                      // off-hours
}

// ── Market regime ─────────────────────────────────────────────────────────────

/**
 * Classify the market regime from enriched candle data.
 * Returns one of: STRONG_BULL | BULL | RANGING | BEAR | STRONG_BEAR | VOLATILE
 */
export function classifyRegime(enrichedCandles) {
  const last = enrichedCandles[enrichedCandles.length - 1];
  if (!last?.adx || !last?.ema20 || !last?.ema50) return "UNKNOWN";

  const { adx: adxVal, diPlus, diMinus, ema20, ema50, ema200, rsi, atr, close } = last;

  // Volatility spike — ATR > 2× its 20-bar average
  const atrArr  = enrichedCandles.slice(-20).map((c) => c.atr).filter(Boolean);
  const atrMean = atrArr.reduce((a, b) => a + b, 0) / atrArr.length;
  if (atr > atrMean * 2.2) return "VOLATILE";

  const trending  = adxVal >= CONFIG.adxTrendThreshold;
  const bullTrend = ema20 > ema50 && (ema200 ? ema50 > ema200 : true);
  const bearTrend = ema20 < ema50 && (ema200 ? ema50 < ema200 : true);

  if (!trending) return "RANGING";
  if (bullTrend && diPlus > diMinus) return adxVal > 40 ? "STRONG_BULL" : "BULL";
  if (bearTrend && diMinus > diPlus) return adxVal > 40 ? "STRONG_BEAR" : "BEAR";
  return "RANGING";
}

/**
 * Which strategy types work best in each regime.
 */
export const REGIME_STRATEGY_MAP = {
  STRONG_BULL: ["trend_follow", "strength", "breakout"],
  BULL:        ["trend_follow", "strength", "mean_reversion", "breakout"],
  RANGING:     ["mean_reversion", "strength"],
  BEAR:        ["trend_follow", "strength", "mean_reversion", "breakout"],
  STRONG_BEAR: ["trend_follow", "strength", "breakout"],
  VOLATILE:    ["mean_reversion"],   // only fade extremes in volatile conditions
  UNKNOWN:     ["strength"],
};
