/**
 * pump.fun BondingCurve account decoding.
 *
 * Field order from idl/pump.json `types.BondingCurve` (pump-public-docs commit 639b87fb):
 *   virtual_token_reserves u64, virtual_quote_reserves u64, real_token_reserves u64,
 *   real_quote_reserves u64, token_total_supply u64, complete bool, creator pubkey,
 *   is_mayhem_mode bool, is_cashback_coin bool, quote_mint pubkey, ...
 *
 * pump.fun appends fields over time and older accounts are shorter. The docs say
 * to read missing trailing fields as zero/false. We decode the fields we need and
 * report which optional ones were absent instead of inventing them.
 */
import { bytesToAddress } from "./address.ts";
import { DecodeError } from "./mint.ts";
import { MINTS, PUMP_BONDING_CURVE_DISCRIMINATOR } from "./programs.ts";

export interface DecodedBondingCurve {
  virtualTokenReserves: bigint;
  virtualQuoteReserves: bigint;
  realTokenReserves: bigint;
  realQuoteReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  creator: string;
  isMayhemMode: boolean | undefined;
  /**
   * Quote mint. When the field is absent (older layout) or all zeros we report
   * wSOL with `quoteMintAssumed: true`, because curves before quote-mint support
   * were SOL-only. That is an inference, and it is labelled as one.
   */
  quoteMint: string;
  quoteMintAssumed: boolean;
}

const REQUIRED_LEN = 8 + 8 * 5 + 1 + 32; // through `creator`
const ZERO_ADDRESS = "11111111111111111111111111111111";

export function decodeBondingCurve(data: Uint8Array): DecodedBondingCurve {
  if (data.length < REQUIRED_LEN) throw new DecodeError(`bonding curve too short: ${data.length}`);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== PUMP_BONDING_CURVE_DISCRIMINATOR[i]) throw new DecodeError("not a BondingCurve account (discriminator)");
  }
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let off = 8;
  const u64 = () => {
    const v = dv.getBigUint64(off, true);
    off += 8;
    return v;
  };
  const virtualTokenReserves = u64();
  const virtualQuoteReserves = u64();
  const realTokenReserves = u64();
  const realQuoteReserves = u64();
  const tokenTotalSupply = u64();
  const completeByte = dv.getUint8(off++);
  if (completeByte > 1) throw new DecodeError(`bad bool ${completeByte}`);
  const creator = bytesToAddress(data.subarray(off, off + 32));
  off += 32;
  let isMayhemMode: boolean | undefined;
  if (off + 1 <= data.length) isMayhemMode = dv.getUint8(off) === 1;
  off += 1; // is_mayhem_mode
  off += 1; // is_cashback_coin
  let quoteMint: string = MINTS.WSOL;
  let quoteMintAssumed = true;
  if (off + 32 <= data.length) {
    const q = bytesToAddress(data.subarray(off, off + 32));
    if (q !== ZERO_ADDRESS) {
      quoteMint = q;
      quoteMintAssumed = false;
    }
  }
  return {
    virtualTokenReserves,
    virtualQuoteReserves,
    realTokenReserves,
    realQuoteReserves,
    tokenTotalSupply,
    complete: completeByte === 1,
    creator,
    isMayhemMode,
    quoteMint,
    quoteMintAssumed,
  };
}

/**
 * Marginal curve price in quote units per whole token, before fees.
 * This is a pool mid-price, not an executable quote.
 */
export function curveSpotPrice(c: DecodedBondingCurve, tokenDecimals: number, quoteDecimals: number): number | undefined {
  if (c.virtualTokenReserves === 0n) return undefined;
  const q = Number(c.virtualQuoteReserves) / 10 ** quoteDecimals;
  const t = Number(c.virtualTokenReserves) / 10 ** tokenDecimals;
  return q / t;
}
