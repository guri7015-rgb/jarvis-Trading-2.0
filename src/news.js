/**
 * Three-layer news intelligence:
 *   Layer 1 — Economic calendar (ForexFactory, free)
 *   Layer 2 — Breaking headlines (NewsAPI, optional)
 *   Layer 3 — AI interpretation (Claude, optional)
 *
 * Returns a decision: APPROVE | REDUCE | SKIP
 */
import https from "https";
import { ANTHROPIC_KEY, NEWS_API_KEY, CONFIG } from "./config.js";

const PAIR_CURRENCIES = {
  EUR_USD: ["EUR","USD"], GBP_USD: ["GBP","USD"], USD_JPY: ["USD","JPY"],
  USD_CHF: ["USD","CHF"], AUD_USD: ["AUD","USD"], USD_CAD: ["USD","CAD"],
  NZD_USD: ["NZD","USD"], XAU_USD: ["USD","XAU"],
};

// ── Util ──────────────────────────────────────────────────────────────────────
function fetchJson(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error("Timeout")); });
    req.on("error", reject);
  });
}

// ── Layer 1: Economic Calendar ────────────────────────────────────────────────
let _calendarCache = null;
let _calendarFetched = 0;

export async function fetchEconomicCalendar() {
  if (_calendarCache && Date.now() - _calendarFetched < 15 * 60_000)
    return _calendarCache;

  // Fetch both this week and next week in parallel
  const urls = [
    "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
    "https://nfs.faireconomy.media/ff_calendar_nextweek.json",
  ];

  try {
    const results = await Promise.allSettled(urls.map(u => fetchJson(u)));
    const raw = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);

    _calendarCache = raw
      .filter((e) => e.impact === "High" || e.impact === "Medium")
      .map((e) => {
        const timeStr = e.time && e.time !== "All Day" ? e.time : "12:00am";
        const ts = e.date ? new Date(`${e.date} ${timeStr} GMT`).getTime() : null;
        return {
          title:     e.title,
          currency:  e.country?.toUpperCase() || "???",
          impact:    e.impact,
          date:      e.date,
          time:      e.time || "All Day",
          actual:    e.actual || null,
          forecast:  e.forecast || "—",
          previous:  e.previous || "—",
          timestamp: ts && !isNaN(ts) ? ts : null,
        };
      })
      .filter((e) => e.timestamp)
      .sort((a, b) => a.timestamp - b.timestamp);
    _calendarFetched = Date.now();
    return _calendarCache;
  } catch {
    return _calendarCache || [];
  }
}

export async function getRelevantEvents(instrument = "USD_JPY", windowMinutes = 180) {
  const ccys = PAIR_CURRENCIES[instrument] || [];
  const events = await fetchEconomicCalendar();
  const now = Date.now();
  return events.filter((e) => {
    const diff = e.timestamp - now;
    return diff > -30 * 60_000 && diff < windowMinutes * 60_000 && ccys.includes(e.currency);
  });
}

async function isCalendarBlocked(instrument) {
  const events = await getRelevantEvents(instrument, CONFIG.newsHaltMinutesBefore);
  return events.some((e) => e.impact === "High");
}

// ── Layer 2: Breaking News ────────────────────────────────────────────────────
const CURRENCY_KEYWORDS = {
  USD: ["federal reserve","fed","dollar","US economy","FOMC","powell"],
  EUR: ["ECB","euro","european","lagarde","eurozone"],
  GBP: ["BOE","pound","sterling","bank of england","UK economy","bailey"],
  JPY: ["BOJ","yen","bank of japan","ueda","japan"],
  CHF: ["SNB","swiss franc","swiss national bank"],
  AUD: ["RBA","australian dollar","australia","reserve bank"],
  CAD: ["BOC","canadian dollar","bank of canada","oil","macklem"],
  NZD: ["RBNZ","new zealand dollar","orr"],
  XAU: ["gold","precious metals","inflation","safe haven"],
};

let _headlinesCache = {};
let _headlinesFetched = 0;

export async function fetchHeadlines() {
  if (!NEWS_API_KEY) return [];
  if (Date.now() - _headlinesFetched < 5 * 60_000) return _headlinesCache;

  try {
    const url = `https://newsapi.org/v2/top-headlines?category=business&language=en&pageSize=20&apiKey=${NEWS_API_KEY}`;
    const data = await fetchJson(url);
    _headlinesCache = (data.articles || []).map((a) => ({
      title:     a.title || "",
      source:    a.source?.name || "",
      published: a.publishedAt,
    }));
    _headlinesFetched = Date.now();
    return _headlinesCache;
  } catch {
    return _headlinesCache || [];
  }
}

async function getRelevantHeadlines(instrument) {
  const ccys = PAIR_CURRENCIES[instrument] || [];
  const all  = await fetchHeadlines();
  const keywords = ccys.flatMap((c) => CURRENCY_KEYWORDS[c] || []);
  return all.filter((h) => keywords.some((k) => h.title.toLowerCase().includes(k)));
}

// ── Layer 3: Claude AI veto ───────────────────────────────────────────────────
async function aiNewsVeto(signal, calendarEvents, headlines) {
  if (!ANTHROPIC_KEY) return { decision: "APPROVE", reasoning: "No AI key — calendar-only filter applied" };

  const eventsText = calendarEvents.length
    ? calendarEvents.map((e) => `[${e.impact}] ${e.currency} — ${e.title} at ${e.time} (${Math.round((e.timestamp - Date.now()) / 60_000)}min)`).join("\n")
    : "No scheduled events";
  const headlinesText = headlines.length
    ? headlines.slice(0, 5).map((h) => `• ${h.title}`).join("\n")
    : "No relevant headlines";

  const prompt = `You are a risk manager at a forex trading desk.

Signal: ${signal.instrument} ${signal.direction} @ ${signal.entry?.toFixed(5)}
Strategy: ${signal.strategy} | Confidence: ${signal.confidence}
Reasoning: ${signal.reasoning}

Upcoming economic events (next 3h):
${eventsText}

Recent relevant headlines:
${headlinesText}

Should we execute, reduce size, or skip this trade based on news risk?

Respond ONLY with JSON (no extra text):
{"decision": "APPROVE" | "REDUCE" | "SKIP", "sizeMult": 1.0 | 0.5 | 0.25, "reasoning": "<1 sentence>"}`;

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({ apiKey: ANTHROPIC_KEY });
    const msg = await Promise.race([
      client.messages.create({
        model: CONFIG.aiModel, max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("AI timeout")), CONFIG.aiTimeout)),
    ]);
    let raw = msg.content[0].text.trim();
    if (raw.startsWith("```")) raw = raw.split("```")[1].replace(/^json/, "");
    return JSON.parse(raw);
  } catch (e) {
    return { decision: "APPROVE", sizeMult: 1.0, reasoning: `AI unavailable (${e.message}) — defaulting to APPROVE` };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function evaluateSignal(signal) {
  // Layer 1 — hard calendar block
  const calBlocked = await isCalendarBlocked(signal.instrument);
  if (calBlocked)
    return { decision: "SKIP", sizeMult: 0, reasoning: "High-impact event imminent — calendar block" };

  const calEvents  = await getRelevantEvents(signal.instrument, CONFIG.newsHaltMinutesBefore * 3);
  const headlines  = await getRelevantHeadlines(signal.instrument);

  // Layer 2 — if no AI key, just use calendar
  if (!ANTHROPIC_KEY) {
    const decision = calEvents.some((e) => e.impact === "High") ? "REDUCE" : "APPROVE";
    return { decision, sizeMult: decision === "REDUCE" ? 0.5 : 1.0, reasoning: "Calendar-only filter" };
  }

  // Layer 3 — Claude veto
  return aiNewsVeto(signal, calEvents, headlines);
}
