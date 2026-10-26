/**
 * Guard rails that must hold in every phase before live approval.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_TRADING_ENABLED, loadConfig } from "../src/core/config.ts";
import { createLogger, redact, registerSecret } from "../src/core/log.ts";

const SRC = resolve(import.meta.dirname, "../src");
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("no execution capability", () => {
  it("live trading is a hard-coded false constant", () => {
    expect(LIVE_TRADING_ENABLED).toBe(false);
  });

  it("source contains no signing, sending or trading endpoints", () => {
    const forbidden = [
      /sendTransaction/,
      /sendRawTransaction/,
      /signTransaction/,
      /Keypair/,
      /createKeyPairSignerFromBytes|generateKeyPairSigner/,
      /secretKey/i,
      /privateKey/i,
      /seed\s*phrase|mnemonic/i,
      /trade-local|api\/trade/,
      /swap\/v\d\/(order|execute|build|swap)/,
    ];
    const hits: string[] = [];
    for (const f of files(SRC)) {
      const text = readFileSync(f, "utf8");
      for (const re of forbidden) if (re.test(text)) hits.push(`${f.replace(SRC, "src")}: ${re}`);
    }
    expect(hits).toEqual([]);
  });

  it(".env is git-ignored", () => {
    const gi = readFileSync(resolve(import.meta.dirname, "../.gitignore"), "utf8").split("\n");
    expect(gi).toContain(".env");
    expect(gi).toContain("data/");
  });

  it(".env.example contains no real-looking secrets", () => {
    const ex = readFileSync(resolve(import.meta.dirname, "../.env.example"), "utf8");
    expect(ex).toMatch(/^JUPITER_API_KEY=$/m);
    expect(ex).not.toMatch(/api-key=[A-Za-z0-9-]{8,}/);
  });
});

describe("secret handling", () => {
  it("redacts registered secrets and key-bearing URLs from log lines", () => {
    registerSecret("sk_live_supersecretvalue");
    const lines: string[] = [];
    const log = createLogger("t", (l) => lines.push(l), "debug");
    log.info("calling https://mainnet.helius-rpc.com/?api-key=abcd-1234-efgh", { key: "sk_live_supersecretvalue", headers: { "x-api-key": "zzz999" } });
    expect(lines[0]).not.toMatch(/abcd-1234-efgh|sk_live_supersecretvalue|zzz999/);
    expect(lines[0]).toMatch(/\[REDACTED\]/);
  });

  it("redacts a 64-byte secret key array", () => {
    const arr = `[${Array.from({ length: 64 }, (_, i) => i).join(",")}]`;
    expect(redact(`key file: ${arr}`)).toBe("key file: [REDACTED]");
  });

  it("config errors name the bad key, never its value", () => {
    const env = { SOLANA_RPC_URL: "not a url with secret-abc123", RPC_DAILY_CALL_BUDGET: "5" } as NodeJS.ProcessEnv;
    expect(() => loadConfig(env, "/nonexistent/.env")).toThrow(/SOLANA_RPC_URL/);
    try {
      loadConfig(env, "/nonexistent/.env");
    } catch (e) {
      expect((e as Error).message).not.toMatch(/secret-abc123/);
    }
  });

  it("registers a keyed RPC URL as a secret", () => {
    const cfg = loadConfig({ SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=k-777-888" } as NodeJS.ProcessEnv, "/nonexistent/.env");
    expect(redact(`rpc=${cfg.SOLANA_RPC_URL}`)).toBe("rpc=[REDACTED]");
  });
});
