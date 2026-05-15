/**
 * Binance Futures (USDT-margined perpetuals) connector.
 * Drop-in equivalent of oanda.js but for crypto.
 *
 * Public endpoints  → no auth
 * Private endpoints → HMAC-SHA256 signed with API key + secret
 */
import https  from 'https';
import crypto from 'crypto';
import { BINANCE_KEY, BINANCE_SECRET, BINANCE_TESTNET } from './config.js';

const HOST = BINANCE_TESTNET ? 'testnet.binancefutures.com' : 'fapi.binance.com';

// Granularity map: JARVIS format → Binance interval
const INTERVAL = { D: '1d', H4: '4h', H1: '1h', M15: '15m', M5: '5m' };

// Quantity decimal precision per symbol (Binance step sizes)
export const CRYPTO_QTY_DEC = {
  BTCUSDT: 3, ETHUSDT: 3, SOLUSDT: 1, BNBUSDT: 2,
  XRPUSDT: 0, ADAUSDT: 0, DOGEUSDT: 0,
};

// Price decimal precision per symbol
export const CRYPTO_PRICE_DEC = {
  BTCUSDT: 1, ETHUSDT: 2, SOLUSDT: 3, BNBUSDT: 3,
  XRPUSDT: 4, ADAUSDT: 5, DOGEUSDT: 6,
};

// ── Request engine ────────────────────────────────────────────────────────────
function sign(params) {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now() }).toString();
  const sig = crypto.createHmac('sha256', BINANCE_SECRET).update(qs).digest('hex');
  return `${qs}&signature=${sig}`;
}

function request(method, path, params = {}, auth = false, ms = 15_000) {
  return new Promise((resolve, reject) => {
    let fullPath = path;
    let body = '';

    if (auth) {
      const signed = sign(params);
      if (method === 'GET' || method === 'DELETE') fullPath = `${path}?${signed}`;
      else body = signed;
    } else {
      const qs = new URLSearchParams(params).toString();
      if (qs) fullPath = `${path}?${qs}`;
    }

    const req = https.request({
      hostname: HOST, path: fullPath, method,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(auth ? { 'X-MBX-APIKEY': BINANCE_KEY } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400)
            reject(new Error(`Binance ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
          else resolve(parsed);
        } catch(e) { reject(new Error(`Binance parse error: ${data.slice(0, 200)}`)); }
      });
    });

    req.setTimeout(ms, () => { req.destroy(); reject(new Error(`Binance timeout: ${method} ${path}`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Candles ───────────────────────────────────────────────────────────────────
export async function getCryptoCandles(symbol, granularity = 'H1', count = 150) {
  const interval = INTERVAL[granularity] || '1h';
  const data = await request('GET', '/fapi/v1/klines', { symbol, interval, limit: Math.min(count + 1, 1500) });
  return data.slice(0, -1).map(k => ({   // drop the still-open last candle
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

// ── Pricing ───────────────────────────────────────────────────────────────────
export async function getCryptoPrices(symbols) {
  const map = {};
  await Promise.allSettled(symbols.map(async symbol => {
    try {
      const t   = await request('GET', '/fapi/v1/ticker/bookTicker', { symbol });
      const bid = parseFloat(t.bidPrice);
      const ask = parseFloat(t.askPrice);
      map[symbol] = { bid, ask, mid: (bid + ask) / 2, spread: ask - bid };
    } catch {}
  }));
  return map;
}

// ── Account ───────────────────────────────────────────────────────────────────
export async function getCryptoAccount() {
  const data = await request('GET', '/fapi/v2/account', {}, true);
  const balance      = parseFloat(data.totalWalletBalance   || 0);
  const unrealizedPL = parseFloat(data.totalUnrealizedProfit || 0);
  return {
    balance,
    currency:     'USDT',
    nav:          balance + unrealizedPL,
    unrealizedPL,
    marginUsed:   parseFloat(data.totalInitialMargin || 0),
    openTrades:   (data.positions || []).filter(p => parseFloat(p.positionAmt) !== 0).length,
  };
}

// ── Positions ─────────────────────────────────────────────────────────────────
export async function getCryptoPositions() {
  const data = await request('GET', '/fapi/v2/positionRisk', {}, true);
  return data
    .filter(p => parseFloat(p.positionAmt) !== 0)
    .map(p => {
      const units = parseFloat(p.positionAmt);
      return {
        id:           `${p.symbol}_${p.updateTime}`,
        instrument:   p.symbol,
        units,
        direction:    units > 0 ? 'LONG' : 'SHORT',
        openPrice:    parseFloat(p.entryPrice),
        unrealizedPL: parseFloat(p.unRealizedProfit),
        sl:   null,
        tp:   null,
        openTime:     new Date(parseInt(p.updateTime)).toISOString(),
        clientComment: '',
        market:       'crypto',
      };
    });
}

// ── Orders ────────────────────────────────────────────────────────────────────
export async function setLeverage(symbol, leverage = 5) {
  try { return await request('POST', '/fapi/v1/leverage', { symbol, leverage }, true); }
  catch { /* fine if already set or testnet doesn't support */ }
}

export async function placeCryptoOrder(symbol, direction, quantity, sl, tp, comment = '') {
  const side   = direction === 'LONG' ? 'BUY' : 'SELL';
  const slSide = direction === 'LONG' ? 'SELL' : 'BUY';
  const qDec   = CRYPTO_QTY_DEC[symbol]  ?? 3;
  const pDec   = CRYPTO_PRICE_DEC[symbol] ?? 2;
  const qty    = Math.abs(quantity).toFixed(qDec);

  // Market entry
  const orderResult = await request('POST', '/fapi/v1/order', {
    symbol, side, type: 'MARKET', quantity: qty,
    newClientOrderId: comment.slice(0, 36).replace(/\W/g, '_'),
  }, true);

  // SL + TP as separate conditional orders
  await Promise.allSettled([
    sl ? request('POST', '/fapi/v1/order', {
      symbol, side: slSide, type: 'STOP_MARKET',
      stopPrice: sl.toFixed(pDec), closePosition: 'true',
    }, true) : Promise.resolve(),

    tp ? request('POST', '/fapi/v1/order', {
      symbol, side: slSide, type: 'TAKE_PROFIT_MARKET',
      stopPrice: tp.toFixed(pDec), closePosition: 'true',
    }, true) : Promise.resolve(),
  ]);

  return orderResult;
}

export async function closeCryptoPosition(symbol) {
  const positions = await getCryptoPositions();
  const pos = positions.find(p => p.instrument === symbol);
  if (!pos) return { ok: true, message: 'No position' };
  const side = pos.direction === 'LONG' ? 'SELL' : 'BUY';
  const qDec = CRYPTO_QTY_DEC[symbol] ?? 3;
  return request('POST', '/fapi/v1/order', {
    symbol, side, type: 'MARKET',
    quantity: Math.abs(pos.units).toFixed(qDec),
    reduceOnly: 'true',
  }, true);
}
