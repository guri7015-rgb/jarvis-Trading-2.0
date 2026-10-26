# Phase 5 Completion Report: Paper Trading, Accounting, Replay, Dashboard

Date: 2026-10-26. Mode: paper. No wallet exists. No transaction has ever been built, signed or sent.

## What was built

| Area | Files |
|---|---|
| Paper ledger: append-only orders and fills, positions with a forward-only state machine (PROPOSED → ENTRY_PENDING → OPEN → EXIT_PENDING → CLOSED, or FAILED / STUCK), idempotent transitions, itemised fees and rent, SOL accounting with CAD at the stored FX rate | `src/paper/ledger.ts` |
| Paper executor: quote at decision, simulated 4–12 s delay, fresh quote, 1% haircut, 10% failure draw that still pays fees, minimum-out enforcement, no-route reporting | `src/paper/executor.ts` |
| Paper trader: entries sized from the risk decision, fresh sell-quote marks every 10 s, exit engine, STUCK positions with alerts and no sell spam, daily loss and streak accounting | `src/paper/trader.ts` |
| Engine cycle: entries and exits every 5 s; exits run even when entries are halted; one position at a time; pending orders block new entries | `src/strategy/engine.ts` |
| Backtester: same strategies, risk manager and exits over recorded tapes with MODELLED fills and a per-venue cost model; chronological train / validation / test split; full statistics | `src/paper/backtest.ts`, `src/cli/backtest.ts` |
| Calibration report: where recorded data sits against every threshold | `src/cli/calibrate.ts` |
| Local dashboard at 127.0.0.1:4777 with everything in spec §17, plus a manual halt that blocks entries only | `src/dashboard/*` |
| CSV export of positions and orders with FX provenance | `src/paper/exportCsv.ts`, `src/cli/export.ts` |
| Testing guide, security checklist | `docs/TESTING-GUIDE.md`, `docs/SECURITY.md` |

## Tests run

- `npm test`: **166 passed, 0 failed**, stable across repeated runs. `npm run typecheck`: clean.
- New tests cover: ledger idempotence and cash accounting; refusing to sell more than held; fills at the fresh quote minus haircut; slippage past minimum-out during the delay; simulated failures that still pay fees; missing sell routes; position sizing from the decision; failed entries counted as losses; profit on net proceeds; invalidation losses hitting the daily budget; STUCK positions that alert once, never spam, and can still close when the route returns; time stops; the kill switch; equity snapshots; backtest fills only from trades that had arrived; cost-bar rejection of a textbook setup; summary statistics; window splitting; CSV escaping and FX provenance; dashboard state, localhost binding, and the halt closing nothing.

## Live paper run: 40 minutes, cloud container, public RPC, no keys

| Measure | Result |
|---|---|
| Tokens watched | 3 graduated pump.fun tokens on PumpSwap, all research-only (no holder data) |
| Trades recorded | 11,931 (one token alone: 9,534 in 37 min, 1,247 wallets) |
| Arrival lag behind chain | p50 4.4 s, p90 7.8 s, max 11.7 s |
| Snapshots with usable data | 144 of 232 (rest sparse or stale on the quiet token) |
| Strategy signals | **0** |
| Paper positions | **0** |
| Paper account | 3.5584 SOL at start, 3.5584 SOL at end (CAD 500 at 140.5) |
| Public WebSocket drops | 71 in 40 min, each under 1.2 s; now warnings, not blocks |

**Your Mac, first minutes:** 192 tokens found and 191 confirmed in about two minutes, zero rate-limit hits on GeckoTerminal and Jupiter (the cloud session hit dozens), paper account initialised at CAD 500. The first token assessed was rejected for a transfer-fee extension, unverified venues and an 8.34% round trip.

## Backtest on all recorded tapes (modelled)

5 tokens, about 3 hours of tape, 2,428 decision steps.

- **Signals: 2** (both strategy A, both in test windows).
- **Trades: 0.** Both signals were rejected at the **COSTS** gate: with a modelled 4% round trip plus the 2% stress allowance, a ~3% stop can't reach a 1.5 reward-to-risk ratio.
- The same thing happens to a hand-built textbook setup in `test/backtest.test.ts`. That test documents it on purpose.

**What this means.** The risk manager is doing what it was told. The cost bar on these tokens is higher than the setups' expected moves. There are three ways out, and all of them are research decisions for Phase 6, made on a train window and checked on validation: find tokens with lower costs (the >$250k liquidity band measured ~0.5%), find setups with larger expected moves, or show that the stress allowance is too conservative. Loosening the reward-to-risk limit to make trades appear is not one of them.

## Calibration: what the recorded tokens look like (1,286 usable snapshots)

| Rule | Share of snapshots that pass | Comment |
|---|---|---|
| A: impulse ≥ 10% and base ≤ 6% together | 32% | The shape exists often. |
| A: top buyer ≤ 30% of volume | 34% | One wallet usually dominates a minute of buying. |
| A: repeated exact sizes ≤ 35% | 33% | Median 67% of trades repeat a size. Probably too crude: round sizes like 0.01 SOL repeat across many wallets. Should count repeats per wallet. Not changed. |
| B: defined range and a ≥ 2% breakout together | 8% | |
| B and C: trade rate ≥ 2× the previous 30 s | 6% | The binding constraint for both. |
| D: veto on a 6% drop in 30 s | fires 9% of the time | Reasonable. |

## What remains incomplete

- **No approved signal has run through the live paper path.** Entry and exit mechanics are proven in tests with a fake quote client, not yet on a live quote. That happens when a token passes the gate (needs Helius) and a strategy clears the cost bar (needs calibration).
- **Strategy C never ran on a token under 10 minutes old.** The watchlist comes from gate assessments, which need trade history.
- **Repeated-size fingerprint is too crude** (above).
- **Cost model is a median.** The backtester should also run a worst-quartile case.
- **Priority fees in paper fills use a fixed cap ÷ 10**, not a live estimate.

## Assumptions

- Modelled fills are priced from the first trade that arrived after decision time plus simulated latency. Real fills can be worse.
- 10% fill failure and 1–2% no-route rates are guesses, chosen to be pessimistic.
- CAD P&L uses the FX rate at entry (Jupiter SOL/USD × Bank of Canada USD/CAD), both timestamped.

## Risks that remain

- **The cost bar.** Nothing yet shows any strategy can beat 3–4% round-trip costs on new tokens at 5–15 s reaction time. It may not be possible on the curve. The higher-liquidity, lower-cost tokens are the more plausible place to look.
- **Small samples.** Three hours of tape on five tokens proves machinery, not edge.
- **Public RPC** is unusable for a trade feed (71 drops in 40 min). Helius free plan is the fix.

## Monthly cost

**$0.** Hosting is your Mac.

## Before Phase 6

1. **Helius key in `.env`** on your Mac. This unblocks the token gate and the trade feed.
2. **Leave the bot running** for days. Phase 6 is forward paper trading, and tape is what it needs.
3. **Decide on the cost question** with me after a few days of tape: which liquidity band to target first.

Live trading stays off until Phase 8 and your written approval.
