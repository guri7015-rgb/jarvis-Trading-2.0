/**
 * PumpPortal data stream (third party, not affiliated with pump.fun).
 *
 * Approved use: read-only `subscribeNewToken` and `subscribeMigration` only.
 * These need no API key and no wallet. This module does not know any other
 * PumpPortal method, and `buildSubscribeMessages` refuses anything else.
 */
import { z } from "zod";
import type { MigratedEvent, TokenCreatedEvent } from "../core/types.ts";
import { isValidAddress } from "../solana/address.ts";
import { mapVenue } from "./venues.ts";

export const PUMPPORTAL_DATA_URL = "wss://pumpportal.fun/api/data";

const ALLOWED_METHODS = new Set(["subscribeNewToken", "subscribeMigration"]);

export function buildSubscribeMessages(methods: string[]): string[] {
  for (const m of methods) {
    if (!ALLOWED_METHODS.has(m)) throw new Error(`PumpPortal method not approved: ${m}`);
  }
  return methods.map((method) => JSON.stringify({ method }));
}

const Address = z.string().refine(isValidAddress, "invalid address");
const Signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
const finite = z.number().finite();

const CreateMessage = z.object({
  txType: z.literal("create"),
  signature: Signature,
  mint: Address,
  traderPublicKey: Address,
  bondingCurveKey: Address.optional(),
  initialBuy: finite.nonnegative().optional(),
  solAmount: finite.nonnegative().optional(),
  vTokensInBondingCurve: finite.nonnegative().optional(),
  vSolInBondingCurve: finite.nonnegative().optional(),
  marketCapSol: finite.nonnegative().optional(),
  name: z.string().max(200).optional(),
  symbol: z.string().max(64).optional(),
  uri: z.string().max(1000).optional(),
  pool: z.string().max(32).optional(),
});

/**
 * Migration payload. Field names are taken from captured messages
 * (see test/fixtures). Unknown extra fields are ignored.
 */
const MigrateMessage = z.object({
  txType: z.literal("migrate"),
  signature: Signature,
  mint: Address,
  pool: z.string().max(32).optional(),
});

const AckMessage = z.object({ message: z.string().max(500) });

export type PumpPortalParse =
  | { type: "event"; event: TokenCreatedEvent | MigratedEvent }
  | { type: "ack"; message: string }
  | { type: "ignored"; reason: string }
  | { type: "rejected"; reason: string };

export function parsePumpPortalMessage(text: string, receivedAt: number): PumpPortalParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { type: "rejected", reason: "invalid JSON" };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { type: "rejected", reason: "not an object" };
  const txType = (raw as Record<string, unknown>).txType;

  if (txType === "create") {
    const p = CreateMessage.safeParse(raw);
    if (!p.success) return { type: "rejected", reason: `create: ${p.error.issues[0]?.path.join(".")}` };
    const m = p.data;
    const venueRaw = m.pool ?? "pump";
    const ev: TokenCreatedEvent = {
      kind: "token_created",
      provider: "pumpportal",
      providerEventId: `create:${m.signature}`,
      dedupeKey: `create:${m.mint}`,
      receivedAt,
      evidence: "PROVIDER_REPORTED",
      mint: m.mint,
      venue: mapVenue("pumpportal", venueRaw),
      venueRaw,
      signature: m.signature,
      creator: m.traderPublicKey,
      name: m.name,
      symbol: m.symbol,
      bondingCurve: m.bondingCurveKey,
      // PumpPortal doesn't send a creation timestamp. We only know when we received it.
    };
    return { type: "event", event: ev };
  }

  if (txType === "migrate") {
    const p = MigrateMessage.safeParse(raw);
    if (!p.success) return { type: "rejected", reason: `migrate: ${p.error.issues[0]?.path.join(".")}` };
    const m = p.data;
    const venueRaw = m.pool ?? "unknown";
    const ev: MigratedEvent = {
      kind: "migrated",
      provider: "pumpportal",
      providerEventId: `migrate:${m.signature}`,
      dedupeKey: `migrate:${m.mint}`,
      receivedAt,
      evidence: "PROVIDER_REPORTED",
      mint: m.mint,
      venue: mapVenue("pumpportal", venueRaw),
      venueRaw,
      signature: m.signature,
    };
    return { type: "event", event: ev };
  }

  const ack = AckMessage.safeParse(raw);
  if (ack.success && txType === undefined) return { type: "ack", message: ack.data.message };
  return { type: "ignored", reason: `unhandled txType ${String(txType).slice(0, 20)}` };
}
