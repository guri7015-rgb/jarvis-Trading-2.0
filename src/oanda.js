import https from "https";
import { OANDA_HOST, OANDA_KEY, OANDA_ACCT, PRICE_DECIMALS } from "./config.js";

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: OANDA_HOST, path, method,
        headers: { Authorization: `Bearer ${OANDA_KEY}`, "Content-Type": "application/json", "Accept-Datetime-Format": "UNIX" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode >= 400) reject(new Error(`OANDA ${res.statusCode}: ${JSON.stringify(parsed).slice(0, 300)}`));
            else resolve(parsed);
          } catch (e) { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
        });
      },
    );
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const get   = (p)    => request("GET",   p);
const post  = (p, b) => request("POST",  p, b);
const put   = (p, b) => request("PUT",   p, b);

// ── Candles ───────────────────────────────────────────────────────────────────
export async function getCandles(instrument, granularity = "H1", count = 150) {
  const data = await get(`/v3/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=BA`);
  return (data.candles || []).filter((c) => c.complete).map((c) => ({
    time:   parseInt(c.time),
    open:   (parseFloat(c.mid?.o || c.ask?.o)),
    high:   (parseFloat(c.mid?.h || c.ask?.h)),
    low:    (parseFloat(c.mid?.l || c.bid?.l)),
    close:  (parseFloat(c.mid?.c || c.ask?.c)),
    bid:    c.bid ? parseFloat(c.bid.c) : null,
    ask:    c.ask ? parseFloat(c.ask.c) : null,
    spread: c.bid && c.ask ? parseFloat(c.ask.c) - parseFloat(c.bid.c) : null,
    volume: parseInt(c.volume),
  }));
}

export async function getMultiCandles(instruments, granularity, count) {
  const results = await Promise.allSettled(
    instruments.map((i) => getCandles(i, granularity, count).then((c) => [i, c]))
  );
  const map = {};
  for (const r of results) {
    if (r.status === "fulfilled") map[r.value[0]] = r.value[1];
  }
  return map;
}

// ── Pricing ───────────────────────────────────────────────────────────────────
export async function getPrices(instruments) {
  const data = await get(`/v3/accounts/${OANDA_ACCT}/pricing?instruments=${instruments.join(",")}`);
  const map = {};
  for (const p of (data.prices || [])) {
    map[p.instrument] = {
      bid:    parseFloat(p.bids[0].price),
      ask:    parseFloat(p.asks[0].price),
      mid:    (parseFloat(p.bids[0].price) + parseFloat(p.asks[0].price)) / 2,
      spread: parseFloat(p.asks[0].price) - parseFloat(p.bids[0].price),
    };
  }
  return map;
}

// ── Account ───────────────────────────────────────────────────────────────────
export async function getAccountSummary() {
  const { account: a } = await get(`/v3/accounts/${OANDA_ACCT}/summary`);
  return {
    id:           a.id,
    currency:     a.currency,
    balance:      parseFloat(a.balance),
    nav:          parseFloat(a.NAV),
    unrealizedPL: parseFloat(a.unrealizedPL),
    realizedPL:   parseFloat(a.pl),
    marginUsed:   parseFloat(a.marginUsed),
    marginAvail:  parseFloat(a.marginAvailable),
    openTrades:   parseInt(a.openTradeCount),
  };
}

export async function getOpenTrades() {
  const data = await get(`/v3/accounts/${OANDA_ACCT}/openTrades`);
  return (data.trades || []).map((t) => ({
    id:           t.id,
    instrument:   t.instrument,
    units:        parseFloat(t.currentUnits),
    direction:    parseFloat(t.currentUnits) > 0 ? "LONG" : "SHORT",
    openPrice:    parseFloat(t.price),
    unrealizedPL: parseFloat(t.unrealizedPL),
    openTime:     t.openTime,
    sl:           t.stopLossOrder   ? parseFloat(t.stopLossOrder.price)   : null,
    tp:           t.takeProfitOrder ? parseFloat(t.takeProfitOrder.price) : null,
    clientComment: t.clientExtensions?.comment || "",
  }));
}

export async function getClosedTrades(count = 20) {
  const data = await get(`/v3/accounts/${OANDA_ACCT}/trades?state=CLOSED&count=${count}`);
  return (data.trades || []).map((t) => ({
    id:           t.id,
    instrument:   t.instrument,
    units:        parseFloat(t.initialUnits),
    openPrice:    parseFloat(t.price),
    closePrice:   parseFloat(t.averageClosePrice || t.price),
    realizedPL:   parseFloat(t.realizedPL),
    openTime:     t.openTime,
    closeTime:    t.closeTime,
  }));
}

// ── Orders ────────────────────────────────────────────────────────────────────
export async function placeOrder(instrument, units, sl, tp, comment = "") {
  const dec = PRICE_DECIMALS[instrument] || 5;
  const body = {
    order: {
      type: "MARKET",
      instrument,
      units: String(Math.round(units)),
      timeInForce: "FOK",
      stopLossOnFill:   { price: sl.toFixed(dec), timeInForce: "GTC" },
      takeProfitOnFill: { price: tp.toFixed(dec), timeInForce: "GTC" },
      clientExtensions: { comment: comment.slice(0, 128) },
    },
  };
  return post(`/v3/accounts/${OANDA_ACCT}/orders`, body);
}

export async function closeAllPositions(instrument) {
  return put(`/v3/accounts/${OANDA_ACCT}/positions/${instrument}/close`, {
    longUnits: "ALL", shortUnits: "ALL",
  });
}
