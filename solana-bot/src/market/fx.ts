/**
 * SOL → CAD conversion, kept separate from on-chain SOL accounting.
 *
 * SOL/USD: Jupiter Price v3 (last on-chain swap price, PROVIDER_REPORTED).
 * USD/CAD: Bank of Canada Valet API, daily rate (official, PROVIDER_REPORTED).
 * SOL/CAD = product of both, DERIVED, with both timestamps kept.
 *
 * Fails closed: a stale input means no CAD value, never a guessed one.
 */
import { z } from "zod";
import type { HttpClient } from "../net/http.ts";
import { MINTS } from "../solana/programs.ts";

export const BOC_USDCAD_URL = "https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=5";
export const JUP_PRICE_URL = `https://api.jup.ag/price/v3?ids=${MINTS.WSOL}`;

const BocSchema = z.object({
  observations: z
    .array(z.object({ d: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), FXUSDCAD: z.object({ v: z.string().regex(/^\d+(\.\d+)?$/) }).optional() }))
    .max(50),
});
const PriceSchema = z.record(
  z.string().max(60),
  z.object({ usdPrice: z.number().finite().positive(), blockId: z.number().int().nullable().optional() }).nullable(),
);

export interface FxQuote {
  solCad: number;
  solUsd: number;
  usdCad: number;
  /** When the SOL/USD price was fetched (ms). */
  solUsdAt: number;
  /** Bank of Canada observation date (YYYY-MM-DD). */
  usdCadDate: string;
  evidence: "DERIVED";
}

export class FxError extends Error {}

export interface FxOptions {
  /** Max age of the BoC observation. Weekends and holidays mean up to ~4 days is normal. */
  maxUsdCadAgeDays: number;
  solUsdCacheMs: number;
  usdCadCacheMs: number;
  apiKey?: string;
}

export class FxService {
  constructor(
    private readonly http: HttpClient,
    private readonly now: () => number,
    private readonly o: FxOptions = { maxUsdCadAgeDays: 5, solUsdCacheMs: 60_000, usdCadCacheMs: 6 * 3_600_000 },
  ) {}

  async usdCad(): Promise<{ rate: number; date: string }> {
    const body = await this.http.request({ provider: "bankofcanada", url: BOC_USDCAD_URL, schema: BocSchema, cacheTtlMs: this.o.usdCadCacheMs });
    const obs = body.observations.filter((o) => o.FXUSDCAD).sort((a, b) => (a.d < b.d ? 1 : -1))[0];
    if (!obs?.FXUSDCAD) throw new FxError("no USD/CAD observation");
    const ageDays = (this.now() - Date.parse(`${obs.d}T00:00:00Z`)) / 86_400_000;
    if (ageDays > this.o.maxUsdCadAgeDays) throw new FxError(`USD/CAD observation ${obs.d} is stale`);
    const rate = Number(obs.FXUSDCAD.v);
    if (!(rate > 0.5 && rate < 3)) throw new FxError(`USD/CAD ${rate} outside sanity range`);
    return { rate, date: obs.d };
  }

  async solUsd(): Promise<{ price: number; at: number }> {
    const at = this.now();
    const body = await this.http.request({
      provider: "jupiter_price",
      url: JUP_PRICE_URL,
      schema: PriceSchema,
      cacheTtlMs: this.o.solUsdCacheMs,
      headers: this.o.apiKey ? { "x-api-key": this.o.apiKey } : {},
    });
    const p = body[MINTS.WSOL]?.usdPrice;
    if (!p) throw new FxError("no SOL/USD price");
    return { price: p, at };
  }

  async solCad(): Promise<FxQuote> {
    const [u, s] = await Promise.all([this.usdCad(), this.solUsd()]);
    return { solCad: s.price * u.rate, solUsd: s.price, usdCad: u.rate, solUsdAt: s.at, usdCadDate: u.date, evidence: "DERIVED" };
  }
}

/** CAD → lamports at a given SOL/CAD rate, rounded down. */
export function cadToLamports(cad: number, solCad: number): bigint {
  if (!(cad > 0) || !(solCad > 0)) throw new FxError("cadToLamports needs positive inputs");
  return BigInt(Math.floor((cad / solCad) * 1e9));
}

export function lamportsToCad(lamports: bigint, solCad: number): number {
  return (Number(lamports) / 1e9) * solCad;
}
