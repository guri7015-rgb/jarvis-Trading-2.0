/**
 * Jupiter quote client: read-only price discovery.
 *
 * Uses GET /swap/v1/quote (the quote half of the /build path: no Jupiter swap
 * fee). This module never requests a transaction. It only asks "how much
 * would I get", and checks the answer is about what we asked.
 */
import { z } from "zod";
import { ExpectedHttpError, type HttpClient } from "../net/http.ts";

export const JUP_QUOTE_URL = "https://api.jup.ag/swap/v1/quote";

const IntStr = z.string().regex(/^\d{1,30}$/);

const QuoteSchema = z.object({
  inputMint: z.string().max(60),
  outputMint: z.string().max(60),
  inAmount: IntStr,
  outAmount: IntStr,
  otherAmountThreshold: IntStr,
  swapMode: z.string().max(20),
  slippageBps: z.number().int().nonnegative(),
  priceImpactPct: z.string().max(40),
  routePlan: z
    .array(
      z.object({
        swapInfo: z.object({
          ammKey: z.string().max(60),
          label: z.string().max(80).optional(),
          inputMint: z.string().max(60),
          outputMint: z.string().max(60),
          inAmount: IntStr,
          outAmount: IntStr,
        }),
        percent: z.number().nullable().optional(),
        bps: z.number().nullable().optional(),
      }),
    )
    .min(1)
    .max(20),
  contextSlot: z.number().int().nonnegative().optional(),
  timeTaken: z.number().nonnegative().optional(),
});

export interface Quote {
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
  /** Minimum out after slippage. */
  minOut: bigint;
  /** Jupiter's price impact, as a fraction (0.01 = 1%). PROVIDER_REPORTED. */
  priceImpact: number;
  routeLabels: string[];
  ammKeys: string[];
  hops: number;
  contextSlot?: number;
  /** Local ms when the response arrived. */
  receivedAt: number;
}

export class QuoteError extends Error {}

export interface QuoteRequest {
  inputMint: string;
  outputMint: string;
  amount: bigint;
  slippageBps: number;
}

export function parseQuote(raw: z.infer<typeof QuoteSchema>, req: QuoteRequest, receivedAt: number): Quote {
  // Never trust an answer to a different question.
  if (raw.inputMint !== req.inputMint || raw.outputMint !== req.outputMint) throw new QuoteError("quote mints do not match the request");
  if (raw.swapMode !== "ExactIn") throw new QuoteError(`unexpected swapMode ${raw.swapMode}`);
  const inAmount = BigInt(raw.inAmount);
  if (inAmount !== req.amount) throw new QuoteError("quote inAmount does not match the request");
  const outAmount = BigInt(raw.outAmount);
  if (outAmount <= 0n) throw new QuoteError("quote returns nothing");
  const minOut = BigInt(raw.otherAmountThreshold);
  if (minOut > outAmount) throw new QuoteError("minimum out exceeds out amount");
  const impact = Number(raw.priceImpactPct);
  if (!Number.isFinite(impact) || impact < 0) throw new QuoteError("bad priceImpactPct");
  // Every leg must start from our input or from something an earlier leg produced,
  // and the route must end at our output. Covers both sequential hops and splits.
  const reachable = new Set([req.inputMint]);
  for (const leg of raw.routePlan) {
    if (!reachable.has(leg.swapInfo.inputMint)) throw new QuoteError("route leg starts from an unrelated token");
    reachable.add(leg.swapInfo.outputMint);
  }
  if (raw.routePlan[raw.routePlan.length - 1]!.swapInfo.outputMint !== req.outputMint) throw new QuoteError("route does not end at the requested token");
  return {
    inputMint: raw.inputMint,
    outputMint: raw.outputMint,
    inAmount,
    outAmount,
    minOut,
    priceImpact: impact,
    routeLabels: raw.routePlan.map((r) => r.swapInfo.label ?? "unknown"),
    ammKeys: raw.routePlan.map((r) => r.swapInfo.ammKey),
    hops: raw.routePlan.length,
    contextSlot: raw.contextSlot,
    receivedAt,
  };
}

export class QuoteClient {
  constructor(
    private readonly http: HttpClient,
    private readonly now: () => number,
    private readonly apiKey?: string,
  ) {}

  async quote(req: QuoteRequest): Promise<Quote> {
    if (req.amount <= 0n) throw new QuoteError("amount must be positive");
    const qs = new URLSearchParams({
      inputMint: req.inputMint,
      outputMint: req.outputMint,
      amount: req.amount.toString(),
      slippageBps: String(req.slippageBps),
      swapMode: "ExactIn",
      // Keep routes simple: fewer hops, fewer places for an exit to break.
      restrictIntermediateTokens: "true",
    });
    let raw;
    try {
      raw = await this.http.request({
        provider: "jupiter_quote",
        url: `${JUP_QUOTE_URL}?${qs.toString()}`,
        schema: QuoteSchema,
        headers: this.apiKey ? { "x-api-key": this.apiKey } : {},
        maxRetries: 1,
        timeoutMs: 8_000,
        expectedErrorStatuses: [400],
      });
    } catch (e) {
      if (e instanceof ExpectedHttpError) {
        const code = (e.body as { errorCode?: unknown } | undefined)?.errorCode;
        throw new QuoteError(code === "NO_ROUTES_FOUND" ? "NO_ROUTE" : `quote refused: ${String(code ?? e.status).slice(0, 60)}`);
      }
      throw e;
    }
    return parseQuote(raw, req, this.now());
  }
}
