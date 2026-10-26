# Phase 2 Completion Report: Discovery, Normalization, Freshness, Health

Date: 2026-10-26. Mode: paper research. Live execution: not implemented. `LIVE_TRADING_ENABLED` is a hard-coded `false`.

## What was built

| Area | Files |
|---|---|
| Types with evidence labels, config, clock, redacting logger | `src/core/*` |
| HTTP client: per-provider rate limits, 429 reset handling, bounded retries, timeouts, size caps, schema checks, TTL cache | `src/net/http.ts`, `rateLimiter.ts`, `backoff.ts`, `ttlCache.ts` |
| Reconnecting WebSocket: resubscribe, silence detection, gap recording, oversize drop | `src/net/wsClient.ts` |
| Provider health monitor with a fail-closed discovery gate | `src/health/monitor.ts` |
| Read-only Solana RPC with a persistent daily call budget | `src/solana/rpc.ts` |
| Decoders for mints (incl. Token-2022 extensions) and pump.fun bonding curves; PDA derivation | `src/solana/*` |
| Providers: PumpPortal (new-token + migration only), GeckoTerminal, Jupiter Tokens, DexScreener | `src/providers/*` |
| Token registry: dedupe, cross-provider merge, out-of-order handling, forward-only stages, creation-time evidence | `src/discovery/registry.ts` |
| On-chain confirmer with the chain-vs-provider conflict rule | `src/discovery/confirmer.ts` |
| SQLite schema (3 migrations), sessions, gaps | `src/storage/*` |
| CLIs: `discover`, `coverage`, `probe` | `src/cli/*` |
| Docs: setup (all three OSes), legal and terms, research, architecture corrections | `docs/*` |

## Tests run

- `npm test`: **80 passed, 0 failed** across 10 files. Repeated runs were stable after one timing fix in a test.
- `npm run typecheck` (TypeScript strict): clean.
- What the tests cover:
  - duplicate events
  - out-of-order events
  - malformed and hostile payloads, including prototype-pollution keys and oversized fields
  - wrong addresses
  - stale streams
  - WebSocket drops, silence and backoff
  - 429s with reset headers, 5xx, 404s and timeouts
  - oversized responses and cache behaviour
  - RPC budget exhaustion
  - restart after a crash and after a clean stop
  - schema upgrades and refusing a newer schema
  - secret redaction
  - a static scan that fails the build if signing, sending or trade endpoints appear in the code
- Fixtures are real payloads captured on 2026-10-26: PumpPortal messages, GeckoTerminal pages, Jupiter pages and Solana account bytes.

## Live verification (this cloud container, public RPC, no keys)

There were two runs on the same database: 20 minutes, a stop, then 8 more minutes with the fixed code.

| Measure | Result |
|---|---|
| Tokens discovered | 651 in ~28 min (~23/min) |
| Confirmed on-chain | 648. The other 3 were flagged CONFLICT. |
| RPC calls used | ~200 for the whole session (budget 25,000/day) |
| Stream disconnects / silence reconnects | 0 / 0 |
| Rate-limit responses | GeckoTerminal 10, Jupiter 2. All handled; this container shares its IP. |
| Rejected payloads | 0 |
| Restart | Schema upgraded v1→v2→v3 on a live database. The 11-second downtime was recorded as a gap. |

### Provider coverage (venue labels as each provider reports them)

| Provider | What it saw | Saw first | Lag when not first (p50 / p90) |
|---|---|---|---|
| Jupiter Tokens `/recent` | pump.fun 520, LaunchLab 15, Meteora DBC 14, stonkfun 4, **unlabelled 55** | 384 | 20s / 34s |
| PumpPortal stream | pump.fun curve 218, migrations to PumpSwap 11, bonk (LaunchLab) 4 | 224 | n/a (one case: 32s) |
| GeckoTerminal `new_pools` | pump.fun 340, Meteora DAMM v2 44, PumpSwap 44, Meteora DBC 22, LaunchLab 11, plus Orca, Manifest, Raydium, bags.fm | 43 | 61s / 113s |
| DexScreener (cross-check only) | 28 of 30 recent mints known | n/a | n/a |

What this means:
- **No single source covers everything.**
  - PumpPortal only covers pump.fun and bonk launches.
  - Jupiter and GeckoTerminal also cover Meteora and Raydium.
- **149 of 651 tokens were seen by only one provider.** That is why the bot keeps all three.
- **Jupiter is usually first, but only to the poll interval.** It answers a 30-second poll, so it can't beat a live stream on a single launch. PumpPortal sees creates as they happen.
- **GeckoTerminal is about a minute behind.** Use it for coverage of other venues, not speed.
- **DexScreener reports no liquidity figure for 25 of 28 bonding-curve pairs.** It can't be used to judge exit liquidity on the curve.

### What the chain showed

- **607 of 648 confirmed mints are Token-2022.** All of them carry MetadataPointer + TokenMetadata.
- **One token carried every dangerous extension:** PermanentDelegate, TransferHook, TransferFeeConfig, Pausable, DefaultAccountState, ConfidentialTransferMint and ScaledUiAmount.
- **Mint authority still set:** 2 tokens. **Freeze authority still set:** 1 token.
- **6 bonding curves were complete**, meaning migration was pending or done.
- **The bonding-curve address PumpPortal sent matched our own derivation 216 times out of 218.** We derive it locally, so we don't rely on PumpPortal for it.
- **3 conflicts (0.5%), all from PumpPortal.**
  - Two were token-paired launches where PumpPortal put the *quote* mint in its `mint` field. One was the long-existing PUMP token.
  - One had no pump.fun curve at the derived address.
  - Before the fix, this made an old token look brand new.
  - Now such tokens are CONFLICT and never categorized as new launches.

## Data providers verified

| Provider | Status |
|---|---|
| Solana public RPC | Verified live. `getMultipleAccounts` worked with 100 addresses. 4 unexplained HTTP 413s occurred early in the run and could not be reproduced (see limitations). |
| PumpPortal data feed | Verified live: create and migrate message formats were captured. Read-only methods only. |
| GeckoTerminal | Verified live. It rate-limits sooner than its documented 30/min from this shared IP. |
| Jupiter Tokens v2 | Verified live, keyless. |
| DexScreener | Verified live. Cross-check only. |
| Helius | Not yet tested. It needs your free key. The code works with any standard RPC URL. |

## What remains incomplete

- **No trade-level flow yet.** That means buyer counts, wallet sizes and buy/sell imbalance.
  - pump.fun puts trade data in inner instructions, so it costs one RPC call per trade.
  - This moves to Phase 3, for a small watchlist only.
- **The "trending" and "already extended" categories are not assigned yet.** They need price history.
- **Helius has not been exercised.** Its Parsed Streams are not used.
- **Venue labels we don't map:** stonkfun, manifest, orca, bags-fm, and 55 Jupiter tokens with no launchpad label. They stay as `other` until verified.

## Assumptions

- **Creation time.** For a pump.fun token first seen on PumpPortal, we use the time we received the create event. It is labelled `DERIVED`. Any provider timestamp replaces it.
- **Pool times as upper bounds.** An AMM pool's creation time only bounds the token's age from above. It never makes a token "new".
- **SOL curves.** An all-zero `quote_mint` on a curve is read as a SOL curve, as pump.fun's docs say. This is labelled as an assumption.
- **Freshness limits.** 60s stream silence and 4× the poll interval are starting values. In ~28 minutes the stream never went quiet for 60s.

## Risks that remain

- **We are slower than professional snipers.** A free-tier setup reacts in seconds.
- **Provider data can be wrong.** 0.5% of PumpPortal creates were wrong, and that's in a small sample.
- **Public RPC is "not intended for production"** and showed unexplained 413s.
- **Rate limits come from a shared cloud IP.** Your home IP will likely behave differently, and that hasn't been measured.

## Monthly cost

**$0.** No paid services are used. Hosting is your own computer.

## Before the next phase

Nothing is needed from you to start Phase 3. You can add your free Helius and Jupiter keys at any time (see `docs/SETUP.md`).
