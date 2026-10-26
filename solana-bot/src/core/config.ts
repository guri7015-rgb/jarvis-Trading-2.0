/**
 * Configuration loaded from the environment (and an optional local .env).
 *
 * Phase 2 has no execution settings at all. `LIVE_TRADING_ENABLED` is a
 * constant, not an env var, so nothing in the environment can switch it on.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { registerSecret } from "./log.ts";

export const LIVE_TRADING_ENABLED = false as const;

const EnvSchema = z.object({
  SOLANA_RPC_URL: z.url().default("https://api.mainnet.solana.com"),
  SOLANA_WS_URL: z.url().default("wss://api.mainnet.solana.com"),
  JUPITER_API_KEY: z.string().trim().optional().transform((v) => (v ? v : undefined)),
  RPC_DAILY_CALL_BUDGET: z.coerce.number().int().min(0).max(1_000_000).default(25_000),
  DATA_DIR: z.string().default("./data"),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  /** Polling and staleness settings. Starting values; Phase 2 measurements tune them. */
  discovery: {
    geckoPollMs: number;
    jupiterRecentPollMs: number;
    /** If the PumpPortal stream is silent this long, treat it as stale. */
    pumpportalMaxSilenceMs: number;
    /** A polled provider with no successful poll for this long is stale. */
    pollMaxAgeFactor: number;
    /** Max mints confirmed on-chain per batch (getMultipleAccounts allows 100). */
    confirmBatchSize: number;
    confirmIntervalMs: number;
    /** Max age (ms) for a token to be called NEW_LAUNCH. */
    newLaunchMaxAgeMs: number;
    earlyMaxAgeMs: number;
  };
};

/** Parse a simple KEY=VALUE .env file without overriding real environment variables. */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (!(key in env)) env[key] = val;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, dotEnvPath = resolve(process.cwd(), ".env")): AppConfig {
  loadDotEnv(dotEnvPath, env);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Report which keys are wrong, never their values.
    const keys = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new Error(`Invalid configuration for: ${keys}`);
  }
  const cfg = parsed.data;
  registerSecret(cfg.JUPITER_API_KEY);
  // RPC URLs from paid/free providers embed the key in the URL.
  if (!isPublicRpc(cfg.SOLANA_RPC_URL)) registerSecret(cfg.SOLANA_RPC_URL);
  if (!isPublicRpc(cfg.SOLANA_WS_URL)) registerSecret(cfg.SOLANA_WS_URL);
  return {
    ...cfg,
    discovery: {
      geckoPollMs: 20_000,
      jupiterRecentPollMs: 30_000,
      pumpportalMaxSilenceMs: 60_000,
      pollMaxAgeFactor: 4,
      confirmBatchSize: 50,
      confirmIntervalMs: 5_000,
      newLaunchMaxAgeMs: 10 * 60_000,
      earlyMaxAgeMs: 2 * 60 * 60_000,
    },
  };
}

function isPublicRpc(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "api.mainnet.solana.com" || h === "api.mainnet-beta.solana.com";
  } catch {
    return false;
  }
}

/** A label for the RPC host that is safe to print. */
export function describeRpc(url: string): string {
  try {
    const u = new URL(url);
    return isPublicRpc(url) ? `${u.hostname} (public)` : `${u.hostname} (keyed)`;
  } catch {
    return "invalid-url";
  }
}
