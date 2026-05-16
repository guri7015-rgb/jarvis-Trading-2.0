/**
 * JARVIS Crypto Brain
 *
 * Same strategies as Forex (SMC, trend, mean reversion, breakout)
 * running on Binance Futures candle data. Key differences:
 *   - 24/7 market — no session gate
 *   - Position sizing in base currency (BTC, ETH, etc.)
 *   - Separate risk state from Forex
 *   - 5x leverage on perpetuals
 */
import { CRYPTO_INSTRUMENTS, CONFIG, READ_ONLY, DEMO_ENABLED } from './config.js';
import { analyzeSignalWithClaude } from './news.js';
import {
  getMultiCryptoCandles, getCryptoPrices, getCryptoAccount,
  getCryptoPositions, placeCryptoOrder, setLeverage, CRYPTO_QTY_DEC,
  checkPaperSLTP,
} from './cryptoPaper.js';
import { enrich }                              from './indicators.js';
import { trendFollow, meanReversion, breakout } from './strategies/index.js';
import { smcSignal }                            from './strategies/smc.js';
import { classifyRegime }                       from './sessions.js';
import { atrPercentile, getVolRegime } from './volatility.js';

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  lastScan:   null,
  scanning:   false,
  signals:    [],
  errors:     [],
  regime:     {},
  account:    null,
};

let _init          = false;
let _balance       = 10_000;
let _openCount     = 0;
let _openSymbols   = [];
let _tradesToday   = 0;
let _lastDate      = '';

function todayStr() { return new Date().toISOString().slice(0, 10); }

function resetDaily() {
  const t = todayStr();
  if (t !== _lastDate) { _lastDate = t; _tradesToday = 0; }
}

// ── Risk ──────────────────────────────────────────────────────────────────────
function canTrade(symbol) {
  resetDaily();
  if (_openCount >= CONFIG.cryptoMaxPositions)
    return { ok: false, reason: `Max crypto positions (${CONFIG.cryptoMaxPositions}) reached` };
  if (_tradesToday >= CONFIG.cryptoMaxDailyTrades)
    return { ok: false, reason: `Max daily crypto trades (${CONFIG.cryptoMaxDailyTrades}) reached` };
  if (_openSymbols.includes(symbol))
    return { ok: false, reason: `Already have a position in ${symbol}` };
  return { ok: true };
}

function calcUnits(symbol, entry, sl, h1) {
  const riskUSD = _balance * CONFIG.cryptoRiskPerTrade;
  const slDist  = Math.abs(entry - sl);
  if (slDist === 0) return 0;

  const atrPct = atrPercentile(h1, 100);
  const vol    = getVolRegime(atrPct);
  if (vol.skip) return 0;

  const rawUnits = (riskUSD * vol.sizeMult) / slDist;
  const step     = Math.pow(10, -(CRYPTO_QTY_DEC[symbol] ?? 3));
  return Math.max(Math.floor(rawUnits / step) * step, step);
}

// ── MTF confluence ────────────────────────────────────────────────────────────
function mtfConfluence(d1, h4, h1, direction) {
  let score = 0, total = 0;
  for (const tf of [d1, h4, h1]) {
    if (!tf || tf.length < 3) continue;
    total++;
    const last = tf[tf.length - 1], prev = tf[tf.length - 2];
    if ((last.close > prev.close ? 'LONG' : 'SHORT') === direction) score++;
  }
  return total > 0 ? score / total : 0.5;
}

// ── Scan ──────────────────────────────────────────────────────────────────────
export async function cryptoFullScan() {
  if (state.scanning) return { ok: false, message: 'Crypto scan already in progress' };

  state.scanning = true;
  const errors   = [];

  try {
    // Check if any paper SL/TP levels were hit since last scan
    await checkPaperSLTP().catch(() => {});

    // ── Init ──
    if (!_init) {
      try {
        const acct = await getCryptoAccount();
        _balance = acct.balance;
        await Promise.allSettled(CRYPTO_INSTRUMENTS.map(s => setLeverage(s, CONFIG.cryptoLeverage)));
        const open = await getCryptoPositions();
        for (const p of open) { _openCount++; _openSymbols.push(p.instrument); }
        if (open.length) process.stdout.write(`[CRYPTO] Reconciled ${open.length} open position(s)\n`);
      } catch(e) { process.stdout.write(`[CRYPTO] Init warning: ${e.message}\n`); }
      _init = true;
    }

    // ── Fetch 4 timeframes ──
    const [d1Map, h4Map, h1Map, m15Map] = await Promise.all([
      getMultiCryptoCandles(CRYPTO_INSTRUMENTS, 'D',   60),
      getMultiCryptoCandles(CRYPTO_INSTRUMENTS, 'H4',  Math.ceil(CONFIG.candleCount / 4)),
      getMultiCryptoCandles(CRYPTO_INSTRUMENTS, 'H1',  CONFIG.candleCount),
      getMultiCryptoCandles(CRYPTO_INSTRUMENTS, 'M15', 80),
    ]);

    const signals = [];
    const regimes = {};

    for (const symbol of CRYPTO_INSTRUMENTS) {
      const h1 = h1Map[symbol];
      if (!h1 || h1.length < 80) {
        errors.push({ instrument: symbol, reason: `Insufficient H1 candles (${h1?.length || 0})` });
        continue;
      }

      const eH1 = enrich(h1);
      const eH4 = h4Map[symbol] ? enrich(h4Map[symbol]) : null;
      const eD1 = d1Map[symbol] ? enrich(d1Map[symbol]) : null;

      const regime = classifyRegime(eH4 || eH1);
      regimes[symbol] = regime;

      // Crypto is 24/7 — run strategies directly (no forex regime/strength filter)
      const candidates = [];
      const _tf = trendFollow(symbol, eH1);               if (_tf)  candidates.push(_tf);
      const _mr = meanReversion(symbol, eH1);             if (_mr)  candidates.push(_mr);
      const _bo = breakout(symbol, eH1);                  if (_bo)  candidates.push(_bo);
      const _atr = eH1[eH1.length - 1]?.atr || 0.001;
      const _smc = smcSignal(symbol, eH1, _atr);          if (_smc) candidates.push(_smc);
      const signal = candidates.sort((a, b) => b.confidence - a.confidence)[0] || null;
      if (!signal) continue;
      if (signal.confidence < CONFIG.minConfidence) continue;

      // MTF confluence
      const conf = mtfConfluence(eD1, eH4, eH1, signal.direction);
      if (conf < CONFIG.mtfMinConfluence) {
        errors.push({ instrument: symbol, reason: `MTF low (${(conf * 100).toFixed(0)}%)` });
        continue;
      }
      signal.confidence    = Math.min(95, signal.confidence + Math.round((conf - 0.5) * 20));
      signal.mtfConfluence = +conf.toFixed(2);

      // Volatility check
      const atrPct = atrPercentile(h1, 100);
      const vol    = getVolRegime(atrPct);
      if (vol.skip) {
        errors.push({ instrument: symbol, reason: `Extreme volatility (${atrPct}th pct)` });
        continue;
      }

      signal.atrPercentile = atrPct;
      signal.volRegime     = vol.label;
      signal.regime        = regime;
      signal.market        = 'crypto';
      signal.scannedAt     = new Date().toISOString();
      signals.push(signal);
    }

    signals.sort((a, b) => b.confidence - a.confidence);

    let account = null;
    try { account = await getCryptoAccount(); _balance = account.balance; } catch {}

    state = {
      lastScan: new Date().toISOString(), scanning: false,
      signals: signals.slice(0, 8), errors, regime: regimes, account,
    };

    return { ok: true, count: signals.length, signals, errors, regime: regimes };

  } catch(e) {
    state.scanning = false;
    throw e;
  }
}

// ── Execute ───────────────────────────────────────────────────────────────────
export async function executeCryptoTopSignal() {
  const signal = state.signals[0];
  if (!signal) return { executed: false, reason: 'No crypto signals — run scan first' };

  const { ok, reason } = canTrade(signal.instrument);
  if (!ok) return { executed: false, reason };

  const [account, prices] = await Promise.all([
    getCryptoAccount(),
    getCryptoPrices([signal.instrument]),
  ]);

  const price = prices[signal.instrument];
  if (!price) return { executed: false, reason: 'Price unavailable' };

  const liveEntry = signal.direction === 'LONG' ? price.ask : price.bid;
  const h1Map     = await getMultiCryptoCandles([signal.instrument], 'H1', 120);
  const h1        = h1Map[signal.instrument] || [];

  const units = calcUnits(signal.instrument, liveEntry, signal.sl, h1);
  if (units === 0) return { executed: false, reason: 'Position size = 0 (extreme vol or insufficient balance)' };

  // Paper trading — no real money, skip READ_ONLY / DEMO_ENABLED guards

  // Claude AI analysis
  let aiAnalysis = { approved: true, confidenceAdj: 0, risk: 'MEDIUM', narrative: '', keyFactor: '' };
  try {
    aiAnalysis = await analyzeSignalWithClaude(signal, {
      regime:        state.regime?.[signal.instrument],
      mtfConfluence: signal.mtfConfluence,
      volRegime:     signal.volRegime,
      session:       '24/7',
    });
  } catch {}

  if (!aiAnalysis.approved)
    return { executed: false, reason: `AI veto: ${aiAnalysis.keyFactor || aiAnalysis.narrative || 'Claude rejected this setup'}` };

  if (aiAnalysis.confidenceAdj !== 0) {
    signal.confidence = Math.max(0, Math.min(95, signal.confidence + aiAnalysis.confidenceAdj));
    process.stdout.write(`[CRYPTO AI] ${signal.instrument} confidence ${aiAnalysis.confidenceAdj > 0 ? '+' : ''}${aiAnalysis.confidenceAdj} → ${signal.confidence}%\n`);
  }
  if (aiAnalysis.narrative)
    process.stdout.write(`[CRYPTO AI] ${signal.instrument}: ${aiAnalysis.narrative}\n`);

  const aiNote = aiAnalysis.narrative ? ` | AI: ${aiAnalysis.narrative.slice(0, 45)}` : '';
  const comment = `${signal.strategy}|${signal.confidence}%|${(signal.reasoning||'').slice(0,40)}${aiNote}`.slice(0, 128);

  try {
    const result = await placeCryptoOrder(
      signal.instrument, signal.direction, units, signal.sl, signal.tp, comment
    );

    if (!result?.orderId)
      return { executed: false, reason: `Order rejected: ${JSON.stringify(result).slice(0, 200)}` };

    _openCount++;
    _tradesToday++;
    _openSymbols.push(signal.instrument);
    state.signals.shift();

    process.stdout.write(
      `[CRYPTO AUTO] ${signal.instrument} ${signal.direction} ${units} @ ${liveEntry} (${signal.strategy} ${signal.confidence}%)\n`
    );

    return {
      executed:   true,
      market:     'crypto',
      instrument: signal.instrument,
      direction:  signal.direction,
      units,
      entry:      liveEntry,
      sl:         signal.sl,
      tp:         signal.tp,
      rr:         signal.rr,
      strategy:   signal.strategy,
      confidence: signal.confidence,
      balance:    account.balance,
      ai:         { risk: aiAnalysis.risk, narrative: aiAnalysis.narrative, confidenceAdj: aiAnalysis.confidenceAdj },
    };
  } catch(e) {
    return { executed: false, reason: `Order failed: ${e.message}` };
  }
}

export function getCryptoState() { return { ...state }; }
