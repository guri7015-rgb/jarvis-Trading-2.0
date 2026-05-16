/**
 * Crypto Paper Trading Engine
 *
 * Real market data from Binance public API (no key needed).
 * Execution is simulated locally — tracks virtual positions + P&L.
 *
 * Drop-in replacement for binance.js for regions where exchanges
 * are restricted or for safe strategy testing.
 */
import https from 'https';

const BINANCE_PUBLIC = 'api.binance.com';

const INTERVAL = { D: '1d', H4: '4h', H1: '1h', M15: '15m', M5: '5m' };

export const CRYPTO_QTY_DEC = {
  BTCUSDT: 3, ETHUSDT: 3, SOLUSDT: 1, BNBUSDT: 2,
  XRPUSDT: 0, ADAUSDT: 0, DOGEUSDT: 0,
};

export const CRYPTO_PRICE_DEC = {
  BTCUSDT: 1, ETHUSDT: 2, SOLUSDT: 3, BNBUSDT: 3,
  XRPUSDT: 4, ADAUSDT: 5, DOGEUSDT: 6,
};

// ── Paper account state ───────────────────────────────────────────────────────
let _paperBalance   = 10_000;   // virtual USDT starting balance
let _paperPositions = new Map(); // symbol → position object
let _paperPnL       = 0;
let _tradeCount     = 0;

// ── Public HTTP ───────────────────────────────────────────────────────────────
function get(path, params = {}, ms = 15_000) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams(params).toString();
    const fullPath = qs ? `${path}?${qs}` : path;
    const req = https.get({ hostname: BINANCE_PUBLIC, path: fullPath,
      headers: { 'User-Agent': 'JARVIS-Trading/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(`Binance ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 200)}`));
          else resolve(parsed);
        } catch(e) { reject(new Error(`Parse error: ${data.slice(0, 100)}`)); }
      });
    });
    req.setTimeout(ms, () => { req.destroy(); reject(new Error(`Timeout: ${path}`)); });
    req.on('error', reject);
  });
}

// ── Candles (real data) ───────────────────────────────────────────────────────
export async function getCryptoCandles(symbol, granularity = 'H1', count = 150) {
  const interval = INTERVAL[granularity] || '1h';
  const data = await get('/api/v3/klines', { symbol, interval, limit: Math.min(count + 1, 1000) });
  return data.slice(0, -1).map(k => ({
    time:   k[0],
    open:   parseFloat(k[1]),
    high:   parseFloat(k[2]),
    low:    parseFloat(k[3]),
    close:  parseFloat(k[4]),
    volume: parseFloat(k[5]),
    bid: null, ask: null, spread: null,
  })).slice(-count);
}

export async function getMultiCryptoCandles(symbols, granularity, count) {
  const results = await Promise.allSettled(
    symbols.map(s => getCryptoCandles(s, granularity, count).then(c => [s, c]))
  );
  const map = {};
  for (const r of results) if (r.status === 'fulfilled') map[r.value[0]] = r.value[1];
  return map;
}

// ── Prices (real data) ────────────────────────────────────────────────────────
export async function getCryptoPrices(symbols) {
  const map = {};
  await Promise.allSettled(symbols.map(async symbol => {
    try {
      const t   = await get('/api/v3/ticker/bookTicker', { symbol });
      const bid = parseFloat(t.bidPrice);
      const ask = parseFloat(t.askPrice);
      map[symbol] = { bid, ask, mid: (bid + ask) / 2, spread: ask - bid };
    } catch {}
  }));
  return map;
}

// ── Paper account ─────────────────────────────────────────────────────────────
export async function getCryptoAccount() {
  // Compute live unrealized P&L from current prices
  let unrealizedPL = 0;
  if (_paperPositions.size > 0) {
    try {
      const symbols = [..._paperPositions.keys()];
      const prices  = await getCryptoPrices(symbols);
      for (const [sym, pos] of _paperPositions) {
        const mid = prices[sym]?.mid;
        if (!mid) continue;
        const pnl = pos.direction === 'LONG'
          ? (mid - pos.openPrice) * pos.units
          : (pos.openPrice - mid) * Math.abs(pos.units);
        unrealizedPL += pnl;
        pos.unrealizedPL = +pnl.toFixed(2);
      }
    } catch {}
  }
  return {
    balance:      _paperBalance,
    currency:     'USDT',
    nav:          _paperBalance + unrealizedPL,
    unrealizedPL: +unrealizedPL.toFixed(2),
    marginUsed:   0,
    openTrades:   _paperPositions.size,
    paper:        true,
  };
}

// ── Paper positions ───────────────────────────────────────────────────────────
export async function getCryptoPositions() {
  // Refresh unrealized P&L
  await getCryptoAccount().catch(() => {});
  return [..._paperPositions.values()];
}

// ── Paper order execution ─────────────────────────────────────────────────────
export async function placeCryptoOrder(symbol, direction, quantity, sl, tp, comment = '') {
  // Get real current price
  const prices = await getCryptoPrices([symbol]);
  const price  = prices[symbol];
  if (!price) throw new Error(`No price for ${symbol}`);

  const fillPrice = direction === 'LONG' ? price.ask : price.bid;
  const units     = Math.abs(quantity);
  const tradeId   = `PAPER_${symbol}_${Date.now()}`;

  _paperPositions.set(symbol, {
    id:            tradeId,
    instrument:    symbol,
    units:         direction === 'LONG' ? units : -units,
    direction,
    openPrice:     fillPrice,
    unrealizedPL:  0,
    sl:            sl || null,
    tp:            tp || null,
    openTime:      new Date().toISOString(),
    clientComment: comment.slice(0, 128),
    market:        'crypto',
    paper:         true,
  });

  _tradeCount++;
  process.stdout.write(`[PAPER CRYPTO] ${direction} ${units} ${symbol} @ ${fillPrice} | SL:${sl?.toFixed(2)} TP:${tp?.toFixed(2)}\n`);

  return { orderId: tradeId, paper: true, fillPrice, symbol, direction, qty: units };
}

export async function closeCryptoPosition(symbol) {
  const pos = _paperPositions.get(symbol);
  if (!pos) return { ok: true, message: 'No position' };

  // Get closing price
  try {
    const prices = await getCryptoPrices([symbol]);
    const price  = prices[symbol];
    if (price) {
      const closePrice = pos.direction === 'LONG' ? price.bid : price.ask;
      const pnl = pos.direction === 'LONG'
        ? (closePrice - pos.openPrice) * Math.abs(pos.units)
        : (pos.openPrice - closePrice) * Math.abs(pos.units);
      _paperBalance += pnl;
      _paperPnL     += pnl;
      process.stdout.write(`[PAPER CRYPTO] Closed ${symbol} @ ${closePrice} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`);
    }
  } catch {}

  _paperPositions.delete(symbol);
  return { ok: true, paper: true };
}

// SL/TP hit checker — called periodically to simulate broker order fills
export async function checkPaperSLTP() {
  if (_paperPositions.size === 0) return;
  const symbols = [..._paperPositions.keys()];
  let prices;
  try { prices = await getCryptoPrices(symbols); } catch { return; }

  for (const [sym, pos] of _paperPositions) {
    const mid = prices[sym]?.mid;
    if (!mid) continue;

    let hit = null;
    if (pos.sl && pos.direction === 'LONG'  && mid <= pos.sl) hit = 'SL';
    if (pos.sl && pos.direction === 'SHORT' && mid >= pos.sl) hit = 'SL';
    if (pos.tp && pos.direction === 'LONG'  && mid >= pos.tp) hit = 'TP';
    if (pos.tp && pos.direction === 'SHORT' && mid <= pos.tp) hit = 'TP';

    if (hit) {
      const closePrice = hit === 'SL' ? pos.sl : pos.tp;
      const pnl = pos.direction === 'LONG'
        ? (closePrice - pos.openPrice) * Math.abs(pos.units)
        : (pos.openPrice - closePrice) * Math.abs(pos.units);
      _paperBalance += pnl;
      _paperPnL     += pnl;
      process.stdout.write(`[PAPER CRYPTO] ${hit} hit on ${sym} @ ${closePrice} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`);
      _paperPositions.delete(sym);
    }
  }
}

export async function setLeverage() {} // no-op for paper trading
export function getPaperStats() {
  return { balance: _paperBalance, totalPnL: _paperPnL, trades: _tradeCount, positions: _paperPositions.size };
}
