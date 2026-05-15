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
import { PORT, INSTRUMENTS } from "./config.js";
import { fullScan, executeTopSignal, getScanState } from "./brain.js";
import { getAccountSummary, getOpenTrades, closeAllPositions, getMultiCandles } from "./oanda.js";
import { fetchEconomicCalendar, getRelevantEvents } from "./news.js";
import { runBacktest, runFullBacktest } from "./backtest.js";
import { calcStrength, rankCurrencies } from "./strength.js";
import { getHeatState, atrPercentile, getVolRegime } from "./volatility.js";
import { getRiskState } from "./risk.js";

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
    try   { json(res, 200, { state: getScanState(), config: (await import("./config.js")).CONFIG }); }
    catch (e) { json(res, 500, { ok: false, error: e.message }); }
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
      const candles = await getMultiCandles(INSTRUMENTS, "H1", 30);
      const strength = calcStrength(candles);
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

// Auto-scan every 60s
setInterval(async () => {
  try { await fullScan(); } catch { /* logged individually */ }
}, 60_000);
