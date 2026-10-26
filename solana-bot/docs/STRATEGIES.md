# Strategy Specification (Phase 4)

**Status: research. Nothing here has shown an edge. Every number is a placeholder** (in `src/strategy/strategy*.ts`), to be set from Phase 5 replay and Phase 6 forward-test data and never from the test set.

## The cost bar every strategy must clear

Phase 3 measured these round-trip costs (buy, then sell straight back, CAD 30, before any price move):

| Where | Median |
|---|---|
| pump.fun curve | 3.05% |
| PumpSwap | 1.96% |
| Liquidity over $250k | 0.50% |

Busy pools add priority fees on top.

A setup is only worth taking if its expected move clears **break-even + 2%** and its net reward-to-risk is at least **1.5**. Both are placeholder limits in `src/risk/limits.ts`, and the risk manager enforces them, not the strategy.

## Shared inputs and data rules

- **Source.** Trades are on-chain pump.fun/PumpSwap events from `logsSubscribe` at confirmed commitment. Price = each trade's SOL ÷ tokens.
- **Look-ahead guard.** A trade counts only after it has *arrived* (receivedAt ≤ decision time). Replay uses the same rule.
- **Data quality** (any failure means no signal):
  - fewer than 20 trades in 180 s
  - no trade for 30 s
  - median arrival lag over 10 s
  - a feed gap in the last 180 s
- **Candles.** Built only from real trades, marked sparse below a minimum trade count. Empty intervals are never filled. The strategies use trade-level features, not candle patterns. Whether candles add anything is an open question for Phase 5.
- **Latency.** Live arrival lag was 1–7 s behind on-chain time, and the strategies check every 5 s. Expect to act 5–15 s after a move starts.
- **Bot fingerprints that block a signal:**
  - one wallet more than 25–30% of buy volume
  - more than 30–35% of trades repeating an exact SOL size

## Strategy A: continuation after consolidation

| Item | Rule |
|---|---|
| Allowed when | Prior impulse ≥ 10% (low→high over −300 s to −60 s). The base (−60 s to −10 s) is ≤ 6% wide and has given back ≤ 50% of the impulse. |
| Participation | ≥ 8 buyers in 60 s. Top buyer ≤ 30%. Repeated sizes ≤ 35%. 60 s volume not sell-dominated. |
| Trigger | Last trade ≥ 0.5% above the base high, with ≥ 2 buyers in the last 10 s. |
| Max extension | 3% above the base high. Beyond that it is a chase, so no signal. |
| Invalidation / stop | 0.5% below the base low. |
| Target | Last + 50% of the impulse height. |
| Time exit | 180 s. |
| Cool-down | 5 min per token after a signal. |

## Strategy B: breakout and retest (two variants, measured separately)

| Item | Rule |
|---|---|
| Range | High/low over −300 s to −60 s, ≤ 25% wide. |
| Breakout | The 60 s high cleared the range high by ≥ 2%. ≥ 8 buyers in 60 s, top buyer ≤ 30%. |
| B_retest trigger | The 30 s low came back within +2% of the level without breaking more than 1% below it. Now turning up, with ≥ 2 buyers in 10 s. |
| B_no_retest trigger | Trade rate ≥ 2× the previous 30 s. Price ≥ 2% above the level. Buy imbalance ≥ 0.1. |
| Max extension | 5% above the level. |
| Invalidation / stop | 2% back inside the range. |
| Target | Level + 50% of the range height. |
| Time exit | 240 s. Cool-down 5 min. |

## Strategy C: early acceleration (strictest)

| Item | Rule |
|---|---|
| Allowed when | Token age ≤ 10 min, from a creation time that isn't only an upper bound. Unknown age means no signal. |
| Trigger | ≥ 10 trades in 30 s. Rate ≥ 2× the previous 30 s. ≥ 6 buyers new in the last 30 s. Imbalance ≥ 0.3. Top buyer ≤ 25%. Repeated sizes ≤ 30%. |
| Move filter | +3% to +25% over 60 s: started, not run away. |
| Invalidation / stop | 1% below the 60 s low. |
| Target | +12% (fixed; no structure to measure from). |
| Time exit | 120 s. Cool-down 10 min. |
| Known weakness | The most exposed of the four to manipulation and to our own latency. |

## Strategy D: momentum failure (never opens a position)

| Output | When |
|---|---|
| VETO (blocks entries) | ≥ 6% drop in 30 s. Broad selling (imbalance ≤ −0.4 with ≥ 5 sellers). Poor data. |
| EXIT (for an open position) | Price below invalidation. Back more than 1% below a breakout level. Real SOL on the curve below 70% of what it was at entry. A drop or broad selling while holding. |
| Never | EXIT on bad data alone. The exit engine fetches fresh state first and won't fire blind sells. |

## Exit engine (all strategies)

- **Priority:** emergency → invalidation / liquidity → risk limit → strategy (D) → profit target or trailing → time stop.
- **First match wins**, and every match is logged.
- **Net proceeds:** profit and trailing use a fresh sell quote's net proceeds, not the chart price.
- **No blind sells:** with no verified route or fresh quote, the engine raises an ALERT and doesn't spam sell transactions.
- **Profit modes, measured separately:** full exit at target, or half at target and trail the rest.
- **Trailing:** starts at +4% net and exits on a 3% giveback.

## Promotion evidence

| From → to | Required |
|---|---|
| Research → paper (Phase 5) | Unit tests on every rule (done). Live signals recorded with full feature snapshots (this phase). |
| Paper → forward test (Phase 6) | Replay on recorded tapes with realistic delay, slippage and failed exits. Parameters chosen on a training window, checked on a separate validation window, with an untouched test window. |
| Forward test → live-eligible (Phase 8) | A minimum number of forward paper trades **per strategy**, set in Phase 5 from the variance seen. Expectancy after all costs positive with a confidence bound above zero. Drawdown and largest loss inside limits. Coverage of different market conditions. **A strategy that can't show this is rejected, not tuned until it does.** |

The four strategies are not combined into a score. If they ever are, the weights must be written down and must beat each strategy on its own, out of sample.
