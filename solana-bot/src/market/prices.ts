/**
 * USD prices for a batch of mints from Jupiter Price v3 (up to 50 ids a call).
 * Used only to score signals after the fact. Never a trade input.
 */
import { z } from "zod";
import type { HttpClient } from "../net/http.ts";

const Schema = z.record(z.string(), z.object({ usdPrice: z.number().finite().positive().optional() }).passthrough());

export type PriceFetcher = (mints: string[]) => Promise<Map<string, number>>;

export function jupiterPriceFetcher(http: HttpClient, apiKey: string | undefined): PriceFetcher {
  return async (mints) => {
    const out = new Map<string, number>();
    for (let i = 0; i < mints.length; i += 50) {
      const ids = mints.slice(i, i + 50);
      const body = await http.request({
        provider: "jupiter_price",
        url: `https://api.jup.ag/price/v3?ids=${ids.join(",")}`,
        schema: Schema,
        headers: apiKey ? { "x-api-key": apiKey } : {},
        maxRetries: 0,
      });
      for (const [m, v] of Object.entries(body)) if (v.usdPrice) out.set(m, v.usdPrice);
    }
    return out;
  };
}
