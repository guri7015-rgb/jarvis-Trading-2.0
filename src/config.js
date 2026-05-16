import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dir, "../.env");
if (existsSync(envPath)) {
  readFileSync(envPath, "utf8").split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eq = trimmed.indexOf("=");
    if (eq < 0) return;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  });
}

export const OANDA_KEY     = process.env.OANDA_API_KEY      || "";
export const OANDA_ACCT    = process.env.OANDA_ACCOUNT_ID   || "";
export const OANDA_ENV     = process.env.OANDA_ENV          || "practice";
export const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY  || "";
export const NEWS_API_KEY  = process.env.NEWS_API_KEY       || "";
export const PORT          = parseInt(process.env.PORT || "8080", 10);
export const READ_ONLY     = process.env.JARVIS_READ_ONLY   !== "false";
export const DEMO_ENABLED  = process.env.DEMO_TRADING_ENABLED === "true";

// ── Crypto (paper trading — real Binance public data, simulated execution) ────
export const BINANCE_KEY     = "";   // not needed — paper trading uses public API
export const BINANCE_SECRET  = "";
export const BINANCE_TESTNET = false;
export const CRYPTO_PAPER    = true; // always paper trading

export const OANDA_HOST = OANDA_ENV === "live"
  ? "api-fxtrade.oanda.com"
  : "api-fxpractice.oanda.com";

// ── Forex universe ────────────────────────────────────────────────────────────
export const INSTRUMENTS = [
  "EUR_USD", "GBP_USD", "USD_JPY", "USD_CHF",
  "AUD_USD", "USD_CAD", "NZD_USD", "XAU_USD",
];

// ── Crypto universe ───────────────────────────────────────────────────────────
export const CRYPTO_INSTRUMENTS = [
  "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
];

// Correlation groups — never hold two from the same group simultaneously
export const CORRELATION_GROUPS = [
  ["EUR_USD", "GBP_USD", "AUD_USD", "NZD_USD"],  // USD-negative group
  ["USD_JPY", "USD_CHF", "USD_CAD"],              // USD-positive group
];

// Pip/price precision per instrument
export const PIP = {
  EUR_USD: 0.0001, GBP_USD: 0.0001, USD_JPY: 0.01,
  USD_CHF: 0.0001, AUD_USD: 0.0001, USD_CAD: 0.0001,
  NZD_USD: 0.0001, XAU_USD: 0.10,
};
export const PRICE_DECIMALS = {
  EUR_USD: 5, GBP_USD: 5, USD_JPY: 3, USD_CHF: 5,
  AUD_USD: 5, USD_CAD: 5, NZD_USD: 5, XAU_USD: 2,
};

// ── Strategy config ───────────────────────────────────────────────────────────
export const CONFIG = {
  // Timeframes
  entryGranularity:  "H1",
  trendGranularity:  "H4",
  candleCount:       150,

  // Strategy thresholds
  minConfidence:     60,
  minRR:             1.6,
  atrSlMult:         1.5,
  atrTpMult:         3.0,

  // Currency strength
  strengthLookback:  24,    // 24 H1 bars = 24h strength
  strengthThreshold: 0.3,   // minimum differential for strength signal

  // Market regime (ADX)
  adxPeriod:         14,
  adxTrendThreshold: 25,    // ADX > 25 = trending market

  // Session windows (UTC hours) — trade only during high-liquidity sessions
  sessions: {
    london:    { open: 7,  close: 16 },
    newYork:   { open: 12, close: 21 },
    overlap:   { open: 12, close: 16 },  // highest liquidity
  },

  // RSI divergence settings
  rsiDivLookback: 5,        // bars to look back for divergence

  // Risk management
  riskPerTrade:         0.01,    // 1% base risk
  winStreakRisk:         0.015,   // 1.5% after 3 wins
  lossStreakRisk:        0.005,   // 0.5% after 2 losses
  winStreakThreshold:    3,
  lossStreakThreshold:   2,
  maxOpenPositions:      5,
  maxDailyTrades:        10,
  dailyLossLimit:        100,     // USD
  dailyProfitTarget:     200,     // USD — lock gains
  maxConsecutiveLosses:  3,
  drawdownModes: [
    { pct: 0.03, sizeMult: 0.75, label: "Caution" },
    { pct: 0.05, sizeMult: 0.50, label: "Defensive" },
    { pct: 0.08, sizeMult: 0.00, label: "Halted" },
  ],
  maxUnitsPerOrder:     2000,
  maxSpreadMultiple:    2.5,      // skip if spread > 2.5× normal

  // News filter
  newsHaltMinutesBefore: 30,
  newsResumeMinutesAfter: 30,

  // AI
  aiModel:   "claude-sonnet-4-6",
  aiTimeout: 10_000,             // ms

  // Support/resistance proximity
  srProximityPips: 5,            // don't enter within 5 pips of key level

  // Portfolio heat cap
  maxPortfolioHeat: 0.03,        // max 3% of balance at risk across all open trades

  // SMC execution
  limitOrderExpiryHours: 8,      // GTD limit orders expire after 8 hours

  // Multi-timeframe
  mtfMinConfluence: 0.34,        // at least 1/3 timeframes must agree (2/3 for full boost)

  // ── Crypto-specific ────────────────────────────────────────────────────────
  cryptoRiskPerTrade:   0.01,    // 1% risk per crypto trade
  cryptoMaxPositions:   3,       // max simultaneous crypto positions
  cryptoMaxDailyTrades: 6,       // max crypto trades per day
  cryptoLeverage:       5,       // 5× leverage on Binance Futures
};
