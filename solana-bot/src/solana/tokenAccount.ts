/**
 * SPL token account base layout (same for Token and Token-2022):
 *   0 [32] mint   32 [32] owner   64 u64 amount   ...   108 u8 state
 * Source: SPL Token `Account` layout (165 bytes base).
 */
import { bytesToAddress } from "./address.ts";
import { DecodeError } from "./mint.ts";
import { PROGRAMS } from "./programs.ts";

export interface DecodedTokenAccount {
  mint: string;
  owner: string;
  amount: bigint;
  /** 0 uninitialized, 1 initialized, 2 frozen. */
  state: number;
}

export function decodeTokenAccount(data: Uint8Array, programOwner: string): DecodedTokenAccount {
  if (programOwner !== PROGRAMS.TOKEN && programOwner !== PROGRAMS.TOKEN_2022) throw new DecodeError(`not a token account: owner ${programOwner}`);
  if (data.length < 165) throw new DecodeError(`token account too short: ${data.length}`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    mint: bytesToAddress(data.subarray(0, 32)),
    owner: bytesToAddress(data.subarray(32, 64)),
    amount: dv.getBigUint64(64, true),
    state: dv.getUint8(108),
  };
}
