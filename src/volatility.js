/**
 * Volatility Regime Module
 *
 * ATR Percentile: where is current volatility vs last 100 bars?
 *   - < 25th pct → low vol  → tighten stops, reduce size
 *   - 25–75th pct → normal  → standard parameters
 *   - > 75th pct → high vol → widen stops, reduce size
 *   - > 90th pct → extreme  → skip entries (avoid whipsaw)
 *
 * Portfolio Heat: total open risk as % of equity.
 *   Sum of (entry - stop) * units across all open trades.
 *   Cap total portfolio heat at 3% to prevent correlated blowup.
 */

// ── ATR Percentile ────────────────────────────────────────────────────────────
/**
 * Returns a 0–100 percentile score of current ATR vs recent history.
 * Higher = more volatile than usual.
 */
export function atrPercentile(candles, lookback = 100) {
  if (candles.length < lookback + 1) return 50;

  const slice  = candles.slice(-lookback);
  const atrs   = slice.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = slice[i - 1];
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
  });

  const current = atrs[atrs.length - 1];
  const sorted  = [...atrs].sort((a, b) => a - b);
  // Count strictly less than current to avoid inflating percentile when values repeat
  const below = sorted.filter(v => v < current).length;
  const equal = sorted.filter(v => v === current).length;
  const rank  = below + equal * 0.5;  // rank duplicates at their midpoint

  return Math.round((rank / sorted.length) * 100);
}

// ── Volatility Regime ─────────────────────────────────────────────────────────
/**
 * Returns a volatility regime label and sizing multiplier.
 */
export function getVolRegime(atrPct) {
  if (atrPct >= 90) return { label: 'EXTREME',  sizeMult: 0.0,  stopMult: 1.6, skip: true  };
  if (atrPct >= 75) return { label: 'HIGH',     sizeMult: 0.6,  stopMult: 1.4, skip: false };
  if (atrPct >= 25) return { label: 'NORMAL',   sizeMult: 1.0,  stopMult: 1.0, skip: false };
  return              { label: 'LOW',      sizeMult: 0.75, stopMult: 0.8, skip: false };
}

// ── Session Volatility Multiplier ─────────────────────────────────────────────
/**
 * Trading sessions have different volatility profiles.
 * London/NY overlap = highest; Asian = lowest.
 */
export function sessionVolMult(sessionNames) {
  if (!sessionNames || sessionNames.length === 0) return 0.7;

  const hasLondon = sessionNames.includes('London');
  const hasNY     = sessionNames.includes('New York');

  if (hasLondon && hasNY) return 1.2;   // London/NY overlap
  if (hasLondon || hasNY) return 1.0;
  return 0.75;                           // Asian session — low vol
}

// ── Portfolio Heat ────────────────────────────────────────────────────────────
const _openHeat = new Map();  // tradeId → risk in USD

export function registerTradeHeat(tradeId, riskUsd) {
  _openHeat.set(String(tradeId), riskUsd);
}

export function removeTradeHeat(tradeId) {
  _openHeat.delete(String(tradeId));
}

export function getTotalHeat() {
  let total = 0;
  for (const v of _openHeat.values()) total += v;
  return total;
}

export function getHeatPct(balance) {
  return balance > 0 ? getTotalHeat() / balance : 0;
}

/**
 * Check if adding a new trade would exceed max portfolio heat.
 * Returns { ok, heatPct, reason }
 */
export function heatCheck(balance, newRiskUsd, maxHeatPct = 0.03) {
  const currentHeat  = getTotalHeat();
  const projectedPct = (currentHeat + newRiskUsd) / balance;

  if (projectedPct > maxHeatPct) {
    return {
      ok: false,
      heatPct: +projectedPct.toFixed(4),
      reason: `Portfolio heat ${(projectedPct * 100).toFixed(1)}% would exceed ${maxHeatPct * 100}% limit`,
    };
  }
  return { ok: true, heatPct: +projectedPct.toFixed(4), reason: 'OK' };
}

export function getHeatState() {
  return {
    totalHeatUsd: +getTotalHeat().toFixed(2),
    openTrades:   _openHeat.size,
    breakdown:    Object.fromEntries(_openHeat),
  };
}
