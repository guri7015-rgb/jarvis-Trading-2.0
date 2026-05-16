/**
 * JARVIS v2 HTTP Server
 * All 9 endpoints from the spec + /api/brain/strength + /api/brain/kill
 *
 * Run:  node src/server.js
 */
import http from "http";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { PORT, INSTRUMENTS, CONFIG, OANDA_ENV, OANDA_ACCT } from "./config.js";
import { fullScan, executeTopSignal, getScanState } from "./brain.js";
import { getAccountSummary, getOpenTrades, closeAllPositions, getMultiCandles } from "./oanda.js";
import { fetchEconomicCalendar, getRelevantEvents, fetchHeadlines, analyzeHeadlinesWithClaude, categorizeHeadline } from "./news.js";
import { runBacktest, runFullBacktest } from "./backtest.js";
import { calcStrength, rankCurrencies } from "./strength.js";
import { getHeatState, atrPercentile, getVolRegime } from "./volatility.js";
import { getRiskState } from "./risk.js";
import { cryptoFullScan, executeCryptoTopSignal, getCryptoState } from "./cryptoBrain.js";
import { getCryptoAccount, getCryptoPositions, closeCryptoPosition, getPaperStats } from "./cryptoPaper.js";
import { CRYPTO_INSTRUMENTS } from "./config.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// ── Helpers ───────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function json(res, status, data) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end",  () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
async function router(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "OPTIONS") { cors(res); res.writeHead(204); res.end(); return; }

  // Dashboard
  if (url.pathname === "/" || url.pathname === "/dashboard") {
    const htmlPath = resolve(__dir, "../public/dashboard.html");
    if (existsSync(htmlPath)) {
      cors(res); res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(htmlPath, "utf8"));
    } else {
      json(res, 200, { status: "JARVIS v2 running", hint: "GET /api/brain/state" });
    }
    return;
  }

  // ════ JARVIS BRAIN ENDPOINTS ════

  if (url.pathname === "/api/brain/scan") {
    try   { json(res, 200, await fullScan()); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/brain/execute" && req.method === "POST") {
    try   { json(res, 200, await executeTopSignal()); }
    catch (e) { json(res, 500, { executed: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/brain/state") {
    try {
      const cfg = await import("./config.js");
      json(res, 200, {
        state: getScanState(),
        config: {
          ...cfg.CONFIG,
          READ_ONLY:    cfg.READ_ONLY,
          DEMO_ENABLED: cfg.DEMO_ENABLED,
        },
      });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/brain/account") {
    try   { json(res, 200, await getAccountSummary()); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url.pathname === "/api/brain/positions") {
    try   { json(res, 200, { trades: await getOpenTrades() }); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url.pathname === "/api/brain/strength") {
    try {
      const candles = await getMultiCandles(INSTRUMENTS, "H1", CONFIG.strengthLookback + 2);
      const strength = calcStrength(candles, CONFIG.strengthLookback);
      json(res, 200, { strength, ranked: rankCurrencies(strength) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url.pathname === "/api/brain/kill" && req.method === "POST") {
    try {
      const positions = await getOpenTrades();
      const results = await Promise.allSettled(
        [...new Set(positions.map((p) => p.instrument))].map(closeAllPositions)
      );
      json(res, 200, { killed: results.length, results: results.map((r) => r.status) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url.pathname === "/api/news/calendar") {
    try {
      const events = await fetchEconomicCalendar();
      json(res, 200, { ok: true, count: events.length, events: events.slice(0, 50) });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/news/headlines") {
    try {
      const headlines = await fetchHeadlines();
      const tagged = headlines.slice(0, 20).map(h => ({ ...h, category: categorizeHeadline(h.title) }));
      json(res, 200, { ok: true, count: tagged.length, headlines: tagged });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/news/analysis") {
    try {
      const headlines = await fetchHeadlines();
      const analysis  = await analyzeHeadlinesWithClaude(headlines);
      const tagged    = headlines.slice(0, 15).map((h, i) => ({
        ...h,
        category:  categorizeHeadline(h.title),
        analysis:  analysis.find(a => a.index === i + 1) || null,
      }));
      json(res, 200, { ok: true, count: tagged.length, headlines: tagged });
    } catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/news/upcoming") {
    const inst = url.searchParams.get("instrument") || "USD_JPY";
    try   { json(res, 200, { ok: true, instrument: inst, events: await getRelevantEvents(inst, 180) }); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/backtest/run" && req.method === "POST") {
    try   { json(res, 200, await runBacktest(await readBody(req))); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/backtest/full" && req.method === "POST") {
    try   { json(res, 200, await runFullBacktest(await readBody(req))); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/brain/risk") {
    try   { json(res, 200, { risk: getRiskState(), heat: getHeatState() }); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url.pathname === "/api/brain/volatility") {
    try {
      const candles = await getMultiCandles(INSTRUMENTS, "H1", 120);
      const result  = {};
      for (const inst of INSTRUMENTS) {
        const c = candles[inst];
        if (!c || c.length < 20) continue;
        const pct = atrPercentile(c, 100);
        result[inst] = { atrPercentile: pct, ...getVolRegime(pct) };
      }
      json(res, 200, { ok: true, volatility: result });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ════ CRYPTO ENDPOINTS ════

  if (url.pathname === "/api/crypto/scan") {
    try   { json(res, 200, await cryptoFullScan()); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/crypto/execute" && req.method === "POST") {
    try   { json(res, 200, await executeCryptoTopSignal()); }
    catch (e) { json(res, 500, { executed: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/crypto/state") {
    try   { json(res, 200, getCryptoState()); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
    return;
  }

  if (url.pathname === "/api/crypto/positions") {
    try   { json(res, 200, { trades: await getCryptoPositions() }); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (url.pathname === "/api/crypto/account") {
    try   { json(res, 200, await getCryptoAccount()); }
    catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ════ BROKER STATUS ════

  if (url.pathname === "/api/brokers/status") {
    const t0 = Date.now();
    const [oandaRes, paperRes] = await Promise.allSettled([
      getAccountSummary(),
      getCryptoAccount(),
    ]);
    const oandaOk = oandaRes.status === 'fulfilled';
    const paperOk = paperRes.status === 'fulfilled';
    json(res, 200, {
      oanda: {
        connected:  oandaOk,
        account:    oandaOk ? oandaRes.value : null,
        error:      oandaOk ? null : oandaRes.reason?.message,
        env:        OANDA_ENV,
        accountId:  OANDA_ACCT ? OANDA_ACCT.slice(0, 3) + '…' + OANDA_ACCT.slice(-4) : '—',
        pingMs:     Date.now() - t0,
      },
      crypto: {
        connected:  paperOk,
        account:    paperOk ? paperRes.value : null,
        error:      paperOk ? null : paperRes.reason?.message,
        mode:       'paper',
        stats:      getPaperStats(),
        pingMs:     Date.now() - t0,
      },
    });
    return;
  }

  if (url.pathname === "/api/crypto/kill" && req.method === "POST") {
    try {
      const positions = await getCryptoPositions();
      const results = await Promise.allSettled(
        [...new Set(positions.map(p => p.instrument))].map(closeCryptoPosition)
      );
      json(res, 200, { killed: results.length, results: results.map(r => r.status) });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  json(res, 404, { error: "Not found", available: [
    "GET /api/brain/scan", "POST /api/brain/execute", "GET /api/brain/state",
    "GET /api/brain/account", "GET /api/brain/positions", "GET /api/brain/strength",
    "GET /api/brain/risk", "GET /api/brain/volatility",
    "POST /api/brain/kill", "GET /api/news/calendar", "GET /api/news/upcoming",
    "POST /api/backtest/run", "POST /api/backtest/full",
  ]});
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const t = Date.now();
  try { await router(req, res); }
  catch (e) { if (!res.headersSent) json(res, 500, { error: "Internal error" }); }
  process.stdout.write(`${req.method} ${req.url} → ${res.statusCode} (${Date.now()-t}ms)\n`);
});

server.listen(PORT, () => {
  console.log(`
  ╔═══════════════════════════════════════════════╗
  ║   JARVIS Trading OS v2  —  http://localhost:${PORT}  ║
  ╠═══════════════════════════════════════════════╣
  ║  READ_ONLY=${String(process.env.JARVIS_READ_ONLY ?? "true").padEnd(5)}  DEMO=${String(process.env.DEMO_TRADING_ENABLED ?? "false").padEnd(5)}        ║
  ╚═══════════════════════════════════════════════╝
`);
});

// Auto-scan + auto-execute: Forex every 60s, Crypto every 90s (offset by 30s)
// Both loops drain ALL signals found per cycle, not just the top one.
setInterval(async () => {
  try {
    const result = await fullScan();
    if (!result?.signals?.length) return;
    let execCount = 0;
    while (true) {
      const exec = await executeTopSignal();
      if (!exec.executed) break;
      execCount++;
      process.stdout.write(`[FOREX AUTO #${execCount}] ${exec.instrument} ${exec.direction} ${exec.units}u @ ${exec.entry} (${exec.strategy} ${exec.confidence}%)\n`);
    }
    if (!execCount) process.stdout.write(`[FOREX] ${result.signals.length} signals, none executed\n`);
  } catch (e) { process.stdout.write(`[FOREX AUTO] Error: ${e.message}\n`); }
}, 60_000);

setTimeout(() => {
  setInterval(async () => {
    try {
      const result = await cryptoFullScan();
      if (!result?.signals?.length) return;
      let execCount = 0;
      while (true) {
        const exec = await executeCryptoTopSignal();
        if (!exec.executed) break;
        execCount++;
        process.stdout.write(`[CRYPTO AUTO #${execCount}] ${exec.instrument} ${exec.direction} ${exec.units} @ ${exec.entry} (${exec.strategy} ${exec.confidence}%)\n`);
      }
      if (!execCount) process.stdout.write(`[CRYPTO] ${result.signals.length} signals, none executed\n`);
    } catch (e) { process.stdout.write(`[CRYPTO AUTO] Error: ${e.message}\n`); }
  }, 90_000);
}, 30_000);  // offset 30s from forex scan
