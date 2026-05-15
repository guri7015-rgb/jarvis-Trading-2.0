/**
 * Professional Backtesting Engine
 *
 * 1. Walk-forward bar-by-bar simulation (no lookahead)
 * 2. Monte Carlo (1000 shuffled runs) → 5th-percentile drawdown
 * 3. Walk-forward optimization (in-sample / out-of-sample split)
 * 4. Partial TP simulation (50% at 1:1, rest to 2.5:1)
 * 5. Realistic spread + slippage cost
 * 6. Strategy breakdown + per-bar equity curve
 */
import { getMultiCandles } from "./oanda.js";
import { enrich } from "./indicators.js";
import { runStrategies } from "./strategies/index.js";
import { classifyRegime } from "./sessions.js";
import { CONFIG, INSTRUMENTS } from "./config.js";

const WARMUP      = 80;
const SPREAD_COST = 0.00012;  // ~1.2 pip spread simulation
const SLIPPAGE    = 0.00003;  // ~0.3 pip slippage on market orders

// ── Core bar-by-bar simulator ─────────────────────────────────────────────────
function simulate(instrument, candles) {
  const data    = enrich(candles);
  let balance   = 10_000;
  let peak      = 10_000;
  let maxDD     = 0;
  const trades  = [];
  let openTrade = null;
  const equity  = [balance];

  for (let i = WARMUP; i < data.length; i++) {
    const bar = data[i];
    if (!bar?.atr || !bar?.rsi) continue;

    // ── Exit management ──
    if (openTrade) {
      const { direction, sl, tp, tp1, tp2, entry, units, partial } = openTrade;
      let close = null;
      let isPartial = false;

      if (direction === 'LONG') {
        if (bar.low  <= sl)  close = sl;
        else if (!partial && tp1 && bar.high >= tp1) { close = tp1; isPartial = true; }
        else if (bar.high >= tp2) close = tp2;
      } else {
        if (bar.high >= sl)  close = sl;
        else if (!partial && tp1 && bar.low <= tp1) { close = tp1; isPartial = true; }
        else if (bar.low  <= tp2) close = tp2;
      }

      if (close !== null) {
        const activeUnits = isPartial ? units * 0.5 : openTrade.activeUnits;
        const pnl = (direction === 'LONG' ? close - entry : entry - close) * activeUnits
                    - (SPREAD_COST + SLIPPAGE) * activeUnits;
        balance += pnl;
        peak     = Math.max(peak, balance);
        const dd = (peak - balance) / peak;
        if (dd > maxDD) maxDD = dd;

        if (isPartial) {
          // Move SL to breakeven, continue with remaining 50%
          openTrade.partial     = true;
          openTrade.sl          = entry;  // breakeven
          openTrade.activeUnits = units * 0.5;
          trades.push({ ...openTrade, closePrice: close, pnl: +pnl.toFixed(4), result: 'TP1_PARTIAL' });
        } else {
          trades.push({ ...openTrade, closePrice: close, pnl: +pnl.toFixed(4),
                        result: close === sl ? 'SL' : 'TP' });
          openTrade = null;
        }
        equity.push(+balance.toFixed(2));
      }
    }

    // ── Entry ──
    if (!openTrade) {
      const window  = data.slice(0, i + 1);
      const regime  = classifyRegime(window);
      const signal  = runStrategies(instrument, window, { [instrument]: candles.slice(0, i + 1) }, regime);
      if (!signal || signal.confidence < CONFIG.minConfidence) continue;

      const slDist   = Math.abs(signal.entry - signal.sl);
      if (slDist === 0) continue;

      const riskUsd  = balance * CONFIG.riskPerTrade;
      const units    = Math.min(riskUsd / slDist, CONFIG.maxUnitsPerOrder);
      const risk     = Math.abs(signal.entry - signal.sl);
      const tp1      = signal.direction === 'LONG' ? signal.entry + risk       : signal.entry - risk;
      const tp2      = signal.direction === 'LONG' ? signal.entry + risk * 2.5 : signal.entry - risk * 2.5;

      openTrade = {
        instrument, direction: signal.direction, strategy: signal.strategy,
        entry: signal.entry, sl: signal.sl, tp: signal.tp, tp1, tp2,
        rr: signal.rr, units: +units.toFixed(2), activeUnits: +units.toFixed(2),
        openBar: i, confidence: signal.confidence, partial: false,
      };
    }
  }

  // Force-close remaining
  if (openTrade) {
    const last = data[data.length - 1];
    const pnl  = (openTrade.direction === 'LONG'
      ? last.close - openTrade.entry
      : openTrade.entry - last.close) * openTrade.activeUnits;
    balance += pnl;
    trades.push({ ...openTrade, closePrice: last.close, pnl: +pnl.toFixed(4), result: 'EXPIRED' });
    equity.push(+balance.toFixed(2));
  }

  return { trades, finalBalance: +balance.toFixed(4), maxDD: +maxDD.toFixed(4), equity };
}

// ── Monte Carlo ───────────────────────────────────────────────────────────────
/**
 * Shuffle trade PnL sequence 1000 times.
 * Returns 5th and 95th percentile ending balance + worst drawdown.
 * This tells you: "even if we got unlucky ordering, would we survive?"
 */
function monteCarlo(trades, runs = 1000) {
  if (trades.length < 5) return { p5: 0, p95: 0, worstDD: 0, avgFinal: 0 };

  const pnls = trades.map(t => t.pnl);
  const finals = [];
  let worstDD = 0;

  for (let r = 0; r < runs; r++) {
    // Fisher-Yates shuffle
    const shuffled = [...pnls];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    let bal = 10_000;
    let peak = bal;
    let dd = 0;
    for (const pnl of shuffled) {
      bal += pnl;
      peak = Math.max(peak, bal);
      dd   = Math.max(dd, (peak - bal) / peak);
    }
    finals.push(bal);
    worstDD = Math.max(worstDD, dd);
  }

  finals.sort((a, b) => a - b);
  return {
    p5:       +finals[Math.floor(finals.length * 0.05)].toFixed(2),
    p95:      +finals[Math.floor(finals.length * 0.95)].toFixed(2),
    median:   +finals[Math.floor(finals.length * 0.5)].toFixed(2),
    worstDD:  +worstDD.toFixed(4),
    avgFinal: +(finals.reduce((a, b) => a + b, 0) / finals.length).toFixed(2),
  };
}

// ── Walk-forward Optimization ─────────────────────────────────────────────────
/**
 * Split data 70% in-sample / 30% out-of-sample.
 * Measure whether out-of-sample degrades significantly vs in-sample.
 * If OOS win rate < 80% of IS → overfitting warning.
 */
function walkForward(instrument, candles) {
  const split = Math.floor(candles.length * 0.7);
  const is    = candles.slice(0, split);
  const oos   = candles.slice(split - WARMUP);  // keep warmup overlap

  const isResult  = simulate(instrument, is);
  const oosResult = simulate(instrument, oos);

  const isWR  = isResult.trades.length  ? isResult.trades.filter(t => t.pnl > 0).length  / isResult.trades.length  : 0;
  const oosWR = oosResult.trades.length ? oosResult.trades.filter(t => t.pnl > 0).length / oosResult.trades.length : 0;

  const degradation = isWR > 0 ? (isWR - oosWR) / isWR : 0;
  const robust = degradation < 0.2;  // < 20% degradation = robust

  return {
    inSample:    { trades: isResult.trades.length,  winRate: +isWR.toFixed(3),  pnl: +(isResult.finalBalance  - 10_000).toFixed(2), maxDD: isResult.maxDD  },
    outOfSample: { trades: oosResult.trades.length, winRate: +oosWR.toFixed(3), pnl: +(oosResult.finalBalance - 10_000).toFixed(2), maxDD: oosResult.maxDD },
    degradation: +degradation.toFixed(3),
    robust,
    verdict: robust ? 'ROBUST' : 'OVERFIT_WARNING',
  };
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function calcMetrics(trades, finalBalance, maxDD, equity) {
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const pnl    = finalBalance - 10_000;
  const wr     = trades.length ? wins.length / trades.length : 0;
  const avgW   = wins.length   ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length   : 0;
  const avgL   = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const pf     = avgL < 0      ? Math.abs(avgW * wins.length / (avgL * losses.length)) : Infinity;

  // Annualised Sharpe from equity curve
  const returns = equity.slice(1).map((v, i) => (v - equity[i]) / equity[i]);
  const meanR   = returns.reduce((a, b) => a + b, 0) / (returns.length || 1);
  const stdR    = Math.sqrt(returns.reduce((a, b) => a + (b - meanR) ** 2, 0) / (returns.length || 1));
  const sharpe  = stdR > 0 ? +(meanR / stdR * Math.sqrt(252)).toFixed(2) : 0;

  // Calmar ratio (annual return / max drawdown)
  const annualReturn = (pnl / 10_000) * (252 / Math.max(equity.length, 1));
  const calmar       = maxDD > 0 ? +(annualReturn / maxDD).toFixed(2) : 0;

  // Strategy breakdown
  const byStrat = {};
  for (const t of trades) {
    if (!byStrat[t.strategy]) byStrat[t.strategy] = { count: 0, pnl: 0, wins: 0 };
    byStrat[t.strategy].count++;
    byStrat[t.strategy].pnl += t.pnl;
    if (t.pnl > 0) byStrat[t.strategy].wins++;
  }

  return { wins: wins.length, losses: losses.length, winRate: +wr.toFixed(3),
           totalPnl: +pnl.toFixed(2), finalBalance: +finalBalance.toFixed(2),
           avgWin: +avgW.toFixed(4), avgLoss: +avgL.toFixed(4),
           profitFactor: +Math.min(pf, 99).toFixed(2),
           sharpe, calmar, maxDrawdown: maxDD, strategies: byStrat };
}

function grade(wr, sharpe, maxDD, wfVerdict, mc) {
  const mcSurvives = mc && mc.p5 > 8_000;  // 80% of starting capital at 5th percentile
  if (wr > 0.55 && sharpe > 1.5 && maxDD < 0.08 && wfVerdict === 'ROBUST' && mcSurvives) return 'A — EXCELLENT';
  if (wr > 0.50 && sharpe > 1.0 && maxDD < 0.12 && wfVerdict === 'ROBUST')               return 'B — PASS';
  if (wr > 0.45 && sharpe > 0.8 && maxDD < 0.18)                                          return 'C — WEAK';
  if (maxDD > 0.25 || wr < 0.3)                                                            return 'F — FAIL';
  if (wr > 0.80)                                                                            return 'X — SUSPICIOUS';
  return 'D — INSUFFICIENT';
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function runBacktest({ instrument = 'EUR_USD', granularity = 'H1', candleCount = 500, mcRuns = 1000 } = {}) {
  const raw = await getMultiCandles([instrument], granularity, Math.min(candleCount, 5000));
  const c   = raw[instrument];
  if (!c || c.length < WARMUP + 10) throw new Error(`Insufficient candles (${c?.length || 0})`);

  const { trades, finalBalance, maxDD, equity } = simulate(instrument, c);
  const metrics = calcMetrics(trades, finalBalance, maxDD, equity);
  const mc      = monteCarlo(trades, mcRuns);
  const wf      = walkForward(instrument, c);

  return {
    ok: true, instrument,
    totalTrades: trades.length,
    ...metrics,
    monteCarlo: mc,
    walkForward: wf,
    recentTrades: trades.slice(-10),
    equityCurve:  equity.slice(-100),
    grade: grade(metrics.winRate, metrics.sharpe, maxDD, wf.verdict, mc),
  };
}

export async function runFullBacktest({ instruments, granularity = 'H1', candleCount = 500, mcRuns = 500 } = {}) {
  const targets = instruments || INSTRUMENTS;
  const results = [];

  for (const instrument of targets) {
    try {
      results.push(await runBacktest({ instrument, granularity, candleCount, mcRuns }));
    } catch (e) {
      results.push({ instrument, ok: false, error: e.message });
    }
  }

  const ok = results.filter(r => r.ok);
  return {
    ok: true, instruments: targets, results,
    summary: {
      totalPnl:    +ok.reduce((a, r) => a + r.totalPnl, 0).toFixed(2),
      avgWinRate:  ok.length ? +(ok.reduce((a, r) => a + r.winRate, 0) / ok.length).toFixed(3) : 0,
      avgSharpe:   ok.length ? +(ok.reduce((a, r) => a + r.sharpe, 0)  / ok.length).toFixed(2) : 0,
      maxDrawdown: ok.length ? +Math.max(...ok.map(r => r.maxDrawdown)).toFixed(4) : 0,
      mcWorstDD:   ok.length ? +Math.max(...ok.filter(r => r.monteCarlo).map(r => r.monteCarlo.worstDD)).toFixed(4) : 0,
      robustCount: ok.filter(r => r.walkForward?.verdict === 'ROBUST').length,
      grades:      ok.map(r => `${r.instrument}: ${r.grade}`),
    },
  };
}
