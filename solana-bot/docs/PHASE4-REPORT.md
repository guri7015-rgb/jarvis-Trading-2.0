# Phase 4 Completion Report: Strategies and Deterministic Risk Controls

Date: 2026-10-26. Mode: paper research. No position was opened. Nothing in this phase builds, signs or sends a transaction.

## What was built

| Area | Files |
|---|---|
| Trade events decoded from pump.fun and PumpSwap program logs. An event counts only if the real program printed it; forged copies are rejected. | `src/market/eventDecoder.ts` |
| Live trade feed for a watchlist of up to 3 tokens via Solana `logsSubscribe`, with resubscribe after drops and gap recording. | `src/market/tradeStream.ts` |
| PumpSwap pool decoder (to find where a graduated token trades). | `src/solana/pumpSwapPool.ts` |
| Features from the tape with an arrival-time look-ahead guard, data-quality checks and bot fingerprints. Candles only from real trades. | `src/strategy/features.ts` |
| Strategies A, B (two variants), C, and D (failure: veto or exit, never a position). | `src/strategy/strategy{A,B,C,D}.ts` |
| Risk manager: the spec's 11 entry gates in order; sizing from the loss budget; daily limits persisted across restarts; loosening a limit needs a confirmed file hash. | `src/risk/manager.ts`, `limits.ts`, `riskState.ts` |
| Exit engine with the spec's priority order, net-proceeds profit rules, trailing, time stop, and no blind sells. | `src/strategy/exits.ts` |
| Signal engine: watchlist → trades → features → strategies → risk manager → recorded decision. | `src/strategy/engine.ts` |
| `discover --signals [--research]`, `npm run signals`, `npm run replay` | `src/cli/*` |
| Strategy specification | `docs/STRATEGIES.md` |

## Tests run

- `npm test`: **142 passed, 0 failed**, stable on repeated runs. `npm run typecheck`: clean.
- New tests cover: real captured trade logs (9 curve trades, 1 PumpSwap buy), a forged event from a fake program, truncated logs, the look-ahead guard, sparse/stale/lagged/gapped data, concentration and repeated-size fingerprints, candles from real trades only, each strategy's trigger and refusals on synthetic tapes, D's veto/exit split, every risk gate in order, loss-budget sizing, the daily limits, the limit-file confirmation, restart persistence, and every exit rule and its priority.

## Live research run: 40 minutes, 3 tokens watched

All three were pump.fun tokens that had graduated to PumpSwap. All were research-only, because holder data was unavailable (public RPC), so the risk manager would have rejected any signal at gate 2.

| Token | Trades captured | Distinct wallets | Notes |
|---|---|---|---|
| 2eDh…pump | 2,207 in 32 min | 950 | Busy, then went quiet after minute 20 |
| 3LPT…pump | 491 in 38 min | 234 | Steady |
| GTBx…pump | 107 in 35 min | 77 | Too sparse for signals |

**Feed quality:**
- **Arrival lag** behind on-chain time: p50 4.1 s, p90 7.1 s, max 11.1 s. On-chain time has 1 s precision. Add the 5 s decision cycle and we react 5–15 s after a move starts.
- **Failed transactions:** on the busiest pool, 85% of transactions failed in the first 15 s (315 of 369). Those are bots. The bot counts them and ignores them.
- **The public Solana WebSocket dropped 97 times in 40 minutes**, about every 25 s, for 0.6–1.2 s each. Trades still flowed between drops, but each drop is a window where trades can be missed. **This endpoint is not usable for a trade feed.** Your Helius key is needed (see below).
- **Data quality rule change from this run:** a gap under 2 s is now a warning, not a block. The sparse-trades check still catches lost data. Before the change, every snapshot was blocked for 180 s after each blip.

**Signals:** none. The engine ran 480 cycles. With the blocking-gap rule in force, every cycle was blocked by data quality, so this run says nothing about the strategies.

## Offline replay of the recorded tapes (signal counts only)

`npm run replay` walks the stored trades at 5 s steps with the same look-ahead guard the live engine uses. No fills, no costs, no P&L.

| Token | Steps | Data OK | A | B retest | B no-retest | C | D vetoes |
|---|---|---|---|---|---|---|---|
| 2eDh…pump | 376 | 193 | 0 | 0 | 0 | 0 | 240 |
| 3LPT…pump | 447 | 222 | 0 | 0 | 0 | 0 | 286 |
| GTBx…pump | 409 | 10 | 0 | 0 | 0 | 0 | 399 |

Why nothing fired:
- **A:** "not consolidating" in 180 of 193 usable steps. The 50 s base was never within 6%.
- **B:** "no defined range" in all usable steps. The 240 s range was always wider than 25%.
- **C:** given a fake 60-minute age in replay, so "not new" is expected.
- **D vetoed 60–100% of steps**, mostly on the ≥6% drop in 30 s rule. On these tapes a 6% swing in 30 s is normal.

What this means, plainly: **the placeholder thresholds don't fit these tokens.** That's what Phase 5 calibration is for. It is not evidence for or against any strategy, and nothing should be loosened now just to make a signal appear.

## What remains incomplete

- **No signal has been approved**, so the risk manager's approval path has run only in tests.
- **Holder data still blocks the token gate.** Needs your Helius key.
- **Trade feed on the public endpoint is unreliable.** Needs your Helius key.
- **Strategy C hasn't been exercised live**: no token under 10 minutes old reached the watchlist, because the watchlist comes from gate assessments and new tokens have no trade history yet.
- **No fills, costs or P&L** in replay. Phase 5.

## Assumptions

- Trade price = SOL ÷ tokens from each event. PumpSwap events are read from their fixed prefix; later fields are ignored.
- Token age for C comes only from a creation time that isn't an upper bound.
- Every strategy and risk threshold is a placeholder.

## Risks that remain

- **Latency.** 5–15 s reaction time is slow for 1–5 minute holds on tokens where 6% moves in 30 s are routine.
- **Bot traffic.** 85% failed transactions means we compete with bots that fire blind and fast.
- **Threshold fitting.** Calibrating on the same tapes we then judge on would be fooling ourselves. Phase 5 must split training, validation and test windows.

## Monthly cost

**$0.**

## Before the next phase

1. **Add your free Helius key** (still the only blocker for both the token gate and a stable trade feed).
2. Nothing else. Phase 5 (paper simulator, accounting, replay with costs, tax CSV) can start on "go".
