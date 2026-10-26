# Phase 6: Forward Paper Trading and Calibration

Phase 6 is mostly waiting and recording. The tooling is built; the evidence isn't. This is the routine.

## The loop

1. **Keep the bot running on your Mac.** `caffeinate -i npm run discover -- --assess --signals --paper --dashboard`. Every trade it sees on watched tokens is recorded. Every assessment, signal and paper position too.
2. **Every day or two, share the tape.** In a second Terminal tab:
   ```bash
   cd ~/jarvis-Trading-2.0/solana-bot
   npm run tape -- export
   cd .. && git add solana-bot/tapes && git commit -m "tape" && git push
   ```
   The tape is public on-chain data and the bot's own decisions. No keys, no wallet. I pull it here and run the analysis.
3. **Look at the reports yourself whenever you like**, each in a second tab after `cd ~/jarvis-Trading-2.0/solana-bot`:
   - `npm run signals`: what fired, and which risk check stopped it.
   - `npm run calibrate`: where the data sits against each threshold.
   - `npm run backtest`: modelled results, split train / validation / test. Add `--worst` for the pessimistic cost model.
   - `npm run evidence`: whether any strategy meets the live-eligibility bar. Expect NOT ELIGIBLE for a long time.
4. **After there's enough tape** (days, many tokens): `npm run tune`. It searches a small grid on the train window and scores on validation. If something is positive on both with at least 20 trades each, it writes `data/strategy-params.candidate.json`. Nothing changes until that file is reviewed and renamed to `strategy-params.json`. Then the bot logs the file's hash at start, so every decision is traceable to a known parameter set. The test window is looked at once, at the end, with `npm run backtest`.

## What has to be true before Phase 7

- At least one strategy with 100+ resolved forward-paper trades, positive expectancy after costs that survives fills 1% worse, a 95% lower bound above zero, drawdown and largest loss inside limits, spread over 5+ days. `npm run evidence` checks all of it.
- The same strategy positive on validation AND test in the backtest with the worst-quartile cost model.
- The parameter set it ran with recorded and unchanged for the whole evidence window. Changing parameters restarts the count.

If no strategy gets there, the answer is that no strategy gets there. That is a real result, and cheaper than finding out live.

## Where things stand (2026-10-26)

- About 3 hours of tape on 5 tokens. 0 trades under the default rules.
- The 54-combination tune grid produced no candidate: nothing clears the cost bar on this tape even with looser entry rules, because reward-to-risk after a 4% modelled round trip and a 2% stress allowance stays under 1.5.
- The multi-wallet repeated-size fingerprint is still high (median 58%) even after excluding round sizes. Either these pools really are mostly bots trading identical odd sizes, or the amounts are being set by a UI in a way that makes them repeat. Open question; the rule stays as is.
- Holder data now works with your Helius key, so tokens can pass the gate. None had at the time of writing.

## The open research question

The cost bar is the whole game. Three ways through, to be decided on data:

1. **Target deeper tokens.** The over-$250k liquidity band measured ~0.5% round trips. Setups there need far smaller moves to pay. The bot already assesses them; the watchlist just needs to prefer them.
2. **Find bigger moves.** Strategy targets are fractions of the prior impulse or range. If moves on these tokens are routinely larger than the targets assume, the targets are leaving edge on the table. The tune grid includes target multipliers.
3. **Measure the stress allowance.** It's 2% now, a guess. Hundreds of paper fills will show the real gap between decision quote and fill. If it's smaller, the allowance comes down. If it's larger, it goes up.

None of these is a reason to lower the reward-to-risk floor itself.
