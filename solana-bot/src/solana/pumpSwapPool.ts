/**
 * PumpSwap Pool account prefix (idl/pump_amm.json `types.Pool`, commit 639b87fb):
 *   [8] discriminator, u8 pool_bump, u16 index, creator, base_mint, quote_mint, lp_mint,
 *   pool_base_token_account, pool_quote_token_account, ...
 */
import { bytesToAddress } from "./address.ts";
import { DecodeError } from "./mint.ts";

export const PUMPSWAP_POOL_DISCRIMINATOR = Uint8Array.from([241, 154, 109, 4, 17, 177, 109, 188]);

export interface DecodedPool {
  creator: string;
  baseMint: string;
  quoteMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
}

export function decodePumpSwapPool(data: Uint8Array): DecodedPool {
  const need = 8 + 1 + 2 + 32 * 6;
  if (data.length < need) throw new DecodeError(`pool too short: ${data.length}`);
  for (let i = 0; i < 8; i++) if (data[i] !== PUMPSWAP_POOL_DISCRIMINATOR[i]) throw new DecodeError("not a PumpSwap Pool (discriminator)");
  let off = 11;
  const key = () => {
    const k = bytesToAddress(data.subarray(off, off + 32));
    off += 32;
    return k;
  };
  const creator = key();
  const baseMint = key();
  const quoteMint = key();
  key(); // lp_mint
  return { creator, baseMint, quoteMint, poolBaseTokenAccount: key(), poolQuoteTokenAccount: key() };
}
