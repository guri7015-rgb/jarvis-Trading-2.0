/**
 * Crypto Paper Trading Engine
 *
 * Candle data fetched from multiple providers with automatic fallback:
 *   1. Bybit  (api.bybit.com)
 *   2. OKX    (www.okx.com)
 *   3. Kraken (api.kraken.com)
 * Execution is simulated locally — tracks virtual positions + P&L.
 */
import https from 'https';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dir  = dirname(fileURLToPath(import.meta.url));
const DATA_DIR   = resolve(__dir, '../data');
const STATE_FILE = resolve(DATA_DIR, 'paper-state.json');

function _saveState() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({
      balance:      _paperBalance,
      pnl:          _paperPnL,
      trades:       _tradeCount,
      positions:    [..._paperPositions.entries()],
      closedTrades: _closedTrades.slice(0, 200),
      savedAt:      new Date().toISOString(),
    }, null, 2));
  } catch(e) { process.stdout.write(`[PAPER] State save failed: ${e.message}\n`); }
}

function _loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const d = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    _paperBalance   = d.balance      ?? 10_000;
    _paperPnL       = d.pnl          ?? 0;
    _tradeCount     = d.trades       ?? 0;
    _paperPositions = new Map(d.positions || []);
    _closedTrades   = d.closedTrades || [];
    process.stdout.write(`[PAPER] Restored state: $${_paperBalance.toFixed(2)}, ${_paperPositions.size} open, ${_closedTrades.length} closed\n`);
  } catch(e) { process.stdout.write(`[PAPER] State load failed: ${e.message}\n`); }
}

export const CRYPTO_QTY_DEC = {
  BTCUSDT: 3, ETHUSDT: 3, SOLUSDT: 1, BNBUSDT: 2,
  XRPUSDT: 0, ADAUSDT: 0, DOGEUSDT: 0,
};

export const CRYPTO_PRICE_DEC = {
  BTCUSDT: 1, ETHUSDT: 2, SOLUSDT: 3, BNBUSDT: 3,
  XRPUSDT: 4, ADAUSDT: 5, DOGEUSDT: 6,
};

// ── Paper account state ───────────────────────────────────────────────────────
let _paperBalance   = 10_000;
let _paperPositions = new Map();
let _closedTrades   = [];
let _paperPnL       = 0;
let _tradeCount     = 0;
_loadState(); // restore from disk on startup

// ── Generic HTTPS GET ─────────────────────────────────────────────────────────
function httpsGet(hostname, path, ms = 20_000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname, path, headers: { 'User-Agent': 'JARVIS-Trading/2.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { reject(new Error(`Parse error: ${data.slice(0, 80)}`)); }
      });
    });
    req.setTimeout(ms, () => { req.destroy(); reject(new Error(`Timeout ${hostname}`)); });
    req.on('error', reject);
  });
}

// ── Provider implementations ──────────────────────────────────────────────────
const BYBIT_IV  = { D: 'D',   H4: '240', H1: '60', M15: '15', M5: '5'  };
const OKX_IV    = { D: '1D',  H4: '4H',  H1: '1H', M15: '15m', M5: '5m' };
const KRAKEN_IV = { D: '1440',H4: '240', H1: '60', M15: '15', M5: '5'  };
const KRAKEN_SYM = {
  BTCUSDT: 'XBTUSDT', ETHUSDT: 'ETHUSDT', SOLUSDT: 'SOLUSDT',
  BNBUSDT: 'BNBUSDT', XRPUSDT: 'XRPUSDT',
};
const OKX_SYM = {
  BTCUSDT: 'BTC-USDT-SWAP', ETHUSDT: 'ETH-USDT-SWAP', SOLUSDT: 'SOL-USDT-SWAP',
  BNBUSDT: 'BNB-USDT-SWAP', XRPUSDT: 'XRP-USDT-SWAP',
};

async function bybitCandles(symbol, granularity, count) {
  const iv = BYBIT_IV[granularity] || '60';
  const qs = `category=linear&symbol=${symbol}&interval=${iv}&limit=${Math.min(count + 1, 1000)}`;
  const { status, body } = await httpsGet('api.bybit.com', `/v5/market/kline?${qs}`);
  if (body.retCode !== 0) throw new Error(`Bybit ${body.retCode}: ${body.retMsg}`);
  return (body.result.list || []).reverse().slice(0, -1).map(k => ({
    time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  })).slice(-count);
}

async function okxCandles(symbol, granularity, count) {
  const bar = OKX_IV[granularity] || '1H';
  const inst = OKX_SYM[symbol] || `${symbol.replace('USDT','-USDT-SWAP')}`;
  const qs = `instId=${inst}&bar=${bar}&limit=${Math.min(count + 1, 300)}`;
  const { status, body } = await httpsGet('www.okx.com', `/api/v5/market/candles?${qs}`);
  if (body.code !== '0') throw new Error(`OKX ${body.code}: ${body.msg}`);
  return (body.data || []).reverse().slice(0, -1).map(k => ({
    time: +k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5],
  })).slice(-count);
}

async function krakenCandles(symbol, granularity, count) {
  const interval = KRAKEN_IV[granularity] || '60';
  const pair = KRAKEN_SYM[symbol] || symbol;
  const qs = `pair=${pair}&interval=${interval}`;
  const { status, body } = await httpsGet('api.kraken.com', `/0/public/OHLC?${qs}`);
  if (body.error?.length) throw new Error(`Kraken: ${body.error[0]}`);
  const key = Object.keys(body.result).find(k => k !== 'last');
  const rows = body.result[key] || [];
  return rows.slice(-count).map(k => ({
    time: k[0] * 1000, open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[6],
  }));
}

let _workingProvider = null;  // cache which provider works

async function fetchCandlesWithFallback(symbol, granularity, count) {
  const providers = [
    { name: 'bybit',  fn: bybitCandles  },
    { name: 'okx',    fn: okxCandles    },
    { name: 'kraken', fn: krakenCandles },
  ];
  // Try cached provider first
  if (_workingProvider) {
    const p = providers.find(p => p.name === _workingProvider);
    if (p) {
      try { return await p.fn(symbol, granularity, count); } catch {}
    }
  }
  // Try all in order
  for (const p of providers) {
    try {
      const candles = await p.fn(symbol, granularity, count);
      if (candles.length > 0) {
        if (_workingProvider !== p.name) {
          _workingProvider = p.name;
          process.stdout.write(`[CRYPTO DATA] Using provider: ${p.name}\n`);
        }
        return candles;
      }
    } catch(e) {
      process.stdout.write(`[CRYPTO DATA] ${p.name} failed for ${symbol}: ${e.message}\n`);
    }
  }
  return [];
}

// ── Candles ───────────────────────────────────────────────────────────────────
export async function getCryptoCandles(symbol, granularity = 'H1', count = 150) {
  return fetchCandlesWithFallback(symbol, granularity, count);
}

export async function getMultiCryptoCandles(symbols, granularity, count) {
  const results = await Promise.allSettled(
    symbols.map(s => getCryptoCandles(s, granularity, count).then(c => [s, c]))
  );
  const map = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value[1].length > 0)
      map[r.value[0]] = r.value[1];
    else if (r.status === 'rejected')
      process.stdout.write(`[CRYPTO DATA] ${granularity} fetch rejected: ${r.reason?.message}\n`);
  }
  return map;
}

// ── Prices ────────────────────────────────────────────────────────────────────
export async function getCryptoPrices(symbols) {
  const map = {};
  await Promise.allSettled(symbols.map(async symbol => {
    try {
      // Try Bybit first, fall back to last candle close from any provider
      let bid, ask;
      try {
        const qs = `category=linear&symbol=${symbol}`;
        const { body } = await httpsGet('api.bybit.com', `/v5/market/tickers?${qs}`);
        const t = body.result?.list?.[0];
        if (t) { bid = +t.bid1Price; ask = +t.ask1Price; }
      } catch {}
      if (!bid) {
        // OKX fallback
        const inst = OKX_SYM[symbol] || symbol;
        const { body } = await httpsGet('www.okx.com', `/api/v5/market/ticker?instId=${inst}`);
        const t = body.data?.[0];
        if (t) { bid = +t.bidPx; ask = +t.askPx; }
      }
      if (bid && ask) map[symbol] = { bid, ask, mid: (bid + ask) / 2, spread: ask - bid };
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
  _saveState();

  return { orderId: tradeId, paper: true, fillPrice, symbol, direction, qty: units };
}

export async function closeCryptoPosition(symbol) {
  const pos = _paperPositions.get(symbol);
  if (!pos) return { ok: true, message: 'No position' };

  let closePrice = pos.openPrice;
  let pnl = 0;
  try {
    const prices = await getCryptoPrices([symbol]);
    const price  = prices[symbol];
    if (price) {
      closePrice = pos.direction === 'LONG' ? price.bid : price.ask;
      pnl = pos.direction === 'LONG'
        ? (closePrice - pos.openPrice) * Math.abs(pos.units)
        : (pos.openPrice - closePrice) * Math.abs(pos.units);
      _paperBalance += pnl;
      _paperPnL     += pnl;
      process.stdout.write(`[PAPER CRYPTO] Closed ${symbol} @ ${closePrice} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}\n`);
    }
  } catch {}

  _closedTrades.unshift({
    id: pos.id, instrument: symbol, direction: pos.direction,
    units: Math.abs(pos.units), openPrice: pos.openPrice, closePrice,
    realizedPL: +pnl.toFixed(2), openTime: pos.openTime,
    closeTime: new Date().toISOString(), closeReason: 'manual',
    sl: pos.sl, tp: pos.tp, clientComment: pos.clientComment || '',
    market: 'crypto', paper: true,
  });
  if (_closedTrades.length > 200) _closedTrades.pop();

  _paperPositions.delete(symbol);
  _saveState();
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

      _closedTrades.unshift({
        id: pos.id, instrument: sym, direction: pos.direction,
        units: Math.abs(pos.units), openPrice: pos.openPrice, closePrice,
        realizedPL: +pnl.toFixed(2), openTime: pos.openTime,
        closeTime: new Date().toISOString(), closeReason: hit,
        sl: pos.sl, tp: pos.tp, clientComment: pos.clientComment || '',
        market: 'crypto', paper: true,
      });
      if (_closedTrades.length > 200) _closedTrades.pop();

      _paperPositions.delete(sym);
      _saveState();
    }
  }
}

export async function setLeverage() {} // no-op for paper trading
export function getPaperStats() {
  return { balance: _paperBalance, totalPnL: _paperPnL, trades: _tradeCount, positions: _paperPositions.size };
}
export function getClosedCryptoTrades(count = 50) {
  return _closedTrades.slice(0, count);
}
