import { describe, expect, it } from "vitest";
import { derivePumpBondingCurve, isValidAddress } from "../src/solana/address.ts";
import { DecodeError, decodeMint } from "../src/solana/mint.ts";
import { PROGRAMS } from "../src/solana/programs.ts";
import { curveSpotPrice, decodeBondingCurve } from "../src/solana/pumpCurve.ts";
import { PUMP_CURVE, PUMP_MINT, rpcFixtureAccounts } from "./helpers.ts";

const { accounts } = rpcFixtureAccounts();
const pumpMint = accounts[0]!;
const curveAcc = accounts[1]!;
const usdc = accounts[2]!;

describe("addresses", () => {
  it("validates base58 addresses", () => {
    expect(isValidAddress(PUMP_MINT)).toBe(true);
    expect(isValidAddress("0OIl")).toBe(false);
    expect(isValidAddress(42)).toBe(false);
  });

  it("derives the pump.fun curve address that matches live PumpPortal data", async () => {
    expect(await derivePumpBondingCurve(PUMP_MINT)).toBe(PUMP_CURVE);
  });
});

describe("decodeMint (real account bytes)", () => {
  it("decodes a Token-2022 pump.fun mint with its extensions", () => {
    const m = decodeMint(pumpMint.data, pumpMint.owner);
    expect(m).toMatchObject({ program: "token2022", mintAuthority: null, freezeAuthority: null, decimals: 6, isInitialized: true });
    expect(m.supply).toBe(1_000_000_000_000_000n);
    expect(m.extensions).toEqual(["MetadataPointer", "TokenMetadata"]);
  });

  it("decodes a classic mint that still has mint and freeze authorities (USDC)", () => {
    const m = decodeMint(usdc.data, usdc.owner);
    expect(m.program).toBe("token");
    expect(m.mintAuthority).toBeTypeOf("string");
    expect(m.freezeAuthority).toBeTypeOf("string");
    expect(m.extensions).toEqual([]);
  });

  it("rejects non-token owners, truncated data and overrunning extensions", () => {
    expect(() => decodeMint(pumpMint.data, PROGRAMS.PUMP_CURVE)).toThrow(DecodeError);
    expect(() => decodeMint(pumpMint.data.subarray(0, 50), pumpMint.owner)).toThrow(/too short/);
    const bad = Uint8Array.from(pumpMint.data);
    new DataView(bad.buffer).setUint16(168, 60_000, true); // first extension length
    expect(() => decodeMint(bad, pumpMint.owner)).toThrow(/overruns/);
    const badOpt = Uint8Array.from(usdc.data);
    badOpt[0] = 7;
    expect(() => decodeMint(badOpt, usdc.owner)).toThrow(/option tag/);
  });

  it("labels extension types newer than our table instead of hiding them", () => {
    const d = Uint8Array.from(pumpMint.data);
    new DataView(d.buffer).setUint16(166, 99, true);
    expect(decodeMint(d, pumpMint.owner).extensions[0]).toBe("unknown(99)");
  });
});

describe("decodeBondingCurve (real account bytes)", () => {
  it("decodes reserves, creator and completion state", () => {
    const c = decodeBondingCurve(curveAcc.data);
    expect(c.virtualTokenReserves).toBe(1_073_000_000_000_000n);
    expect(c.virtualQuoteReserves).toBe(30_000_000_001n);
    expect(c.complete).toBe(false);
    expect(c.creator).toBe("G288fELCkpe6PgjfXvNwDoniafuAb7jBzFKBkr83c3pV");
    // All-zero quote mint on a SOL curve is reported as an assumption, not a fact.
    expect(c.quoteMintAssumed).toBe(true);
    expect(curveSpotPrice(c, 6, 9)).toBeCloseTo(2.796e-8, 10);
  });

  it("decodes an older, shorter layout without inventing later fields", () => {
    const c = decodeBondingCurve(curveAcc.data.subarray(0, 81));
    expect(c.isMayhemMode).toBeUndefined();
    expect(c.quoteMintAssumed).toBe(true);
  });

  it("rejects the wrong discriminator and short data", () => {
    const d = Uint8Array.from(curveAcc.data);
    d[0] = 0;
    expect(() => decodeBondingCurve(d)).toThrow(/discriminator/);
    expect(() => decodeBondingCurve(curveAcc.data.subarray(0, 40))).toThrow(/too short/);
  });

  it("returns no price for empty reserves rather than Infinity", () => {
    const c = { ...decodeBondingCurve(curveAcc.data), virtualTokenReserves: 0n };
    expect(curveSpotPrice(c, 6, 9)).toBeUndefined();
  });
});
