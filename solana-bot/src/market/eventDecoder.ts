/**
 * Trade events from transaction logs.
 *
 * pump.fun (curve) and PumpSwap write Anchor events as "Program data: <base64>"
 * log lines. Seen live 2026-10-26: every successful curve trade carried a
 * TradeEvent this way, and PumpSwap swaps carried BuyEvent/SellEvent.
 *
 * Security: any program can print a "Program data:" line with the same bytes.
 * An event is accepted only when the program that printed it (top of the
 * invoke stack at that line) is the real pump.fun or PumpSwap program.
 *
 * Field orders from pump-public-docs idl/pump.json and idl/pump_amm.json
 * (commit 639b87fb). Only the fixed-offset prefix we need is decoded.
 */
import { bytesToAddress } from "../solana/address.ts";
import { PROGRAMS } from "../solana/programs.ts";

const DISC = {
  pumpTrade: [189, 219, 127, 211, 78, 230, 97, 238],
  swapBuy: [103, 244, 82, 31, 44, 245, 119, 119],
  swapSell: [62, 47, 55, 10, 165, 3, 220, 42],
} as const;

export interface TradeEvent {
  venue: "pump_curve" | "pumpswap";
  signature: string;
  /** Position of this event within the transaction's logs. */
  eventIndex: number;
  slot: number;
  /** On-chain timestamp from the event (seconds precision), ms. */
  blockTimeMs: number;
  side: "buy" | "sell";
  wallet: string;
  /** Curve trades: the mint. PumpSwap: the pool (mint comes from the pool account). */
  mintOrPool: string;
  /** Quote side (SOL for SOL-paired coins), base units, after the trade's own accounting. */
  quoteAmount: bigint;
  tokenAmount: bigint;
  /** Curve only: reserves after the trade. */
  virtualQuoteReserves?: bigint;
  virtualTokenReserves?: bigint;
  realQuoteReserves?: bigint;
}

export interface LogParse {
  events: TradeEvent[];
  /** Same discriminator printed by a program that isn't pump.fun/PumpSwap. */
  spoofed: number;
  truncated: boolean;
}

function eq(b: Uint8Array, d: readonly number[]): boolean {
  for (let i = 0; i < 8; i++) if (b[i] !== d[i]) return false;
  return true;
}

class Reader {
  private dv: DataView;
  constructor(
    private b: Uint8Array,
    public off = 8,
  ) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  need(n: number) {
    if (this.off + n > this.b.length) throw new Error("event too short");
  }
  u64() {
    this.need(8);
    const v = this.dv.getBigUint64(this.off, true);
    this.off += 8;
    return v;
  }
  i64() {
    this.need(8);
    const v = this.dv.getBigInt64(this.off, true);
    this.off += 8;
    return v;
  }
  bool() {
    this.need(1);
    const v = this.b[this.off]!;
    this.off += 1;
    if (v > 1) throw new Error("bad bool");
    return v === 1;
  }
  key() {
    this.need(32);
    const v = bytesToAddress(this.b.subarray(this.off, this.off + 32));
    this.off += 32;
    return v;
  }
}

function decodePumpTrade(b: Uint8Array, base: Omit<TradeEvent, "venue" | "side" | "wallet" | "mintOrPool" | "quoteAmount" | "tokenAmount" | "blockTimeMs">): TradeEvent {
  const r = new Reader(b);
  const mint = r.key();
  const quoteAmount = r.u64();
  const tokenAmount = r.u64();
  const isBuy = r.bool();
  const wallet = r.key();
  const ts = r.i64();
  const virtualQuoteReserves = r.u64();
  const virtualTokenReserves = r.u64();
  const realQuoteReserves = r.u64();
  return {
    ...base,
    venue: "pump_curve",
    side: isBuy ? "buy" : "sell",
    wallet,
    mintOrPool: mint,
    quoteAmount,
    tokenAmount,
    blockTimeMs: Number(ts) * 1000,
    virtualQuoteReserves,
    virtualTokenReserves,
    realQuoteReserves,
  };
}

/** PumpSwap Buy: timestamp, base_out, max_quote_in, 4 reserve fields, quote_in, 4 fee fields, quote_in_with_lp_fee, user_quote_in, pool, user. */
function decodeSwap(b: Uint8Array, side: "buy" | "sell", base: Omit<TradeEvent, "venue" | "side" | "wallet" | "mintOrPool" | "quoteAmount" | "tokenAmount" | "blockTimeMs">): TradeEvent {
  const r = new Reader(b);
  const ts = r.i64();
  const baseAmount = r.u64(); // base_amount_out (buy) / base_amount_in (sell)
  r.u64(); // max_quote_amount_in / min_quote_amount_out
  r.u64(); // user_base_token_reserves
  r.u64(); // user_quote_token_reserves
  r.u64(); // pool_base_token_reserves
  r.u64(); // pool_quote_token_reserves
  r.u64(); // quote_amount_in / quote_amount_out
  r.u64(); // lp_fee_basis_points
  r.u64(); // lp_fee
  r.u64(); // protocol_fee_basis_points
  r.u64(); // protocol_fee
  r.u64(); // quote_amount_in_with_lp_fee / quote_amount_out_without_lp_fee
  const userQuote = r.u64(); // user_quote_amount_in / user_quote_amount_out (what the trader actually paid/got)
  const pool = r.key();
  const wallet = r.key();
  return { ...base, venue: "pumpswap", side, wallet, mintOrPool: pool, quoteAmount: userQuote, tokenAmount: baseAmount, blockTimeMs: Number(ts) * 1000 };
}

/**
 * Parse one transaction's logs. Tracks the invoke stack so each "Program data"
 * line is attributed to the program that printed it.
 */
export function parseTradeLogs(signature: string, slot: number, logs: string[]): LogParse {
  const events: TradeEvent[] = [];
  const stack: string[] = [];
  let spoofed = 0;
  let truncated = false;
  let idx = 0;
  for (const line of logs) {
    if (line === "Log truncated") {
      truncated = true;
      continue;
    }
    const inv = /^Program (\w{32,44}) invoke \[\d+\]$/.exec(line);
    if (inv) {
      stack.push(inv[1]!);
      continue;
    }
    if (/^Program \w{32,44} (success|failed)/.test(line)) {
      stack.pop();
      continue;
    }
    if (!line.startsWith("Program data: ")) continue;
    let b: Uint8Array;
    try {
      b = Uint8Array.from(Buffer.from(line.slice(14), "base64"));
    } catch {
      continue;
    }
    if (b.length < 8) continue;
    const emitter = stack[stack.length - 1];
    const isPumpTrade = eq(b, DISC.pumpTrade);
    const isBuy = eq(b, DISC.swapBuy);
    const isSell = eq(b, DISC.swapSell);
    if (!isPumpTrade && !isBuy && !isSell) continue;
    const real = (isPumpTrade && emitter === PROGRAMS.PUMP_CURVE) || ((isBuy || isSell) && emitter === PROGRAMS.PUMPSWAP);
    if (!real) {
      spoofed++;
      continue;
    }
    const base = { signature, eventIndex: idx++, slot };
    try {
      events.push(isPumpTrade ? decodePumpTrade(b, base) : decodeSwap(b, isBuy ? "buy" : "sell", base));
    } catch {
      // Malformed event from the right program: skip it rather than guess.
    }
  }
  return { events, spoofed, truncated };
}
