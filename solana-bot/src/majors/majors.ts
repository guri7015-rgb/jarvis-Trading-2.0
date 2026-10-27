/**
 * Majors desk: long / short momentum plans on large coins from hourly candles.
 *
 * Data: Coinbase Exchange public market data (no key, no account). Rule:
 * Donchian breakout. A close above the highest high of the last N completed
 * hours with volume above its average is a LONG plan; below the lowest low,
 * a SHORT plan. Stop at 2 x ATR(14) from entry, target at 2 x the stop
 * distance, invalid once price closes back inside the range. A plan is a
 * suggestion for a person with an exchange account; nothing here trades.
 *
 * "Short" assumes you can short on your venue. If you cannot, read a SHORT
 * plan as "do not be long".
 */
import { z } from "zod";
import type { Clock } from "../core/clock.ts";
import type { Logger } from "../core/log.ts";
import type { HttpClient } from "../net/http.ts";

export const DEFAULT_PRODUCTS = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "DOGE-USD", "ADA-USD", "AVAX-USD", "LINK-USD"];

export interface Candle {
  t: number;
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
}

export interface MajorsRules {
  lookback: number;
  atrPeriod: number;
  atrStopMult: number;
  rewardMult: number;
  minVolumeRatio: number;
}

export const DEFAULT_MAJORS_RULES: MajorsRules = { lookback: 20, atrPeriod: 14, atrStopMult: 2, rewardMult: 2, minVolumeRatio: 1.3 };

export type Direction = "UP" | "DOWN" | "FLAT";

/** Which way each timeframe leans: close against its 20-period average and the average's slope. */
export interface Bias {
  daily: Direction;
  h4: Direction;
  h1: Direction;
}

export interface MajorPlan {
  product: string;
  /** HOURLY: hold hours to a day. DAILY: hold days to weeks (swing). */
  timeframe: "HOURLY" | "DAILY";
  /** BREAKOUT: the range just ended. RANGE: the range is holding; buy its bottom or sell its top. */
  kind: "BREAKOUT" | "RANGE";
  side: "LONG" | "SHORT" | "NONE";
  /** Three targets at 1x, 2x and 3x the stop distance (RANGE: mid, far side, beyond). */
  targets: number[];
  bias: Bias | null;
  /** true: the plan goes with the daily bias; false: against it; null: daily is flat or unknown. */
  withBias: boolean | null;
  at: number;
  price: number;
  /** Breakout level that was cleared. */
  level: number;
  entryZoneLow: number;
  entryZoneHigh: number;
  stop: number;
  target: number;
  stopPct: number;
  targetPct: number;
  atr: number;
  volumeRatio: number;
  /** Units to hold so a stop costs CAD `riskCad`. */
  sizeForRiskCad: { riskCad: number; units: number; notionalUsd: number };
  reasons: string[];
  /** Hours since the breakout candle closed. */
  ageH: number;
}

const CandleRow = z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]);
const CandlesSchema = z.array(CandleRow).max(400);

export function parseCandles(body: unknown): Candle[] {
  const rows = CandlesSchema.parse(body);
  return rows.map(([t, low, high, open, close, volume]) => ({ t: t * 1000, low, high, open, close, volume })).sort((a, b) => a.t - b.t);
}

function direction(c: Candle[], period = 20): Direction {
  if (c.length < period + 3) return "FLAT";
  const sma = (end: number) => c.slice(end - period, end).reduce((s, x) => s + x.close, 0) / period;
  const now = sma(c.length);
  const before = sma(c.length - 3);
  const last = c[c.length - 1]!.close;
  const slope = now / before - 1;
  if (last > now && slope > 0.0005) return "UP";
  if (last < now && slope < -0.0005) return "DOWN";
  return "FLAT";
}

/** Group hourly candles into 4-hour candles (aligned to the newest hour). */
export function toFourHour(hourly: Candle[]): Candle[] {
  const out: Candle[] = [];
  for (let end = hourly.length; end - 4 >= 0; end -= 4) {
    const g = hourly.slice(end - 4, end);
    out.unshift({ t: g[0]!.t, open: g[0]!.open, close: g[3]!.close, high: Math.max(...g.map((x) => x.high)), low: Math.min(...g.map((x) => x.low)), volume: g.reduce((s, x) => s + x.volume, 0) });
  }
  return out;
}

export function computeBias(hourly: Candle[], daily: Candle[]): Bias {
  // 4 h bars: a shorter average, since 300 hourly candles give only 75 of them.
  return { daily: direction(daily), h4: direction(toFourHour(hourly), 10), h1: direction(hourly) };
}

function withBiasOf(side: MajorPlan["side"], bias: Bias | null): boolean | null {
  if (!bias || side === "NONE" || bias.daily === "FLAT") return null;
  return (side === "LONG") === (bias.daily === "UP");
}

/** Prices in sentences: 2 decimals above 1, 4 below. */
const fp = (x: number) => (x >= 1 ? x.toFixed(2) : x.toFixed(4));

export function atr(c: Candle[], period: number): number | null {
  if (c.length < period + 1) return null;
  let sum = 0;
  for (let i = c.length - period; i < c.length; i++) {
    const cur = c[i]!;
    const prev = c[i - 1]!;
    sum += Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
  }
  return sum / period;
}

/**
 * Evaluate the latest COMPLETED candle against the N before it.
 * `candles` oldest first; the last element is treated as the latest completed hour.
 */
export function evaluateMajor(product: string, candles: Candle[], now: number, usdCad: number, riskCad: number, r: MajorsRules = DEFAULT_MAJORS_RULES, timeframe: "HOURLY" | "DAILY" = "HOURLY", bias: Bias | null = null): MajorPlan | null {
  const span = timeframe === "DAILY" ? 86_400_000 : 3_600_000;
  const unit = timeframe === "DAILY" ? "d" : "h";
  if (candles.length < r.lookback + r.atrPeriod + 2) return null;
  const last = candles[candles.length - 1]!;
  const prior = candles.slice(candles.length - 1 - r.lookback, candles.length - 1);
  const hi = Math.max(...prior.map((c) => c.high));
  const lo = Math.min(...prior.map((c) => c.low));
  const avgVol = prior.reduce((s, c) => s + c.volume, 0) / prior.length;
  const volumeRatio = avgVol > 0 ? last.volume / avgVol : 0;
  const a = atr(candles, r.atrPeriod);
  if (a === null) return null;
  const side: MajorPlan["side"] = last.close > hi ? "LONG" : last.close < lo ? "SHORT" : "NONE";
  const reasons: string[] = [];
  if (side === "NONE") reasons.push(`inside the ${r.lookback}${unit} range ${fp(lo)}–${fp(hi)}`);
  if (side !== "NONE" && volumeRatio < r.minVolumeRatio) reasons.push(`volume only ${volumeRatio.toFixed(1)}x the ${r.lookback}${unit} average (need ${r.minVolumeRatio}x)`);
  const level = side === "SHORT" ? lo : hi;
  const stopDist = r.atrStopMult * a;
  const stop = side === "SHORT" ? last.close + stopDist : last.close - stopDist;
  const target = side === "SHORT" ? last.close - r.rewardMult * stopDist : last.close + r.rewardMult * stopDist;
  const riskUsd = riskCad / usdCad;
  const units = stopDist > 0 ? riskUsd / stopDist : 0;
  const finalSide: MajorPlan["side"] = side !== "NONE" && volumeRatio < r.minVolumeRatio ? "NONE" : side;
  const dir = side === "SHORT" ? -1 : 1;
  return {
    product,
    timeframe,
    kind: "BREAKOUT",
    side: finalSide,
    targets: [1, 2, 3].map((k) => last.close + dir * k * stopDist),
    bias,
    withBias: withBiasOf(finalSide, bias),
    at: last.t + span,
    price: last.close,
    level,
    entryZoneLow: side === "SHORT" ? last.close - 0.25 * a : Math.min(last.close, level),
    entryZoneHigh: side === "SHORT" ? Math.max(last.close, level) : last.close + 0.25 * a,
    stop,
    target,
    stopPct: (stopDist / last.close) * 100,
    targetPct: ((r.rewardMult * stopDist) / last.close) * 100,
    atr: a,
    volumeRatio,
    sizeForRiskCad: { riskCad, units, notionalUsd: units * last.close },
    reasons: reasons.length ? reasons : [`closed ${side === "LONG" ? "above" : "below"} the ${r.lookback}${unit} ${side === "LONG" ? "high" : "low"} ${fp(level)} on ${volumeRatio.toFixed(1)}x volume`],
    ageH: Math.max(0, (now - (last.t + span)) / 3_600_000),
  };
}

/**
 * Range plan for a flat market: price in the bottom fifth of the last N hours'
 * range is a LONG with the stop just under the range; top fifth is a SHORT.
 * Targets: the middle, the far side, and one range-height beyond. Only
 * offered when the first target pays at least the stop distance.
 */
export function evaluateRange(product: string, candles: Candle[], now: number, usdCad: number, riskCad: number, bias: Bias | null, r: MajorsRules = DEFAULT_MAJORS_RULES): MajorPlan | null {
  if (candles.length < r.lookback + r.atrPeriod + 2) return null;
  const last = candles[candles.length - 1]!;
  const win = candles.slice(candles.length - r.lookback);
  const hi = Math.max(...win.map((c) => c.high));
  const lo = Math.min(...win.map((c) => c.low));
  const a = atr(candles, r.atrPeriod);
  if (a === null || hi <= lo) return null;
  const range = hi - lo;
  const pos = (last.close - lo) / range;
  const side: MajorPlan["side"] = pos <= 0.2 ? "LONG" : pos >= 0.8 ? "SHORT" : "NONE";
  if (side === "NONE") return null;
  const dir = side === "LONG" ? 1 : -1;
  const stop = side === "LONG" ? lo - 0.5 * a : hi + 0.5 * a;
  const stopDist = Math.abs(last.close - stop);
  const mid = lo + range / 2;
  const targets = side === "LONG" ? [mid, hi, hi + range * 0.5] : [mid, lo, lo - range * 0.5];
  if (Math.abs(targets[0]! - last.close) < stopDist) return null; // not worth it
  const riskUsd = riskCad / usdCad;
  const units = stopDist > 0 ? riskUsd / stopDist : 0;
  return {
    product,
    timeframe: "HOURLY",
    kind: "RANGE",
    side,
    targets,
    bias,
    withBias: withBiasOf(side, bias),
    at: last.t + 3_600_000,
    price: last.close,
    level: side === "LONG" ? lo : hi,
    entryZoneLow: side === "LONG" ? lo : last.close,
    entryZoneHigh: side === "LONG" ? last.close : hi,
    stop,
    target: targets[1]!,
    stopPct: (stopDist / last.close) * 100,
    targetPct: (Math.abs(targets[1]! - last.close) / last.close) * 100,
    atr: a,
    volumeRatio: 0,
    sizeForRiskCad: { riskCad, units, notionalUsd: units * last.close },
    reasons: [`price is in the ${side === "LONG" ? "bottom" : "top"} fifth of the ${r.lookback}h range ${fp(lo)}–${fp(hi)} and the range is holding`],
    ageH: Math.max(0, (now - (last.t + 3_600_000)) / 3_600_000),
  };
}

export interface MarketMood {
  /** 24 h, 4 h and 1 h moves per product, from completed hourly candles. */
  moves: { product: string; ret1h: number | null; ret4h: number | null; ret24h: number | null; price: number | null; bias: Bias | null }[];
  /** How many of the products are up over 24 h. */
  upCount: number;
  total: number;
  mood: "RISK ON" | "MIXED" | "RISK OFF" | "UNKNOWN";
  note: string;
}

/** A simple read of the big coins: most up over 24 h and BTC up is risk on; most down is risk off. */
export function marketMood(candlesByProduct: Map<string, Candle[]>, dailyByProduct: Map<string, Candle[]> = new Map()): MarketMood {
  const moves = [...candlesByProduct].map(([product, c]) => {
    const last = c[c.length - 1];
    const back = (n: number) => (c.length > n ? c[c.length - 1 - n]!.close : null);
    const ret = (n: number) => (last && back(n) ? last.close / back(n)! - 1 : null);
    const d = dailyByProduct.get(product);
    return { product, price: last?.close ?? null, ret1h: ret(1), ret4h: ret(4), ret24h: ret(24), bias: c.length >= 23 ? computeBias(c, d ?? []) : null };
  });
  const scored = moves.filter((m) => m.ret24h !== null);
  const upCount = scored.filter((m) => m.ret24h! > 0).length;
  const btc = moves.find((m) => m.product === "BTC-USD")?.ret24h ?? null;
  let mood: MarketMood["mood"] = "UNKNOWN";
  if (scored.length >= 4) {
    const share = upCount / scored.length;
    mood = share >= 0.7 && (btc ?? 0) > 0 ? "RISK ON" : share <= 0.3 ? "RISK OFF" : "MIXED";
  }
  const note = mood === "RISK ON" ? "Most big coins are up over 24 h. Buyers are in charge." : mood === "RISK OFF" ? "Most big coins are down over 24 h. Be careful with any long." : mood === "MIXED" ? "No clear direction across the big coins." : "Not enough candles yet.";
  return { moves, upCount, total: scored.length, mood, note };
}

export class MajorsDesk {
  private plans = new Map<string, MajorPlan>();
  private candles = new Map<string, Candle[]>();
  private daily = new Map<string, Candle[]>();
  private lastDailyPoll = 0;
  public stats = { polls: 0, errors: 0, lastAt: 0 };

  constructor(
    private readonly http: HttpClient,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly o: { products?: string[]; usdCad: () => number; riskCad: number; rules?: MajorsRules },
  ) {}

  async poll(): Promise<void> {
    const now = this.clock.now();
    const dailyDue = now - this.lastDailyPoll >= 3_600_000;
    for (const product of this.o.products ?? DEFAULT_PRODUCTS) {
      try {
        const body = await this.http.request({
          provider: "coinbase",
          url: `https://api.exchange.coinbase.com/products/${product}/candles?granularity=3600`,
          schema: z.unknown(),
          maxRetries: 0,
          headers: { accept: "application/json" },
        });
        const all = parseCandles(body);
        // The newest candle is the current, incomplete hour: drop it.
        const done = all.filter((c) => c.t + 3_600_000 <= now);
        this.candles.set(product, done);
        // Daily candles once an hour, fetched first so the bias is known before any plan is made.
        if (dailyDue) {
          const dbody = await this.http.request({ provider: "coinbase", url: `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400`, schema: z.unknown(), maxRetries: 0, headers: { accept: "application/json" } });
          this.daily.set(product, parseCandles(dbody).filter((c) => c.t + 86_400_000 <= now));
        }
        const ddone = this.daily.get(product) ?? [];
        const bias = computeBias(done, ddone);
        const plan = evaluateMajor(product, done, now, this.o.usdCad(), this.o.riskCad, this.o.rules, "HOURLY", bias);
        if (plan) this.plans.set(`${product}:HOURLY`, plan);
        // In a holding range, offer the range trade instead of nothing.
        const range = plan && plan.side === "NONE" ? evaluateRange(product, done, now, this.o.usdCad(), this.o.riskCad, bias, this.o.rules) : null;
        if (range) this.plans.set(`${product}:RANGE`, range);
        else this.plans.delete(`${product}:RANGE`);
        if (dailyDue) {
          const swing = evaluateMajor(product, ddone, now, this.o.usdCad(), this.o.riskCad, this.o.rules, "DAILY", bias);
          if (swing) this.plans.set(`${product}:DAILY`, swing);
        }
        this.stats.polls++;
        this.stats.lastAt = now;
      } catch (e) {
        this.stats.errors++;
        this.logger.warn("majors poll failed", { product, err: (e as Error).message });
      }
    }
    if (dailyDue) this.lastDailyPoll = now;
  }

  snapshot(): { plans: MajorPlan[]; market: MarketMood; stats: { polls: number; errors: number; lastAt: number } } {
    return { plans: [...this.plans.values()].sort((a, b) => (a.side === "NONE" ? 1 : 0) - (b.side === "NONE" ? 1 : 0) || a.ageH - b.ageH), market: marketMood(this.candles, this.daily), stats: this.stats };
  }
}
