import { describe, expect, it } from "vitest";
import type { MigratedEvent, PoolObservedEvent, TokenCreatedEvent } from "../src/core/types.ts";
import { categorize, TokenRegistry } from "../src/discovery/registry.ts";
import { openDb } from "../src/storage/db.ts";
import { PUMP_MINT } from "./helpers.ts";

const T0 = 1_800_000_000_000;
const cfg = { newLaunchMaxAgeMs: 10 * 60_000, earlyMaxAgeMs: 2 * 3_600_000 };

const create = (at: number, over: Partial<TokenCreatedEvent> = {}): TokenCreatedEvent => ({
  kind: "token_created",
  provider: "pumpportal",
  providerEventId: "create:sig1",
  dedupeKey: `create:${PUMP_MINT}`,
  receivedAt: at,
  evidence: "PROVIDER_REPORTED",
  mint: PUMP_MINT,
  venue: "pump_curve",
  venueRaw: "pump",
  signature: "sig1",
  ...over,
});
const pool = (provider: "geckoterminal" | "jupiter_tokens", at: number, over: Partial<PoolObservedEvent> = {}): PoolObservedEvent => ({
  kind: "pool_observed",
  provider,
  providerEventId: `pool:${provider}`,
  dedupeKey: "pool:P1",
  receivedAt: at,
  evidence: "PROVIDER_REPORTED",
  mint: PUMP_MINT,
  venue: "pump_curve",
  venueRaw: "pump-fun",
  pool: "P1",
  poolCreatedAt: at - 5_000,
  ...over,
});
const migrate = (at: number): MigratedEvent => ({
  kind: "migrated",
  provider: "pumpportal",
  providerEventId: "migrate:sig9",
  dedupeKey: `migrate:${PUMP_MINT}`,
  receivedAt: at,
  evidence: "PROVIDER_REPORTED",
  mint: PUMP_MINT,
  venue: "pumpswap",
  venueRaw: "pump-amm",
});

const reg = () => new TokenRegistry(openDb(":memory:"));

describe("TokenRegistry", () => {
  it("treats a repeated provider event as a duplicate", () => {
    const r = reg();
    expect(r.ingest(create(T0))).toEqual({ duplicate: false, newToken: true, crossProviderRepeat: false });
    expect(r.ingest(create(T0 + 50))).toEqual({ duplicate: true, newToken: false, crossProviderRepeat: false });
    expect(r.count()).toBe(1);
  });

  it("merges the same token from three providers into one record keyed by mint", () => {
    const r = reg();
    r.ingest(create(T0));
    r.ingest(pool("geckoterminal", T0 + 20_000));
    const third = r.ingest(pool("jupiter_tokens", T0 + 30_000));
    expect(third.crossProviderRepeat).toBe(true);
    expect(r.count()).toBe(1);
    expect(r.sources(PUMP_MINT).map((s) => s.provider)).toEqual(["pumpportal", "geckoterminal", "jupiter_tokens"]);
  });

  it("does not use name or symbol as identity", () => {
    const r = reg();
    r.ingest(create(T0, { symbol: "SAME", name: "Same" }));
    r.ingest(create(T0, { mint: "532EPZppGdHgf5dwdMf4pmAihrMshbnKCotnEFEDKxHP", providerEventId: "create:sig2", dedupeKey: "create:532E", symbol: "SAME", name: "Same" }));
    expect(r.count()).toBe(2);
  });

  it("handles out-of-order arrival: first-observed only moves earlier", () => {
    const r = reg();
    r.ingest(pool("geckoterminal", T0 + 60_000));
    expect(r.get(PUMP_MINT)!.first_source).toBe("geckoterminal");
    r.ingest(create(T0));
    const t = r.get(PUMP_MINT)!;
    expect(t.first_observed_at).toBe(T0);
    expect(t.first_source).toBe("pumpportal");
  });

  it("never moves a token's stage backwards", () => {
    const r = reg();
    r.ingest(migrate(T0 + 1000));
    r.ingest(create(T0));
    expect(r.get(PUMP_MINT)!.stage).toBe("MIGRATED");
  });

  it("prefers a provider-reported creation time over a derived receipt time", () => {
    const r = reg();
    r.ingest(create(T0));
    expect(r.get(PUMP_MINT)!.created_at_evidence).toBe("DERIVED");
    r.ingest(pool("jupiter_tokens", T0 + 30_000, { poolCreatedAt: T0 - 2_000 }));
    const t = r.get(PUMP_MINT)!;
    expect(t.created_at).toBe(T0 - 2_000);
    expect(t.created_at_evidence).toBe("PROVIDER_REPORTED");
  });

  it("an AMM pool time is only an upper bound on creation time", () => {
    const r = reg();
    r.ingest(pool("geckoterminal", T0, { venue: "pumpswap", venueRaw: "pumpswap", poolCreatedAt: T0 - 1000 }));
    const t = r.get(PUMP_MINT)!;
    expect(t.created_at_evidence).toBe("DERIVED");
    expect(t.created_at_source).toMatch(/upper_bound/);
  });
});

describe("categorize", () => {
  it("never calls a token new without a creation time", () => {
    expect(categorize({ created_at: null, created_at_evidence: null, created_at_source: null }, T0, cfg).category).toBe("UNKNOWN_AGE");
  });

  it("uses creation time and says what evidence it rests on", () => {
    const t = { created_at: T0 - 60_000, created_at_evidence: "PROVIDER_REPORTED" as const, created_at_source: "jupiter_tokens:launch_pool_created" };
    expect(categorize(t, T0, cfg)).toMatchObject({ category: "NEW_LAUNCH", ageMs: 60_000, basis: expect.stringMatching(/PROVIDER_REPORTED/) });
    expect(categorize(t, T0 + 30 * 60_000, cfg).category).toBe("EARLY");
    expect(categorize(t, T0 + 3 * 3_600_000, cfg).category).toBe("ESTABLISHED");
  });

  it("won't label a token new from an AMM pool's upper-bound time", () => {
    const t = { created_at: T0 - 60_000, created_at_evidence: "DERIVED" as const, created_at_source: "geckoterminal:pool_created_upper_bound" };
    expect(categorize(t, T0, cfg).category).toBe("UNKNOWN_AGE");
    expect(categorize(t, T0 + 3 * 3_600_000, cfg).category).toBe("ESTABLISHED");
  });
});
