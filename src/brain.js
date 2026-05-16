/**
 * JARVIS v2 Brain — the orchestrator.
 *
 * Every scan:
 *   1. Daily reset + closed trade sync
 *   2. Session + weekend gate
 *   3. Fetch D1 + H4 + H1 + M15 candles for all instruments
 *   4. Compute currency strength
 *   5. Classify regime (H4 primary, H1 confirmation)
 *   6. Run all 6 strategies (including SMC)
 *   7. Filter by confidence + R:R
 *   8. Spread check
 *   9. News filter (calendar → AI)
 *  10. Portfolio heat check
 *  11. Execute with best order type (LIMIT at OB/FVG or MARKET)
 *  12. Partial TP management loop
 */
import { INSTRUMENTS, CONFIG, READ_ONLY, DEMO_ENABLED } from "./config.js";
import { getMultiCandles, getAccountSummary, getOpenTrades, getClosedTrades, getPrices, placeOrder } from "./oanda.js";
import { enrich } from "./indicators.js";
import { classifyRegime, isWeekend, getActiveSession, sessionScore } from "./sessions.js";
import { runStrategies } from "./strategies/index.js";
import { evaluateSignal, analyzeSignalWithClaude, fetchEconomicCalendar } from "./news.js";
import { canTrade, calcUnits, onTradeOpened, onTradeClosed, initRisk, getRiskState, currentRiskPct } from "./risk.js";
import { calcStrength, rankCurrencies } from "./strength.js";
import { placeLimitEntry, placeMarketEntry, setupPartialTP, moveToBreakeven, setTrailingStop, getExecutionType, hasConfirmationCandle } from "./execution.js";
import { atrPercentile, getVolRegime, heatCheck } from "./volatility.js";

let scanState = {
  lastScan: null, scanning: false, lastDuration: 0,
  signals: [], errors: [], regime: {},
  strength: {}, sessionInfo: [], account: null,
};

let _normalSpreads = {};
let _initialized   = false;

// ── Partial TP tracker ────────────────────────────────────────────────────────
// tradeId → { tp1, tp2, breakeven, tp1Hit, direction, instrument }
const _partialTPs = new Map();

// ── Spread tracker ────────────────────────────────────────────────────────────
function updateNormalSpread(inst, spread) {
  if (!spread) return;
  _normalSpreads[inst] = _normalSpreads[inst]
    ? _normalSpreads[inst] * 0.95 + spread * 0.05
    : spread;
}

// ── Closed trade sync ─────────────────────────────────────────────────────────
let _lastClosedIds = new Set();
async function syncClosedTrades() {
  try {
    const closed = await getClosedTrades(10);
    for (const t of closed) {
      if (!_lastClosedIds.has(t.id)) {
        _lastClosedIds.add(t.id);
        onTradeClosed(t.instrument, +t.realizedPL || 0);
        _partialTPs.delete(String(t.id));
      }
    }
  } catch { /* non-critical */ }
}

// ── Partial TP management (called every scan) ─────────────────────────────────
async function managePartialTPs(prices) {
  if (_partialTPs.size === 0) return;

  for (const [tradeId, tp] of _partialTPs.entries()) {
    if (tp.tp1Hit) continue;
    const price = prices[tp.instrument];
    if (!price) continue;

    const mid = (price.bid + price.ask) / 2;
    const hitTP1 = tp.direction === 'LONG' ? mid >= tp.tp1 : mid <= tp.tp1;

    if (hitTP1) {
      tp.tp1Hit = true;
      try {
        // Move SL to breakeven
        await moveToBreakeven(tradeId, tp.instrument, tp.breakeven);
        // Optionally set trailing stop for remaining half
        const trailDist = Math.abs(tp.tp2 - tp.breakeven) * 0.3;
        await setTrailingStop(tradeId, tp.instrument, trailDist);
        console.log(`[PartialTP] Trade ${tradeId} ${tp.instrument}: TP1 hit, moved to breakeven ${tp.breakeven}`);
      } catch (e) {
        console.error(`[PartialTP] Failed to update trade ${tradeId}:`, e.message);
      }
    }
  }
}

// ── Multi-timeframe confirmation ──────────────────────────────────────────────
/**
 * Returns a confluence score 0–1 from D1 + H4 + H1 alignment.
 * Higher = more timeframes agree on direction.
 */
function mtfConfluence(d1, h4, h1, direction) {
  let score = 0;
  let total = 0;

  for (const tf of [d1, h4, h1]) {
    if (!tf || tf.length < 3) continue;
    total++;
    const last = tf[tf.length - 1];
    const prev = tf[tf.length - 2];
    const tfDir = last.close > prev.close ? 'LONG' : 'SHORT';
    if (tfDir === direction) score++;
  }

  return total > 0 ? score / total : 0.5;
}

// ── Main scan ─────────────────────────────────────────────────────────────────
export async function fullScan() {
  if (scanState.scanning) return { ok: false, message: "Scan already in progress" };
  scanState.scanning = true;
  const t0 = Date.now();
  const errors = [];

  try {
    if (!_initialized) {
      try {
        const acct = await getAccountSummary();
        initRisk(acct.balance);
        // Reconcile any open positions from before this process started
        try {
          const openTrades = await getOpenTrades();
          for (const t of openTrades) {
            const riskEst = acct.balance * 0.01;  // assume 1% risk per existing trade
            onTradeOpened(t.instrument, t.id, riskEst);
            _lastClosedIds.add(t.id);  // prevent double-counting if closed later
          }
          if (openTrades.length)
            process.stdout.write(`[INIT] Reconciled ${openTrades.length} existing open trade(s)\n`);
        } catch { /* non-critical */ }
        _initialized = true;
      } catch { initRisk(10_000); _initialized = true; }
    }

    await syncClosedTrades();

    if (isWeekend()) {
      scanState = { ...scanState, scanning: false, lastScan: new Date().toISOString(),
        signals: [], errors: [{ instrument: 'ALL', reason: 'Market closed — weekend' }] };
      return { ok: true, signals: [], marketClosed: true };
    }

    const session   = getActiveSession();
    const sessScore = sessionScore();

    // Fetch 4 timeframes in parallel
    const [d1Map, h4Map, h1Map, m15Map] = await Promise.all([
      getMultiCandles(INSTRUMENTS, 'D',  60),
      getMultiCandles(INSTRUMENTS, 'H4', Math.ceil(CONFIG.candleCount / 4)),
      getMultiCandles(INSTRUMENTS, CONFIG.entryGranularity, CONFIG.candleCount),
      getMultiCandles(INSTRUMENTS, 'M15', 80),
    ]);

    let prices = {};
    try { prices = await getPrices(INSTRUMENTS); } catch { /* optional */ }

    for (const [inst, p] of Object.entries(prices)) updateNormalSpread(inst, p.spread);

    // Manage partial TPs with fresh prices
    await managePartialTPs(prices);

    const strength = calcStrength(h1Map, CONFIG.strengthLookback);
    const ranked   = rankCurrencies(strength);
    const signals  = [];
    const regimes  = {};

    for (const instrument of INSTRUMENTS) {
      const d1  = d1Map[instrument];
      const h4  = h4Map[instrument];
      const h1  = h1Map[instrument];
      const m15 = m15Map[instrument];

      if (!h1 || h1.length < 80) {
        errors.push({ instrument, reason: `Insufficient H1 candles (${h1?.length || 0})` });
        continue;
      }

      const enrichedD1  = d1  ? enrich(d1)  : null;
      const enrichedH4  = h4  ? enrich(h4)  : null;
      const enrichedH1  = enrich(h1);
      const enrichedM15 = m15 ? enrich(m15) : null;

      // Regime from H4 (most reliable for regime), fallback H1
      const regime = classifyRegime(enrichedH4 || enrichedH1);
      regimes[instrument] = regime;

      // Signal from H1 (entry timeframe)
      const signal = runStrategies(instrument, enrichedH1, h1Map, regime);
      if (!signal) continue;

      if (signal.confidence < CONFIG.minConfidence) continue;

      // Multi-timeframe confluence boost
      const confluence = mtfConfluence(enrichedD1, enrichedH4, enrichedH1, signal.direction);
      if (confluence < CONFIG.mtfMinConfluence) {
        errors.push({ instrument, reason: `MTF confluence too low (${(confluence * 100).toFixed(0)}%) for ${signal.direction}` });
        continue;
      }
      const confluenceBoost = Math.round((confluence - 0.5) * 20);  // up to +10 for 3/3 alignment
      signal.confidence = Math.min(95, signal.confidence + confluenceBoost);
      signal.mtfConfluence = +confluence.toFixed(2);

      // M15 confirmation for SMC limit orders
      if (signal.strategy === 'smc' && enrichedM15) {
        const confirmed = hasConfirmationCandle(enrichedM15, signal.direction);
        signal.m15Confirmed = confirmed;
        if (!confirmed) signal.confidence = Math.max(signal.confidence - 8, CONFIG.minConfidence);
      }

      // Session confidence weight
      signal.confidence = Math.min(95, Math.round(signal.confidence * (0.7 + 0.3 * sessScore)));

      // Volatility regime check
      const atrPct = atrPercentile(h1, 100);
      const volReg = getVolRegime(atrPct);
      if (volReg.skip) {
        errors.push({ instrument, reason: `Extreme volatility (${atrPct}th pct) — skipping` });
        continue;
      }
      signal.atrPercentile = atrPct;
      signal.volRegime     = volReg.label;

      // Spread check
      const price  = prices[instrument];
      const spread = price?.spread;
      const normal = _normalSpreads[instrument];
      if (spread && normal && spread > normal * CONFIG.maxSpreadMultiple) {
        errors.push({ instrument, reason: `Spread too wide (${spread?.toFixed(5)})` });
        continue;
      }

      signal.spread    = spread ? +spread.toFixed(6) : null;
      signal.regime    = regime;
      signal.session   = session.join('+') || 'Off-hours';
      signal.scannedAt = new Date().toISOString();

      signals.push(signal);
    }

    signals.sort((a, b) => b.confidence - a.confidence);

    let account = null;
    try { account = await getAccountSummary(); } catch { /* optional */ }

    scanState = {
      lastScan: new Date().toISOString(), scanning: false,
      lastDuration: Date.now() - t0,
      signals: signals.slice(0, 8),
      errors, regime: regimes, strength, ranked,
      sessionInfo: session, account,
    };

    return {
      ok: true, count: signals.length, signals, errors,
      regime: regimes, strength, ranked,
      session, sessScore: +sessScore.toFixed(2),
      duration: scanState.lastDuration,
    };

  } catch (e) {
    scanState.scanning = false;
    throw e;
  }
}

// ── Execute top signal ────────────────────────────────────────────────────────
export async function executeTopSignal() {
  const signal = scanState.signals[0];
  if (!signal) return { executed: false, reason: 'No signals — run /api/brain/scan first' };

  const account = await getAccountSummary();
  const price   = (await getPrices([signal.instrument]))[signal.instrument];

  // Risk gate (pass H1 candles for vol check)
  const h1Map   = await getMultiCandles([signal.instrument], CONFIG.entryGranularity, 120);
  const h1      = h1Map[signal.instrument];
  const { ok, reason } = canTrade(
    account.balance, signal.instrument,
    price?.spread, _normalSpreads[signal.instrument], h1
  );
  if (!ok) return { executed: false, reason };

  // Portfolio heat check before sizing
  const liveEntry = signal.direction === 'LONG' ? price.ask : price.bid;
  const units     = calcUnits(account.balance, liveEntry, signal.sl, signal.instrument, h1);
  if (units === 0) return { executed: false, reason: 'Position size = 0 (heat cap, drawdown mode, or extreme vol)' };

  // Run news eval + Claude AI analysis in parallel
  const [newsRes, aiRes] = await Promise.allSettled([
    evaluateSignal(signal).catch(e => {
      process.stdout.write(`[NEWS] Error: ${e.message}\n`);
      return { decision: 'APPROVE', sizeMult: 1.0, reasoning: 'News check failed' };
    }),
    analyzeSignalWithClaude(signal, {
      regime:        scanState.regime?.[signal.instrument],
      mtfConfluence: signal.mtfConfluence,
      strength:      scanState.strength,
      volRegime:     signal.volRegime,
      session:       scanState.sessionInfo,
    }).catch(() => ({ approved: true, confidenceAdj: 0, risk: 'MEDIUM', narrative: '', keyFactor: '' })),
  ]);

  const newsResult = newsRes.status === 'fulfilled' ? newsRes.value
    : { decision: 'APPROVE', sizeMult: 1.0, reasoning: 'News eval failed' };
  const aiAnalysis = aiRes.status === 'fulfilled' ? aiRes.value
    : { approved: true, confidenceAdj: 0, risk: 'MEDIUM', narrative: '', keyFactor: '' };

  if (newsResult.decision === 'SKIP')
    return { executed: false, reason: `News veto: ${newsResult.reasoning}` };
  if (!aiAnalysis.approved)
    return { executed: false, reason: `AI veto: ${aiAnalysis.keyFactor || aiAnalysis.narrative || 'Claude rejected this setup'}` };

  // Apply Claude confidence adjustment
  if (aiAnalysis.confidenceAdj !== 0) {
    signal.confidence = Math.max(0, Math.min(95, signal.confidence + aiAnalysis.confidenceAdj));
    process.stdout.write(`[AI] ${signal.instrument} confidence adjusted ${aiAnalysis.confidenceAdj > 0 ? '+' : ''}${aiAnalysis.confidenceAdj} → ${signal.confidence}%\n`);
  }
  if (aiAnalysis.narrative)
    process.stdout.write(`[AI] ${signal.instrument}: ${aiAnalysis.narrative}\n`);

  const sizeMult    = newsResult.sizeMult ?? 1.0;
  const finalUnits  = Math.round(units * sizeMult);
  if (finalUnits === 0) return { executed: false, reason: 'Position size = 0 after news size reduction' };

  if (READ_ONLY) {
    return {
      executed: false, readOnly: true,
      reason: 'Read-only mode — set JARVIS_READ_ONLY=false to enable execution',
      wouldHave: { instrument: signal.instrument, direction: signal.direction, units: finalUnits,
                   entry: liveEntry, sl: signal.sl, tp: signal.tp, execType: getExecutionType(signal) },
    };
  }

  if (!DEMO_ENABLED) {
    return { executed: false, reason: 'Demo trading disabled — set DEMO_TRADING_ENABLED=true to enable', signal };
  }

  // Choose execution type
  const execType = getExecutionType(signal);
  let orderResult;

  try {
    if (execType === 'LIMIT' && signal.entryLimit) {
      // Inject AI narrative into signal reasoning for position detail display
      if (aiAnalysis.narrative) signal.reasoning = `${signal.reasoning} | AI: ${aiAnalysis.narrative}`;
      orderResult = await placeLimitEntry(signal, finalUnits);
    } else {
      const aiNote = aiAnalysis.narrative ? ` | AI: ${aiAnalysis.narrative.slice(0, 45)}` : '';
      const comment = `${signal.strategy}|${signal.confidence}%|${signal.reasoning}${aiNote}`.slice(0, 128);
      orderResult = await placeOrder(signal.instrument, signal.direction === 'LONG' ? finalUnits : -finalUnits, signal.sl, signal.tp, comment);
    }
  } catch (e) {
    return { executed: false, reason: `Order failed: ${e.message}` };
  }

  // Validate the order actually filled
  const fillTx = orderResult?.orderFillTransaction;
  const limitTx = orderResult?.orderCreateTransaction;
  if (!fillTx && !limitTx) {
    const rejection = orderResult?.orderRejectTransaction || orderResult?.errorMessage || JSON.stringify(orderResult).slice(0, 200);
    return { executed: false, reason: `Order rejected by broker: ${rejection}` };
  }

  const tradeId = fillTx?.tradeOpened?.tradeID
               || fillTx?.tradeID
               || limitTx?.id
               || orderResult?.relatedTransactionIDs?.[0]
               || String(Date.now());

  const riskUsd = account.balance * currentRiskPct() * (sizeMult || 1);
  onTradeOpened(signal.instrument, tradeId, riskUsd);

  // Set up partial TPs
  const ptpConfig = await setupPartialTP(tradeId, signal.instrument, signal.direction, liveEntry, signal.sl);
  _partialTPs.set(String(tradeId), { ...ptpConfig, direction: signal.direction, instrument: signal.instrument });

  scanState.signals.shift();

  return {
    executed: true, instrument: signal.instrument, direction: signal.direction,
    units: finalUnits, entry: liveEntry, sl: signal.sl, tp: signal.tp, rr: signal.rr,
    strategy: signal.strategy, confidence: signal.confidence,
    execType,
    partialTP: { tp1: ptpConfig.tp1, tp2: ptpConfig.tp2, breakeven: ptpConfig.breakeven },
    mtfConfluence: signal.mtfConfluence,
    volRegime: signal.volRegime,
    news: { decision: newsResult.decision, sizeMult, reasoning: newsResult.reasoning },
    ai:   { risk: aiAnalysis.risk, narrative: aiAnalysis.narrative, keyFactor: aiAnalysis.keyFactor, confidenceAdj: aiAnalysis.confidenceAdj },
    riskPct: +currentRiskPct().toFixed(4),
    balance: account.balance,
    order: orderResult,
  };
}

export function getScanState() { return { ...scanState, risk: getRiskState() }; }
