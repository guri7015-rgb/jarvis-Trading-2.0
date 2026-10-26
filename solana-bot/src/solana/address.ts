import { getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, isAddress, type Address } from "@solana/kit";
import { PROGRAMS, PUMP_BONDING_CURVE_SEED } from "./programs.ts";

const encoder = getAddressEncoder();
const decoder = getAddressDecoder();

/** True only for a syntactically valid 32-byte base58 Solana address. */
export function isValidAddress(s: unknown): s is string {
  return typeof s === "string" && s.length >= 32 && s.length <= 44 && isAddress(s);
}

export function addressToBytes(a: string): Uint8Array {
  return Uint8Array.from(encoder.encode(a as Address));
}

export function bytesToAddress(b: Uint8Array): string {
  if (b.length !== 32) throw new Error("address must be 32 bytes");
  return decoder.decode(b);
}

/** Derive the pump.fun bonding-curve account for a mint. Computed locally, so it's not a provider claim. */
export async function derivePumpBondingCurve(mint: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: PROGRAMS.PUMP_CURVE as Address,
    seeds: [PUMP_BONDING_CURVE_SEED, addressToBytes(mint)],
  });
  return pda;
}
