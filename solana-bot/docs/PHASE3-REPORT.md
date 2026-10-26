# Phase 3 Completion Report: Token Risk, Liquidity, Quotes, Tradability

Date: 2026-10-26. Mode: paper research. Nothing in this phase signs, simulates or sends a transaction. Jupiter is asked for quotes only (`GET /swap/v1/quote`).

## What was built

| Area | Files |
|---|---|
| Quote client. It checks every answer matches the request (mints, amount, mode), that the route connects input to output, and that minimum-out ≤ out. Jupiter's 400 "no route" is treated as an answer, not an outage. | `src/market/quotes.ts` |
| SOL→CAD: Jupiter SOL/USD × Bank of Canada USD/CAD. Both timestamps are kept, and stale or out-of-range rates are refused. | `src/market/fx.ts` |
| Holder concentration from the chain. Pool and curve vaults and burns are excluded. No wallet clustering. | `src/risk/holders.ts`, `src/solana/tokenAccount.ts` |
| Round-trip cost: buy, then immediately sell the same tokens. Covers venue fees, price impact both ways, network fees and rent, plus the break-even move. | `src/risk/costs.ts` |
| Implied pump.fun curve fee: quotes checked against live reserves. | `src/risk/curveCheck.ts` |
| Deterministic tradability gate. Every failure is recorded with the observed value, the limit and the evidence. Missing data always rejects. | `src/risk/gate.ts` |
| Risk policy. **Every threshold is a labelled placeholder.** | `src/risk/policy.ts` |
| Assessor. Picks launchpad tokens, rotates through liquidity bands, respects the RPC budget and recheck cool-downs, and has a circuit breaker when the RPC refuses holder data. | `src/assess/assessor.ts` |
| `npm run discover -- --assess`, `npm run costs` | `src/cli/*` |

## Tests run

- `npm test`: **113 passed, 0 failed**, stable across repeated runs.
- `npm run typecheck`: clean.
- The new tests use real captured Jupiter quotes, Bank of Canada and Jupiter price payloads, and real curve and mint bytes. They cover:
  - answers that don't match the question
  - disconnected routes
  - "no route" not being counted as an outage
  - the API key going only in a header
  - stale FX rates
  - cost arithmetic on a real round trip
  - backing out the curve fee
  - every gate rule, and fail-closed on each missing input
  - the buy-but-can't-sell case
  - recheck cool-downs
  - the circuit breaker
  - budget skips
  - the launch-venue filter
  - the mayhem and thin-reserve rules
  - the oldest 49-byte curve layout

## Live measurement: 80 assessments in 45 minutes

Setup: CAD 30 per assessment (≈0.21 SOL at SOL/CAD 140.4–141.7), keyless Jupiter, public Solana RPC.

### Round-trip cost before any price movement

This is what buying CAD 30 and immediately selling it back would have cost, from executable quotes plus estimated network fees.

| Group | n | p25 | **p50** | p75 | p90 |
|---|---|---|---|---|---|
| All with both quotes | 68 | 0.63% | **2.06%** | 3.07% | 8.75% |
| pump.fun bonding curve | 9 | 2.91% | **3.05%** | 3.79% | 3.84% |
| PumpSwap (graduated pump.fun) | 23 | 1.06% | **1.96%** | 2.17% | 2.67% |
| Meteora DLMM | 12 | 0.13% | **0.60%** | 0.64% | 1.30% |
| Meteora DAMM v2 | 4 | 3.26% | **4.07%** | 5.07% | 5.07% |
| Reported liquidity < $10k | 7 | 2.88% | **3.05%** | 3.20% | 3.84% |
| $10k–50k | 12 | 2.17% | **2.67%** | 3.26% | 5.09% |
| $50k–250k | 20 | 1.95% | **1.96%** | 2.13% | 5.07% |
| > $250k | 21 | 0.12% | **0.50%** | 0.63% | 0.66% |

**What this means for a 1–5 minute scalper:**
- On the pump.fun curve, a typical round trip costs about **3%** before the price moves at all. A trade needs more than a 3% move just to break even.
- After graduation (PumpSwap) it's about **2%**.
- Only tokens with over $250k of liquidity get under 1%. They are older and are not "new launches".
- The cheapest tokens to trade are not the newest ones.

### pump.fun fee, verified two ways

- The quotes, checked against live curve reserves, imply a fee of **125 bps per side** at the median (buy n=18, sell n=9). That is exactly the 1.25% in pump.fun's fee docs.
- Phase 1's "1%" figure was wrong, and was corrected in Phase 2.

### Exit trap found and blocked: mayhem-mode curves

- **10 tokens could be bought but not sold back** at the same size.
  - 9 were pump.fun **mayhem-mode** curves. They had large virtual reserves (up to 441 SOL), which set the price and the displayed liquidity (up to $32k). They held almost no real SOL (0 to 0.013 SOL).
  - A sell is paid from real SOL only.
  - Selling 1,000 tokens quoted fine. Selling the CAD 30 position never did.
  - The 10th was a LaunchLab token routed through an unknown venue with 100% reported price impact.
- **Two new rules** now reject these up front, from on-chain data:
  - `MAYHEM_MODE_CURVE`
  - `CURVE_REAL_SOL_THIN`: real SOL must be at least 5× the position (placeholder).

### Why tokens were rejected (80 assessments; a token can fail several rules)

| Rule | Count | Note |
|---|---|---|
| HOLDER_READ | 80 | The public RPC refused holder data every time (HTTP 429). It needs your Helius key. |
| BUY_IMPACT / SELL_IMPACT | 21 / 14 | Over 3% (placeholder) |
| BUY/SELL_ROUTE_VENUE | 14 / 12 | Routes through unverified venues: GoonFi, TesseraV, Kipseli, BisonFi, Manifest, Byreal, Obsidian, Hadron, Deriverse |
| NO_SELL_ROUTE | 10 | See exit trap above |
| ROUND_TRIP_COST | 8 | Over 6% (placeholder) |
| ROUTE_HOPS | 6 / 5 | More than 2 hops |
| NO_BUY_ROUTE | 2 | |
| TOKEN_EXTENSION | 1 | |

**PASS: 0.** No token passed, because holder data was never available. That is the gate failing closed as designed, not a verdict on the tokens. Even with holder data, a PASS only means no automated check objected. It does not mean safe.

### Other numbers

- **Priority fees:** the estimate on the pools we'd trade was p50 0, p75 12,185 and p90 200,000 µlamports/CU.
  - At an assumed 200k compute units (a placeholder), the p90 is about 0.04 SOL per transaction. That's roughly CAD 5.6, about a fifth of a CAD 30 position, each way.
  - Priority fees on busy pools could cost more than the trade can make. Phase 5 must measure real compute units.
- **Chain conflicts:** 9 of 1,455 tokens confirmed in this window conflicted with the chain (0.6%). Coverage and the conflict rule behaved as in Phase 2.
- **The oldest pump.fun curve layout (49 bytes, no creator)** turned up on graduated tokens. The decoder used to reject it. That's fixed, and the affected tokens are re-queued.

## Data providers verified in this phase

| Provider | Status |
|---|---|
| Jupiter `swap/v1/quote` (keyless) | Verified live. It covers pump.fun curve, PumpSwap, Meteora, Raydium, Orca and many smaller venues. No-route answers are HTTP 400 `NO_ROUTES_FOUND`. |
| Jupiter `tokens/v2/toptrending` and `toptraded` (5m) | Verified live. Same token format as `/recent`. They include large established tokens, so the bot filters to launchpad tokens. |
| Jupiter Price v3 | Verified live (SOL/USD). |
| Bank of Canada Valet `FXUSDCAD` | Verified live. It is a daily rate; the latest observation was 2026-10-23 (the Friday). |
| Solana RPC `getTokenLargestAccounts` | **Refused (HTTP 429) every time on the public endpoint.** It needs a keyed RPC. Not yet verified on Helius. |
| Solana RPC `getRecentPrioritizationFees` | Verified live. |

## What remains incomplete

- **Holder checks have never run live.** They need your Helius free key. Until then, every token is rejected on `HOLDER_READ`.
- **No per-trade flow yet** (buyer counts, wallet sizes, buy/sell balance). It's needed by the Phase 4 strategies; budget rules apply.
- **No transaction simulation.** That needs a built transaction, which is Phase 7/9 territory. Quotes are not proof that a swap would execute.
- **Venue allowlist decision** (yours): the unverified venues above are rejected. That removes some routes, including two-hop routes into USDC-paired curves.
- **Compute units per swap are assumed (200k), not measured.**

## Assumptions

- **Round-trip cost is a snapshot.** It is buy-then-sell priced on the same pre-trade state. It describes cost at that moment, not what a 1–5 minute hold would see.
- **Jupiter's `priceImpactPct` is used as reported** (PROVIDER_REPORTED). Our own cost figure comes from the quoted amounts, not from that field.
- **Rent:** the token-account rent (≈0.0021 SOL) is shown separately and is not in the total. It comes back only if the account is closed after selling.
- **Placeholders:** every threshold in `src/risk/policy.ts` is one.

## Risks that remain

- **Costs vs. holding time.** At the measured costs, the planned 1–5 minute holds on new tokens must move about 3% just to break even, more in busy periods because of priority fees. Phase 4–6 must show an edge bigger than that. If they can't, the right outcome is no trading.
- **Displayed liquidity can be fake.** Mayhem curves show it. Other ways of faking it may exist that the bot doesn't detect yet.
- **Speed.** Free-tier speed is unchanged: seconds, not milliseconds.

## Monthly cost

**$0.** The Bank of Canada API is free and official. Everything else is free tier.

## Before the next phase

1. **Add your free Helius key** so holder checks can run (see `docs/SETUP.md`). This is the only blocker on the gate.
2. **Decide on the unverified venues.** Keep rejecting them (recommended for now), or ask me to research specific ones.
3. **Phase 4 (strategies A–D and the risk manager) can start without either item.** It is paper only.
