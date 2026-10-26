/**
 * SPL Token / Token-2022 mint decoding.
 *
 * Base layout (82 bytes, both programs):
 *   0  u32  mint_authority option   4  [32] mint_authority
 *   36 u64  supply                  44 u8   decimals
 *   45 u8   is_initialized          46 u32  freeze_authority option   50 [32] freeze_authority
 * Token-2022 adds an account-type byte at 165 and TLV extensions from 166:
 *   u16 type, u16 length, [length] value. Source: solana-program/token-2022
 *   interface/src/extension/mod.rs (BASE_ACCOUNT_LENGTH = 165, ExtensionType repr(u16)).
 */
import { bytesToAddress } from "./address.ts";
import { PROGRAMS } from "./programs.ts";

/** ExtensionType values in declaration order (0..28), from token-2022 interface/src/extension/mod.rs. */
export const EXTENSION_NAMES = [
  "Uninitialized",
  "TransferFeeConfig",
  "TransferFeeAmount",
  "MintCloseAuthority",
  "ConfidentialTransferMint",
  "ConfidentialTransferAccount",
  "DefaultAccountState",
  "ImmutableOwner",
  "MemoTransfer",
  "NonTransferable",
  "InterestBearingConfig",
  "CpiGuard",
  "PermanentDelegate",
  "NonTransferableAccount",
  "TransferHook",
  "TransferHookAccount",
  "ConfidentialTransferFeeConfig",
  "ConfidentialTransferFeeAmount",
  "MetadataPointer",
  "TokenMetadata",
  "GroupPointer",
  "TokenGroup",
  "GroupMemberPointer",
  "TokenGroupMember",
  "ConfidentialMintBurn",
  "ScaledUiAmount",
  "Pausable",
  "PausableAccount",
  "PermissionedBurn",
] as const;

export interface DecodedMint {
  program: "token" | "token2022";
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: bigint;
  decimals: number;
  isInitialized: boolean;
  /** Extension names, or `unknown(<n>)` for types newer than our table. Empty for the classic program. */
  extensions: string[];
}

export class DecodeError extends Error {}

const MINT_LEN = 82;
const ACCOUNT_TYPE_INDEX = 165;
const ACCOUNT_TYPE_MINT = 1;

export function decodeMint(data: Uint8Array, owner: string): DecodedMint {
  const program = owner === PROGRAMS.TOKEN ? "token" : owner === PROGRAMS.TOKEN_2022 ? "token2022" : undefined;
  if (!program) throw new DecodeError(`not a token mint: owner ${owner}`);
  if (data.length < MINT_LEN) throw new DecodeError(`mint data too short: ${data.length}`);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const opt = (off: number) => {
    const tag = dv.getUint32(off, true);
    if (tag === 0) return null;
    if (tag !== 1) throw new DecodeError(`bad option tag ${tag} at ${off}`);
    return bytesToAddress(data.subarray(off + 4, off + 36));
  };
  const mint: DecodedMint = {
    program,
    mintAuthority: opt(0),
    supply: dv.getBigUint64(36, true),
    decimals: dv.getUint8(44),
    isInitialized: dv.getUint8(45) === 1,
    freezeAuthority: opt(46),
    extensions: [],
  };
  if (program === "token" && data.length !== MINT_LEN) throw new DecodeError(`classic mint must be ${MINT_LEN} bytes, got ${data.length}`);
  if (program === "token2022" && data.length > MINT_LEN) {
    if (data.length <= ACCOUNT_TYPE_INDEX) throw new DecodeError("token-2022 mint with extensions is truncated");
    if (data[ACCOUNT_TYPE_INDEX] !== ACCOUNT_TYPE_MINT) throw new DecodeError(`account type ${data[ACCOUNT_TYPE_INDEX]} is not a mint`);
    let off = ACCOUNT_TYPE_INDEX + 1;
    while (off + 4 <= data.length) {
      const type = dv.getUint16(off, true);
      const len = dv.getUint16(off + 2, true);
      if (type === 0 && len === 0) break; // trailing zero padding
      if (off + 4 + len > data.length) throw new DecodeError(`extension ${type} overruns account`);
      mint.extensions.push(EXTENSION_NAMES[type] ?? `unknown(${type})`);
      off += 4 + len;
    }
  }
  return mint;
}
