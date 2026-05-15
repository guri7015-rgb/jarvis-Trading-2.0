// ── Core indicator library ────────────────────────────────────────────────────

export function ema(values, period) {
  const k = 2 / (period + 1);
  let prev = null;
  return values.map((v) => {
    if (prev === null) { prev = v; return v; }
    return (prev = v * k + prev * (1 - k));
  });
}

export function rsi(closes, period = 14) {
  const deltas = closes.slice(1).map((c, i) => c - closes[i]);
  let avgG = deltas.slice(0, period).filter((d) => d > 0).reduce((a, b) => a + b, 0) / period;
  let avgL = deltas.slice(0, period).filter((d) => d < 0).reduce((a, b) => a + Math.abs(b), 0) / period;
  const result = new Array(period).fill(null);
  result.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  for (let i = period; i < deltas.length; i++) {
    avgG = (avgG * (period - 1) + Math.max(deltas[i], 0))  / period;
    avgL = (avgL * (period - 1) + Math.max(-deltas[i], 0)) / period;
    result.push(avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL));
  }
  return result;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const emaF = ema(closes, fast);
  const emaS = ema(closes, slow);
  const line = emaF.map((v, i) => v - emaS[i]);
  const sig  = ema(line, signal);
  return { line, signal: sig, hist: line.map((v, i) => v - sig[i]) };
}

export function atr(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prev = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  });
  const result = [tr[0]];
  for (let i = 1; i < tr.length; i++)
    result.push((result[i - 1] * (period - 1) + tr[i]) / period);
  return result;
}

export function adx(candles, period = 14) {
  // Average Directional Index — measures trend strength regardless of direction
  const dmPlus  = [];
  const dmMinus = [];
  const trArr   = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i], prev = candles[i - 1];
    const upMove   = curr.high - prev.high;
    const downMove = prev.low  - curr.low;
    dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
    dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trArr.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
  }

  function wilder(arr, p) {
    let sum = arr.slice(0, p).reduce((a, b) => a + b, 0);
    const out = [sum];
    for (let i = p; i < arr.length; i++) out.push(out[out.length - 1] - out[out.length - 1] / p + arr[i]);
    return out;
  }

  const atrW  = wilder(trArr, period);
  const diP   = wilder(dmPlus, period).map((v, i) => atrW[i] ? 100 * v / atrW[i] : 0);
  const diM   = wilder(dmMinus, period).map((v, i) => atrW[i] ? 100 * v / atrW[i] : 0);
  const dx    = diP.map((p, i) => diP[i] + diM[i] ? 100 * Math.abs(p - diM[i]) / (p + diM[i]) : 0);

  const adxArr = wilder(dx, period);
  return { adx: adxArr, diPlus: diP, diMinus: diM };
}

export function bollingerBands(closes, period = 20, mult = 2) {
  return closes.slice(period - 1).map((_, i) => {
    const slice = closes.slice(i, i + period);
    const mean  = slice.reduce((a, b) => a + b, 0) / period;
    const sd    = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
    return { mid: mean, upper: mean + mult * sd, lower: mean - mult * sd, sd };
  });
}

export function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const kArr = candles.slice(kPeriod - 1).map((_, i) => {
    const slice = candles.slice(i, i + kPeriod);
    const high  = Math.max(...slice.map((c) => c.high));
    const low   = Math.min(...slice.map((c) => c.low));
    return high === low ? 50 : 100 * (candles[i + kPeriod - 1].close - low) / (high - low);
  });
  const dArr = kArr.slice(dPeriod - 1).map((_, i) =>
    kArr.slice(i, i + dPeriod).reduce((a, b) => a + b, 0) / dPeriod
  );
  return { k: kArr, d: dArr };
}

// ── Divergence detection ──────────────────────────────────────────────────────
export function detectRSIDivergence(candles, rsiArr, lookback = 5) {
  const n = candles.length - 1;
  if (n < lookback + 2) return null;

  const recentCandles = candles.slice(n - lookback, n + 1);
  const recentRSI     = rsiArr.slice(n - lookback, n + 1).filter(Boolean);
  if (recentRSI.length < lookback) return null;

  const priceHigh = Math.max(...recentCandles.map((c) => c.high));
  const priceLow  = Math.min(...recentCandles.map((c) => c.low));
  const rsiHigh   = Math.max(...recentRSI);
  const rsiLow    = Math.min(...recentRSI);

  const lastPrice = candles[n].close;
  const lastRSI   = rsiArr[n];
  if (!lastRSI) return null;

  // Bearish divergence: price makes higher high but RSI makes lower high
  if (lastPrice >= priceHigh * 0.999 && lastRSI < rsiHigh - 3)
    return { type: "bearish", strength: rsiHigh - lastRSI };

  // Bullish divergence: price makes lower low but RSI makes higher low
  if (lastPrice <= priceLow * 1.001 && lastRSI > rsiLow + 3)
    return { type: "bullish", strength: lastRSI - rsiLow };

  return null;
}

// ── Support / Resistance via swing highs/lows ─────────────────────────────────
export function findKeyLevels(candles, lookback = 50, pivotStrength = 3) {
  const levels = [];
  const slice  = candles.slice(-lookback);

  for (let i = pivotStrength; i < slice.length - pivotStrength; i++) {
    const window = slice.slice(i - pivotStrength, i + pivotStrength + 1);
    const high   = slice[i].high;
    const low    = slice[i].low;

    if (high === Math.max(...window.map((c) => c.high)))
      levels.push({ price: high, type: "resistance" });
    if (low === Math.min(...window.map((c) => c.low)))
      levels.push({ price: low, type: "support" });
  }

  return levels;
}

// ── All-in-one enrichment ─────────────────────────────────────────────────────
export function enrich(candles) {
  const closes = candles.map((c) => c.close);
  const ema20  = ema(closes, 20);
  const ema50  = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const rsi14  = rsi(closes, 14);
  const { line: macdL, signal: macdS, hist: macdH } = macd(closes);
  const atr14  = atr(candles, 14);
  const { adx: adxArr, diPlus, diMinus } = adx(candles, 14);
  const volMa  = closes.map((_, i) => i < 19 ? null : candles.slice(i - 19, i + 1).reduce((a, c) => a + c.volume, 0) / 20);

  return candles.map((c, i) => ({
    ...c,
    ema20:     ema20[i],
    ema50:     ema50[i],
    ema200:    ema200[i],
    rsi:       rsi14[i],
    macdLine:  macdL[i],
    macdSig:   macdS[i],
    macdHist:  macdH[i],
    atr:       atr14[i],
    adx:       adxArr[i - 1] ?? null,
    diPlus:    diPlus[i - 1] ?? null,
    diMinus:   diMinus[i - 1] ?? null,
    volMa:     volMa[i],
  }));
}
