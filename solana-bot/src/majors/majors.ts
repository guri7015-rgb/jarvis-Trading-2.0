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

export interface MajorPlan {
  product: string;
  /** HOURLY: hold hours to a day. DAILY: hold days to weeks (swing). */
  timeframe: "HOURLY" | "DAILY";
  side: "LONG" | "SHORT" | "NONE";
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
export function evaluateMajor(product: string, candles: Candle[], now: number, usdCad: number, riskCad: number, r: MajorsRules = DEFAULT_MAJORS_RULES, timeframe: "HOURLY" | "DAILY" = "HOURLY"): MajorPlan | null {
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
  if (side === "NONE") reasons.push(`inside the ${r.lookback}${unit} range ${lo.toFixed(2)}–${hi.toFixed(2)}`);
  if (side !== "NONE" && volumeRatio < r.minVolumeRatio) reasons.push(`volume only ${volumeRatio.toFixed(1)}x the ${r.lookback}${unit} average (need ${r.minVolumeRatio}x)`);
  const level = side === "SHORT" ? lo : hi;
  const stopDist = r.atrStopMult * a;
  const stop = side === "SHORT" ? last.close + stopDist : last.close - stopDist;
  const target = side === "SHORT" ? last.close - r.rewardMult * stopDist : last.close + r.rewardMult * stopDist;
  const riskUsd = riskCad / usdCad;
  const units = stopDist > 0 ? riskUsd / stopDist : 0;
  return {
    product,
    timeframe,
    side: side !== "NONE" && volumeRatio < r.minVolumeRatio ? "NONE" : side,
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
    reasons: reasons.length ? reasons : [`closed ${side === "LONG" ? "above" : "below"} the ${r.lookback}${unit} ${side === "LONG" ? "high" : "low"} ${level.toFixed(2)} on ${volumeRatio.toFixed(1)}x volume`],
    ageH: Math.max(0, (now - (last.t + span)) / 3_600_000),
  };
}

export interface MarketMood {
  /** 24 h, 4 h and 1 h moves per product, from completed hourly candles. */
  moves: { product: string; ret1h: number | null; ret4h: number | null; ret24h: number | null; price: number | null }[];
  /** How many of the products are up over 24 h. */
  upCount: number;
  total: number;
  mood: "RISK ON" | "MIXED" | "RISK OFF" | "UNKNOWN";
  note: string;
}

/** A simple read of the big coins: most up over 24 h and BTC up is risk on; most down is risk off. */
export function marketMood(candlesByProduct: Map<string, Candle[]>): MarketMood {
  const moves = [...candlesByProduct].map(([product, c]) => {
    const last = c[c.length - 1];
    const back = (n: number) => (c.length > n ? c[c.length - 1 - n]!.close : null);
    const ret = (n: number) => (last && back(n) ? last.close / back(n)! - 1 : null);
    return { product, price: last?.close ?? null, ret1h: ret(1), ret4h: ret(4), ret24h: ret(24) };
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
        const plan = evaluateMajor(product, done, now, this.o.usdCad(), this.o.riskCad, this.o.rules, "HOURLY");
        if (plan) this.plans.set(`${product}:HOURLY`, plan);
        this.stats.polls++;
        this.stats.lastAt = now;
        // Daily candles once an hour: the swing plan.
        if (now - this.lastDailyPoll >= 3_600_000) {
          const dbody = await this.http.request({ provider: "coinbase", url: `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400`, schema: z.unknown(), maxRetries: 0, headers: { accept: "application/json" } });
          const ddone = parseCandles(dbody).filter((c) => c.t + 86_400_000 <= now);
          this.daily.set(product, ddone);
          const swing = evaluateMajor(product, ddone, now, this.o.usdCad(), this.o.riskCad, this.o.rules, "DAILY");
          if (swing) this.plans.set(`${product}:DAILY`, swing);
        }
      } catch (e) {
        this.stats.errors++;
        this.logger.warn("majors poll failed", { product, err: (e as Error).message });
      }
    }
    if (dailyDue) this.lastDailyPoll = now;
  }

  snapshot(): { plans: MajorPlan[]; market: MarketMood; stats: { polls: number; errors: number; lastAt: number } } {
    return { plans: [...this.plans.values()].sort((a, b) => (a.side === "NONE" ? 1 : 0) - (b.side === "NONE" ? 1 : 0) || a.ageH - b.ageH), market: marketMood(this.candles), stats: this.stats };
  }
}
