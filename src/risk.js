/**
 * Master risk manager — the bot's immune system.
 *
 * Covers:
 * - Streak-adaptive position sizing
 * - Volatility-regime sizing (ATR percentile)
 * - Portfolio heat cap (max 3% total open risk)
 * - Multi-level daily circuit breakers
 * - Drawdown protection modes
 * - Correlation guard
 * - Spread filter
 * - Position count limiter
 */
import { CONFIG, CORRELATION_GROUPS, PIP } from "./config.js";
import { atrPercentile, getVolRegime, heatCheck, registerTradeHeat, removeTradeHeat, getHeatPct, getHeatState } from "./volatility.js";

const state = {
  initialBalance:     10_000,
  dailyStartBalance:  10_000,
  peakBalance:        10_000,
  lastDate:           "",
  tradesOpenedToday:  0,
  dailyRealizedPL:    0,
  consecutiveWins:    0,
  consecutiveLosses:  0,
  openCount:          0,
  openInstruments:    [],
  openTradeIds:       {},   // instrument → tradeId for heat tracking
  locked:             false,
  lockReason:         "",
  lockUntil:          null,
  drawdownMode:       null,
  volRegime:          null,
};

export function initRisk(balance) {
  Object.assign(state, {
    initialBalance: balance, dailyStartBalance: balance,
    peakBalance: balance, lastDate: today(),
    tradesOpenedToday: 0, dailyRealizedPL: 0,
    consecutiveWins: 0, consecutiveLosses: 0,
    openCount: 0, openInstruments: [], locked: false,
    openTradeIds: {}, volRegime: null,
  });
}

function today() { return new Date().toISOString().slice(0, 10); }

function refreshDay(balance) {
  const t = today();
  if (t !== state.lastDate) {
    state.lastDate = t;
    state.dailyStartBalance = balance;
    state.tradesOpenedToday = 0;
    state.dailyRealizedPL = 0;
    if (state.locked && state.lockUntil && Date.now() > state.lockUntil) {
      state.locked = false; state.lockReason = ""; state.lockUntil = null;
    }
  }
}

function applyDrawdownMode(balance) {
  if (balance > state.peakBalance) state.peakBalance = balance;
  const dd = state.peakBalance > 0 ? (state.peakBalance - balance) / state.peakBalance : 0;
  const mode = CONFIG.drawdownModes.slice().reverse().find((m) => dd >= m.pct);
  state.drawdownMode = mode || null;
  return mode;
}

function lock(reason, hours = 24) {
  state.locked = true;
  state.lockReason = reason;
  state.lockUntil = Date.now() + hours * 3_600_000;
}

export function currentRiskPct() {
  if (state.consecutiveWins  >= CONFIG.winStreakThreshold)  return CONFIG.winStreakRisk;
  if (state.consecutiveLosses >= CONFIG.lossStreakThreshold) return CONFIG.lossStreakRisk;
  return CONFIG.riskPerTrade;
}

export function canTrade(balance, instrument, spread, normalSpread, candles) {
  refreshDay(balance);

  if (state.locked)
    return { ok: false, reason: state.lockReason };

  const ddMode = applyDrawdownMode(balance);
  if (ddMode?.sizeMult === 0)
    return { ok: false, reason: `Drawdown mode: ${ddMode.label} — trading halted` };

  const dailyPL = balance - state.dailyStartBalance;
  if (dailyPL <= -CONFIG.dailyLossLimit) {
    lock(`Daily loss limit -$${CONFIG.dailyLossLimit} hit`, 24);
    return { ok: false, reason: `Daily loss limit reached (-$${Math.abs(dailyPL).toFixed(2)})` };
  }
  if (dailyPL >= CONFIG.dailyProfitTarget) {
    lock(`Daily profit target +$${CONFIG.dailyProfitTarget} hit — locking gains`, 20);
    return { ok: false, reason: `Daily profit target reached (+$${dailyPL.toFixed(2)}) — gains locked` };
  }
  if (state.consecutiveLosses >= CONFIG.maxConsecutiveLosses) {
    lock(`${CONFIG.maxConsecutiveLosses} consecutive losses — cooling off`, 4);
    return { ok: false, reason: `${CONFIG.maxConsecutiveLosses} consecutive losses — cooling off` };
  }
  if (state.openCount >= CONFIG.maxOpenPositions)
    return { ok: false, reason: `Max open positions (${CONFIG.maxOpenPositions}) reached` };
  if (state.tradesOpenedToday >= CONFIG.maxDailyTrades)
    return { ok: false, reason: `Max daily trades (${CONFIG.maxDailyTrades}) reached` };

  // Volatility regime check — skip extreme vol
  if (candles && candles.length >= 50) {
    const atrPct = atrPercentile(candles, 100);
    const vol    = getVolRegime(atrPct);
    state.volRegime = vol;
    if (vol.skip)
      return { ok: false, reason: `Volatility extreme (${atrPct}th pct) — skipping entry` };
  }

  // Correlation guard
  const group = CORRELATION_GROUPS.find((g) => g.includes(instrument));
  if (group) {
    const collision = state.openInstruments.filter((i) => group.includes(i));
    if (collision.length >= 2)
      return { ok: false, reason: `Correlation block: already holding ${collision.join(", ")}` };
  }

  // Spread filter
  if (spread && normalSpread && spread > normalSpread * CONFIG.maxSpreadMultiple)
    return { ok: false, reason: `Spread too wide (${spread.toFixed(5)} vs normal ${normalSpread.toFixed(5)})` };

  return { ok: true, reason: "OK" };
}

export function calcUnits(balance, entry, sl, instrument, candles) {
  const ddMode   = applyDrawdownMode(balance);
  let sizeMult   = ddMode ? ddMode.sizeMult : 1;

  // Volatility regime sizing
  if (candles && candles.length >= 50) {
    const atrPct = atrPercentile(candles, 100);
    const vol    = getVolRegime(atrPct);
    sizeMult    *= vol.sizeMult;
    state.volRegime = vol;
  }

  const riskUsd  = balance * currentRiskPct() * sizeMult;
  const slDist   = Math.abs(entry - sl);
  if (slDist === 0) return 0;

  // Portfolio heat check
  const heat = heatCheck(balance, riskUsd, CONFIG.maxPortfolioHeat || 0.03);
  if (!heat.ok) return 0;  // heat cap hit — caller will see units=0 and skip

  const pip      = PIP[instrument]  || 0.0001;
  const isJpy    = instrument.includes("JPY");
  const isGold   = instrument.includes("XAU");
  const pipVal   = isGold ? 1.0 : isJpy ? 0.0909 : 0.10;  // per 1k units
  const pips     = slDist / pip;
  const rawUnits = (riskUsd / (pips * pipVal / 1000));

  return Math.min(Math.round(rawUnits), CONFIG.maxUnitsPerOrder);
}

export function onTradeOpened(instrument, tradeId, riskUsd) {
  state.openCount++;
  state.tradesOpenedToday++;
  state.openInstruments.push(instrument);
  if (tradeId && riskUsd) {
    state.openTradeIds[instrument] = tradeId;
    registerTradeHeat(tradeId, riskUsd);
  }
}

export function onTradeClosed(instrument, pnl) {
  state.openCount = Math.max(0, state.openCount - 1);
  state.openInstruments = state.openInstruments.filter((i) => i !== instrument);
  state.dailyRealizedPL += pnl;
  if (pnl > 0) { state.consecutiveWins++; state.consecutiveLosses = 0; }
  else         { state.consecutiveLosses++; state.consecutiveWins = 0; }

  const tradeId = state.openTradeIds[instrument];
  if (tradeId) {
    removeTradeHeat(tradeId);
    delete state.openTradeIds[instrument];
  }
}

export function getRiskState() {
  return {
    ...state,
    currentRiskPct:   currentRiskPct(),
    drawdownMode:     state.drawdownMode?.label || "Normal",
    volRegime:        state.volRegime?.label || "NORMAL",
    lockExpiresIn:    state.lockUntil ? Math.max(0, Math.round((state.lockUntil - Date.now()) / 60_000)) + "min" : null,
    heat:             getHeatState(),
  };
}
