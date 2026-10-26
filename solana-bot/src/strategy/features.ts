/**
 * Market features from a token's trade tape.
 *
 * Look-ahead guard: a trade is visible at decision time `now` only if it had
 * ARRIVED by then (receivedAt <= now). On-chain time is used for ordering and
 * windows, arrival time for availability. Replay uses the same rule.
 *
 * Prices are in SOL per whole token, from each trade's own amounts
 * (ONCHAIN_CONFIRMED events at "confirmed" commitment).
 */

export interface Trade {
  mint: string;
  signature: string;
  eventIndex: number;
  slot: number;
  blockTimeMs: number;
  receivedAt: number;
  side: "buy" | "sell";
  wallet: string;
  /** SOL, as a float for features (exact amounts live in the ledger). */
  quoteSol: number;
  priceSol: number;
  realQuoteSol?: number;
}

export interface DataQuality {
  ok: boolean;
  reasons: string[];
  trades180s: number;
  secondsSinceLastTrade: number | null;
  /** Median arrival delay behind on-chain time (s). On-chain time has 1 s precision. */
  medianLagS: number | null;
  inGap: boolean;
  /** Short reconnect blips in the window: not blocking, but data may be incomplete. */
  warnings: string[];
}

export interface Features {
  at: number;
  mint: string;
  last: number | null;
  ret30: number | null;
  ret60: number | null;
  ret180: number | null;
  trades30: number;
  trades60: number;
  tradesPrev30: number;
  /** trades in last 30 s / (trades in the 30 s before + 1) */
  rateAccel: number;
  buyers30: number;
  buyers60: number;
  /** Buyers in the last 30 s not seen at all in the 30–300 s before. */
  newBuyers30: number;
  sellers60: number;
  buyVol60: number;
  sellVol60: number;
  /** (buy − sell) / (buy + sell) volume over 60 s, −1..1 */
  imbalance60: number;
  /** Largest single wallet's share of buy volume over 60 s. */
  topBuyerShare60: number;
  /** Share of 60 s trades whose SOL size exactly repeats another trade's (bot fingerprint). */
  repeatedSizeRatio60: number;
  /** Std-dev of log returns between consecutive trades over 180 s. */
  vol180: number | null;
  high300: number | null;
  low300: number | null;
  /** Range high/low over [now−300 s, now−60 s]: the structure a breakout is measured against. */
  priorHigh: number | null;
  priorLow: number | null;
  /** Range over the last 60 s, as a fraction of price. */
  range60Pct: number | null;
  high60: number | null;
  low60: number | null;
  /** The consolidation "base": range over [now−60 s, now−10 s], excluding the latest move. */
  baseHigh: number | null;
  baseLow: number | null;
  high30: number | null;
  low30: number | null;
  /** Buyers in the last 10 s: is a move confirmed by more than one wallet? */
  buyers10: number;
  realQuoteSol: number | null;
  quality: DataQuality;
}

export interface QualityRules {
  minTrades180s: number;
  maxSecondsSinceLastTrade: number;
  maxMedianLagS: number;
  /**
   * A feed gap at least this long in the last 180 s blocks signals. Shorter
   * reconnect blips (the public RPC WebSocket drops about every 25 s for ~1 s)
   * are reported as a warning; the sparse-trades check still catches lost data.
   * Placeholder.
   */
  blockingGapMs: number;
}

export const DEFAULT_QUALITY: QualityRules = { minTrades180s: 20, maxSecondsSinceLastTrade: 30, maxMedianLagS: 10, blockingGapMs: 2_000 };

/** A size a person would type: at most 2 significant digits (0.01, 0.25, 1.5, 10). */
export function isRoundSize(sol: number): boolean {
  if (!(sol > 0)) return true;
  const digits = Number(sol.toPrecision(2));
  return Math.abs(digits - sol) / sol < 1e-6;
}

const median = (a: number[]) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)]!;
};

/** Visible trades, oldest first (slot, then event order). */
export function visible(trades: Trade[], now: number): Trade[] {
  return trades.filter((t) => t.receivedAt <= now).sort((a, b) => a.slot - b.slot || a.blockTimeMs - b.blockTimeMs || a.eventIndex - b.eventIndex);
}

/** Last price at or before time t (on-chain time). */
function priceAt(ts: Trade[], t: number): number | null {
  let p: number | null = null;
  for (const x of ts) {
    if (x.blockTimeMs > t) break;
    p = x.priceSol;
  }
  return p;
}

export function computeFeatures(mint: string, all: Trade[], now: number, gaps: { from: number; to: number }[] = [], rules: QualityRules = DEFAULT_QUALITY): Features {
  const ts = visible(all, now);
  const last = ts.length ? ts[ts.length - 1]!.priceSol : null;
  const lastChain = ts.length ? ts[ts.length - 1]!.blockTimeMs : null;
  // Windows are anchored to "now" in chain-time terms. Arrival lag means the
  // newest visible trade is a little older than now; that lag is reported, not hidden.
  const inWin = (from: number, to = 0) => ts.filter((t) => t.blockTimeMs > now - from && t.blockTimeMs <= now - to);
  const w30 = inWin(30_000);
  const w60 = inWin(60_000);
  const prev30 = inWin(60_000, 30_000);
  const w180 = inWin(180_000);
  const w300 = inWin(300_000);
  const before30 = inWin(300_000, 30_000);
  const prior = inWin(300_000, 60_000);
  const base = inWin(60_000, 10_000);
  const w10 = inWin(10_000);

  const ret = (ms: number) => {
    const ref = priceAt(ts, now - ms);
    return ref && last ? last / ref - 1 : null;
  };
  const buyers = (w: Trade[]) => new Set(w.filter((t) => t.side === "buy").map((t) => t.wallet));
  const b30 = buyers(w30);
  const seenBefore = new Set(before30.map((t) => t.wallet));
  const buyVol60 = w60.filter((t) => t.side === "buy").reduce((s, t) => s + t.quoteSol, 0);
  const sellVol60 = w60.filter((t) => t.side === "sell").reduce((s, t) => s + t.quoteSol, 0);
  const byBuyer = new Map<string, number>();
  for (const t of w60) if (t.side === "buy") byBuyer.set(t.wallet, (byBuyer.get(t.wallet) ?? 0) + t.quoteSol);
  // Bot fingerprint: the same NON-ROUND size from several different wallets within 60 s.
  // Round sizes (0.01, 0.5, 1 SOL) repeat naturally across humans and are not counted.
  const walletsBySize = new Map<string, Set<string>>();
  for (const t of w60) {
    if (isRoundSize(t.quoteSol)) continue;
    const k = t.quoteSol.toFixed(6);
    (walletsBySize.get(k) ?? walletsBySize.set(k, new Set()).get(k)!).add(t.wallet);
  }
  const repeated = w60.filter((t) => !isRoundSize(t.quoteSol) && (walletsBySize.get(t.quoteSol.toFixed(6))?.size ?? 0) >= 2).length;
  const lr: number[] = [];
  for (let i = 1; i < w180.length; i++) lr.push(Math.log(w180[i]!.priceSol / w180[i - 1]!.priceSol));
  const mean = lr.length ? lr.reduce((a, b) => a + b, 0) / lr.length : 0;
  const vol180 = lr.length > 2 ? Math.sqrt(lr.reduce((s, x) => s + (x - mean) ** 2, 0) / (lr.length - 1)) : null;
  const hi = (w: Trade[]) => (w.length ? Math.max(...w.map((t) => t.priceSol)) : null);
  const lo = (w: Trade[]) => (w.length ? Math.min(...w.map((t) => t.priceSol)) : null);
  const high60 = hi(w60);
  const low60 = lo(w60);

  // Data quality: fail closed.
  const reasons: string[] = [];
  const sinceLast = lastChain === null ? null : (now - lastChain) / 1000;
  const lagS = median(w180.map((t) => (t.receivedAt - t.blockTimeMs) / 1000));
  const recentGaps = gaps.filter((g) => g.to > now - 180_000 && g.from < now);
  const inGap = recentGaps.some((g) => g.to - g.from >= rules.blockingGapMs);
  const warnings: string[] = [];
  if (!inGap && recentGaps.length) warnings.push(`${recentGaps.length} short feed blip(s) in the last 180s`);
  if (w180.length < rules.minTrades180s) reasons.push(`sparse: ${w180.length} trades in 180s < ${rules.minTrades180s}`);
  if (sinceLast === null || sinceLast > rules.maxSecondsSinceLastTrade) reasons.push(`stale: last trade ${sinceLast === null ? "never" : `${sinceLast.toFixed(0)}s ago`}`);
  if (lagS !== null && lagS > rules.maxMedianLagS) reasons.push(`feed lag ${lagS.toFixed(1)}s`);
  if (inGap) reasons.push(`feed gap >= ${rules.blockingGapMs / 1000}s in the last 180s`);

  return {
    at: now,
    mint,
    last,
    ret30: ret(30_000),
    ret60: ret(60_000),
    ret180: ret(180_000),
    trades30: w30.length,
    trades60: w60.length,
    tradesPrev30: prev30.length,
    rateAccel: w30.length / (prev30.length + 1),
    buyers30: b30.size,
    buyers60: buyers(w60).size,
    newBuyers30: [...b30].filter((w) => !seenBefore.has(w)).length,
    sellers60: new Set(w60.filter((t) => t.side === "sell").map((t) => t.wallet)).size,
    buyVol60,
    sellVol60,
    imbalance60: buyVol60 + sellVol60 > 0 ? (buyVol60 - sellVol60) / (buyVol60 + sellVol60) : 0,
    topBuyerShare60: buyVol60 > 0 ? Math.max(...byBuyer.values()) / buyVol60 : 0,
    repeatedSizeRatio60: w60.length ? repeated / w60.length : 0,
    vol180,
    high300: hi(w300),
    low300: lo(w300),
    priorHigh: hi(prior),
    priorLow: lo(prior),
    range60Pct: high60 && low60 ? (high60 - low60) / low60 : null,
    high60,
    low60,
    high30: hi(w30),
    low30: lo(w30),
    baseHigh: hi(base),
    baseLow: lo(base),
    buyers10: buyers(w10).size,
    realQuoteSol: ts.length ? (ts[ts.length - 1]!.realQuoteSol ?? null) : null,
    quality: { ok: reasons.length === 0, reasons, trades180s: w180.length, secondsSinceLastTrade: sinceLast, medianLagS: lagS, inGap, warnings },
  };
}

export interface Candle {
  start: number;
  open: number;
  high: number;
  low: number;
  close: number;
  trades: number;
  volumeSol: number;
  /** Fewer trades than the minimum: shape is not meaningful. */
  sparse: boolean;
}

/** Candles from the trade tape only. Empty intervals are omitted, never filled in. */
export function buildCandles(trades: Trade[], now: number, intervalMs: number, minTrades: number): Candle[] {
  const out = new Map<number, Candle>();
  for (const t of visible(trades, now)) {
    const start = Math.floor(t.blockTimeMs / intervalMs) * intervalMs;
    const c = out.get(start);
    if (!c) out.set(start, { start, open: t.priceSol, high: t.priceSol, low: t.priceSol, close: t.priceSol, trades: 1, volumeSol: t.quoteSol, sparse: false });
    else {
      c.high = Math.max(c.high, t.priceSol);
      c.low = Math.min(c.low, t.priceSol);
      c.close = t.priceSol;
      c.trades++;
      c.volumeSol += t.quoteSol;
    }
  }
  return [...out.values()].sort((a, b) => a.start - b.start).map((c) => ({ ...c, sparse: c.trades < minTrades }));
}
