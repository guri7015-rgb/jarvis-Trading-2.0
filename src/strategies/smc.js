/**
 * Smart Money Concepts (SMC) — Institutional Trading Logic
 *
 * What this adds vs standard indicators:
 *   - Order Blocks (OB): zones where institutions placed large orders
 *   - Fair Value Gaps (FVG): price imbalances institutions will revisit
 *   - Break of Structure (BOS): confirms trend direction change
 *   - Change of Character (CHoCH): early warning of reversal
 *   - Liquidity Pools: equal highs/lows where stop-losses cluster
 *   - Premium / Discount zones: only buy cheap, only sell expensive
 *
 * These are fundamentally different from lagging indicators because they
 * identify WHERE institutional orders are likely resting, not what
 * already happened.
 */

// ── Swing structure ───────────────────────────────────────────────────────────
export function findSwings(candles, strength = 3) {
  const highs = [];
  const lows  = [];

  for (let i = strength; i < candles.length - strength; i++) {
    const window = candles.slice(i - strength, i + strength + 1);
    const h = candles[i].high;
    const l = candles[i].low;

    if (h >= Math.max(...window.map(c => c.high)))
      highs.push({ price: h, index: i, time: candles[i].time, type: 'swing_high' });
    if (l <= Math.min(...window.map(c => c.low)))
      lows.push({ price: l, index: i, time: candles[i].time, type: 'swing_low' });
  }

  return { highs, lows };
}

// ── Break of Structure ────────────────────────────────────────────────────────
/**
 * BOS: price breaks above the most recent swing high (bullish) or below swing low (bearish)
 * CHoCH: after a downtrend, price breaks above a swing high for the first time = potential reversal
 */
export function detectStructure(candles, lookback = 50) {
  const slice = candles.slice(-lookback);
  const { highs, lows } = findSwings(slice, 3);

  if (!highs.length || !lows.length) return null;

  const last = slice[slice.length - 1];
  const recentHigh = highs[highs.length - 1];
  const recentLow  = lows[lows.length - 1];
  const prevHigh   = highs[highs.length - 2];
  const prevLow    = lows[lows.length - 2];

  let structure = null;

  // Bullish BOS: close above most recent swing high
  if (last.close > recentHigh?.price && recentHigh) {
    const type = (prevHigh && recentHigh.price > prevHigh.price) ? 'BOS_BULLISH' : 'CHOCH_BULLISH';
    structure = { type, level: recentHigh.price, bar: slice.length - 1 };
  }

  // Bearish BOS: close below most recent swing low
  if (last.close < recentLow?.price && recentLow) {
    const type = (prevLow && recentLow.price < prevLow.price) ? 'BOS_BEARISH' : 'CHOCH_BEARISH';
    structure = { type, level: recentLow.price, bar: slice.length - 1 };
  }

  return structure;
}

// ── Order Blocks ──────────────────────────────────────────────────────────────
/**
 * Bullish OB: the last BEARISH candle before a strong bullish move
 * Bearish OB: the last BULLISH candle before a strong bearish move
 *
 * Price returning to an OB = high-probability entry zone
 */
export function findOrderBlocks(candles, lookback = 80) {
  const slice = candles.slice(-lookback);
  const obs   = [];

  for (let i = 2; i < slice.length - 2; i++) {
    const cur  = slice[i];
    const next = slice[i + 1];
    const nn   = slice[i + 2];
    if (!nn) continue;

    // Bullish OB: bearish candle followed by strong bull move
    const isBearish = cur.close < cur.open;
    const bullMove  = next.close > next.open && nn.close > nn.open;
    const displacement = (next.high - cur.low) / cur.low;

    if (isBearish && bullMove && displacement > 0.0005) {
      obs.push({
        type:   'bullish',
        top:    Math.max(cur.open, cur.close),
        bottom: Math.min(cur.open, cur.close),
        high:   cur.high,
        low:    cur.low,
        index:  i,
        time:   cur.time,
        fresh:  true,
        displacement,
      });
    }

    // Bearish OB: bullish candle followed by strong bear move
    const isBullish = cur.close > cur.open;
    const bearMove  = next.close < next.open && nn.close < nn.open;
    const bearDisp  = (cur.high - next.low) / cur.high;

    if (isBullish && bearMove && bearDisp > 0.0005) {
      obs.push({
        type:   'bearish',
        top:    Math.max(cur.open, cur.close),
        bottom: Math.min(cur.open, cur.close),
        high:   cur.high,
        low:    cur.low,
        index:  i,
        time:   cur.time,
        fresh:  true,
        displacement: bearDisp,
      });
    }
  }

  // Mark mitigated OBs (price has already returned and passed through them)
  const lastClose = slice[slice.length - 1].close;
  for (const ob of obs) {
    if (ob.type === 'bullish' && lastClose < ob.bottom) ob.fresh = false;
    if (ob.type === 'bearish' && lastClose > ob.top)    ob.fresh = false;
  }

  return obs.filter(ob => ob.fresh);
}

// ── Fair Value Gaps ───────────────────────────────────────────────────────────
/**
 * FVG: a 3-candle pattern where candle 3's low is above candle 1's high (bullish)
 * or candle 3's high is below candle 1's low (bearish).
 * Represents an imbalance — price tends to return to fill it.
 */
export function findFVGs(candles, lookback = 60) {
  const slice = candles.slice(-lookback);
  const fvgs  = [];

  for (let i = 0; i < slice.length - 2; i++) {
    const c1 = slice[i];
    const c3 = slice[i + 2];

    // Bullish FVG: c3.low > c1.high
    if (c3.low > c1.high) {
      const size = c3.low - c1.high;
      if (size > 0) fvgs.push({
        type:   'bullish',
        top:    c3.low,
        bottom: c1.high,
        mid:    (c3.low + c1.high) / 2,
        size,
        index:  i + 1,
        time:   slice[i + 1].time,
        filled: false,
      });
    }

    // Bearish FVG: c3.high < c1.low
    if (c3.high < c1.low) {
      const size = c1.low - c3.high;
      if (size > 0) fvgs.push({
        type:   'bearish',
        top:    c1.low,
        bottom: c3.high,
        mid:    (c1.low + c3.high) / 2,
        size,
        index:  i + 1,
        time:   slice[i + 1].time,
        filled: false,
      });
    }
  }

  // Mark filled FVGs
  const lastHigh  = candles[candles.length - 1].high;
  const lastLow   = candles[candles.length - 1].low;
  for (const fvg of fvgs) {
    if (fvg.type === 'bullish' && lastLow <= fvg.mid)    fvg.filled = true;
    if (fvg.type === 'bearish' && lastHigh >= fvg.mid)   fvg.filled = true;
  }

  return fvgs.filter(f => !f.filled).slice(-8);  // keep most recent unfilled
}

// ── Liquidity Pools ───────────────────────────────────────────────────────────
/**
 * Equal highs / equal lows = stop-loss clusters = liquidity.
 * Price is often driven to these levels before reversing.
 * Don't enter INTO a liquidity pool — wait for price to sweep it and reverse.
 */
export function findLiquidityPools(candles, lookback = 80, tolerance = 0.0003) {
  const slice  = candles.slice(-lookback);
  const highs  = slice.map((c, i) => ({ price: c.high, index: i }));
  const lows   = slice.map((c, i) => ({ price: c.low,  index: i }));
  const pools  = [];

  // Group equal highs
  for (let i = 0; i < highs.length - 1; i++) {
    const cluster = [highs[i]];
    for (let j = i + 1; j < highs.length; j++) {
      if (Math.abs(highs[j].price - highs[i].price) / highs[i].price < tolerance)
        cluster.push(highs[j]);
    }
    if (cluster.length >= 2)
      pools.push({ type: 'buyside',  price: highs[i].price, count: cluster.length, swept: false });
  }

  // Group equal lows
  for (let i = 0; i < lows.length - 1; i++) {
    const cluster = [lows[i]];
    for (let j = i + 1; j < lows.length; j++) {
      if (Math.abs(lows[j].price - lows[i].price) / lows[i].price < tolerance)
        cluster.push(lows[j]);
    }
    if (cluster.length >= 2)
      pools.push({ type: 'sellside', price: lows[i].price, count: cluster.length, swept: false });
  }

  // Mark swept pools
  const last = candles[candles.length - 1];
  for (const p of pools) {
    if (p.type === 'buyside'  && last.high > p.price) p.swept = true;
    if (p.type === 'sellside' && last.low  < p.price) p.swept = true;
  }

  return pools.filter(p => !p.swept);
}

// ── Premium / Discount zones ──────────────────────────────────────────────────
/**
 * The range between the most recent swing high and swing low.
 * Above 50% (equilibrium) = Premium zone — only SELL here.
 * Below 50% = Discount zone — only BUY here.
 * This filters out entries that go against the smart money principle.
 */
export function getPremiumDiscount(candles, lookback = 50) {
  const { highs, lows } = findSwings(candles.slice(-lookback), 3);
  if (!highs.length || !lows.length) return null;

  const swingHigh = Math.max(...highs.map(h => h.price));
  const swingLow  = Math.min(...lows.map(l => l.price));
  const range     = swingHigh - swingLow;
  const midpoint  = swingLow + range / 2;
  const last      = candles[candles.length - 1].close;
  const zone      = last > midpoint ? 'premium' : 'discount';
  const pct       = (last - swingLow) / range;

  return { swingHigh, swingLow, midpoint, zone, pct: +pct.toFixed(3) };
}

// ── Full SMC Signal ───────────────────────────────────────────────────────────
/**
 * Generate an SMC-based signal combining:
 * - BOS/CHoCH for direction bias
 * - OB or FVG for entry zone
 * - Premium/discount filter
 * - Liquidity context
 */
export function smcSignal(instrument, candles, atr) {
  if (candles.length < 80) return null;

  const pd      = getPremiumDiscount(candles, 80);
  const obs     = findOrderBlocks(candles, 80);
  const fvgs    = findFVGs(candles, 60);
  const struct  = detectStructure(candles, 60);
  const pools   = findLiquidityPools(candles, 80);
  const last    = candles[candles.length - 1];
  const price   = last.close;

  if (!pd || !struct) return null;

  // Direction from structure
  const bullBias = struct.type.includes('BULLISH');
  const bearBias = struct.type.includes('BEARISH');
  if (!bullBias && !bearBias) return null;

  // Premium/discount alignment
  if (bullBias && pd.zone === 'premium' && pd.pct > 0.65) return null;  // don't buy expensive
  if (bearBias && pd.zone === 'discount' && pd.pct < 0.35) return null; // don't sell cheap

  // Find nearest relevant OB or FVG for entry
  let entryZone = null;
  let entryType = '';

  if (bullBias) {
    // Look for bullish OB or FVG below current price (wait for retracement)
    const bullOBs = obs.filter(o => o.type === 'bullish' && o.top < price && o.top > price - atr * 2)
                       .sort((a, b) => b.top - a.top);
    const bullFVGs = fvgs.filter(f => f.type === 'bullish' && f.top < price && f.top > price - atr * 2)
                        .sort((a, b) => b.top - a.top);

    if (bullOBs.length) { entryZone = bullOBs[0]; entryType = 'OB'; }
    else if (bullFVGs.length) { entryZone = bullFVGs[0]; entryType = 'FVG'; }
  }

  if (bearBias) {
    const bearOBs = obs.filter(o => o.type === 'bearish' && o.bottom > price && o.bottom < price + atr * 2)
                       .sort((a, b) => a.bottom - b.bottom);
    const bearFVGs = fvgs.filter(f => f.type === 'bearish' && f.bottom > price && f.bottom < price + atr * 2)
                        .sort((a, b) => a.bottom - b.bottom);

    if (bearOBs.length) { entryZone = bearOBs[0]; entryType = 'OB'; }
    else if (bearFVGs.length) { entryZone = bearFVGs[0]; entryType = 'FVG'; }
  }

  if (!entryZone) return null;

  const direction = bullBias ? 'LONG' : 'SHORT';
  const entryPrice = direction === 'LONG'
    ? (entryZone.top + entryZone.bottom) / 2      // mid of OB/FVG
    : (entryZone.top + entryZone.bottom) / 2;

  const sl = direction === 'LONG'
    ? entryZone.low || entryZone.bottom - atr * 0.3   // below OB
    : entryZone.high || entryZone.top   + atr * 0.3;  // above OB

  const tp = direction === 'LONG'
    ? entryPrice + Math.abs(entryPrice - sl) * 3       // 3:1 target
    : entryPrice - Math.abs(sl - entryPrice) * 3;

  const risk   = Math.abs(entryPrice - sl);
  const reward = Math.abs(tp - entryPrice);
  const rr     = risk > 0 ? +(reward / risk).toFixed(2) : 0;
  if (rr < 2.0) return null;

  // Nearby liquidity that could stop us out
  const nearLiquidity = pools.filter(p => {
    if (direction === 'LONG'  && p.type === 'sellside' && p.price > sl && p.price < entryPrice) return true;
    if (direction === 'SHORT' && p.type === 'buyside'  && p.price < sl && p.price > entryPrice) return true;
    return false;
  });

  // Confidence factors
  let confidence = 68;
  if (struct.type.startsWith('BOS'))   confidence += 8;   // BOS > CHoCH
  if (entryType === 'OB')              confidence += 6;   // OB > FVG
  if (nearLiquidity.length === 0)      confidence += 5;   // clean path to TP
  if (pd.zone === 'discount' && direction === 'LONG')  confidence += 5;
  if (pd.zone === 'premium'  && direction === 'SHORT') confidence += 5;
  if (entryZone.displacement > 0.001)  confidence += 4;  // strong displacement = stronger OB

  return {
    instrument,
    direction,
    entry: +entryPrice.toFixed(5),
    entryLimit: +entryPrice.toFixed(5),   // limit order price
    sl:  +sl.toFixed(5),
    tp:  +tp.toFixed(5),
    rr,
    confidence: Math.min(confidence, 92),
    strategy: 'smc',
    entryType,
    structure: struct.type,
    pdZone:    pd.zone,
    pdPct:     pd.pct,
    reasoning: `${struct.type} | ${entryType} entry @ ${entryPrice.toFixed(5)} | ${pd.zone} zone (${(pd.pct*100).toFixed(0)}%) | R:R ${rr}`,
    smcContext: { obs: obs.length, fvgs: fvgs.length, pools: pools.length, nearLiquidity: nearLiquidity.length },
    limitOrder: true,  // flag for execution engine
  };
}
