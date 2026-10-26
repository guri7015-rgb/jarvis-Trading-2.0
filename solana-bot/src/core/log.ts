/**
 * Minimal logger with secret redaction.
 *
 * Redaction is applied to every message and to stringified context, so a key
 * that leaks into a URL or error message is masked before it reaches a log.
 */

type Level = "debug" | "info" | "warn" | "error";

const secretValues = new Set<string>();

/** Register a value (an API key, an RPC URL with a key in it) to mask in all output. */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secretValues.add(value);
}

const PATTERNS: RegExp[] = [
  // Query-string credentials: ?api-key=..., &apikey=..., &token=...
  /([?&](?:api[-_]?key|apikey|key|token|access[-_]?token)=)[^&\s"']+/gi,
  // Header-style credentials
  /((?:x-api-key|authorization)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"',}]+/gi,
  // 64-byte keypair arrays as JSON (a Solana secret key file)
  /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g,
  // Long base58 strings of secret-key length (87-88 chars). Addresses (32-44) and signatures (86-88) overlap
  // in length, so this only fires on 87-88 char strings that are labelled as secret/private.
  /((?:secret|private)[\w-]*["']?\s*[:=]\s*["']?)[1-9A-HJ-NP-Za-km-z]{43,88}/gi,
];

export function redact(input: string): string {
  let out = input;
  for (const s of secretValues) out = out.split(s).join("[REDACTED]");
  for (const p of PATTERNS) {
    out = out.replace(p, (m, prefix?: string) => (typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]"));
  }
  return out;
}

export interface Logger {
  debug(msg: string, ctx?: Record<string, unknown>): void;
  info(msg: string, ctx?: Record<string, unknown>): void;
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}

function safeStringify(ctx: Record<string, unknown>): string {
  try {
    return JSON.stringify(ctx, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Error ? v.message : v));
  } catch {
    return "[unserializable context]";
  }
}

export function createLogger(
  scope: string,
  sink: (line: string) => void = (l) => process.stderr.write(l + "\n"),
  minLevel: Level = (process.env.LOG_LEVEL as Level) || "info",
): Logger {
  const order: Level[] = ["debug", "info", "warn", "error"];
  const emit = (level: Level, msg: string, ctx?: Record<string, unknown>) => {
    if (order.indexOf(level) < order.indexOf(minLevel)) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}${ctx ? " " + safeStringify(ctx) : ""}`;
    sink(redact(line));
  };
  return {
    debug: (m, c) => emit("debug", m, c),
    info: (m, c) => emit("info", m, c),
    warn: (m, c) => emit("warn", m, c),
    error: (m, c) => emit("error", m, c),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
