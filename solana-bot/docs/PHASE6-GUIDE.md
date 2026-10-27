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

## Explore mode: making paper positions happen

Under the default rules no strategy has opened a paper position, because nothing clears the cost bar. That is a real result, but it leaves the execution side unmeasured: how far fills land from the quote, how often a simulated sell fails, whether the 2% stress allowance is right. Explore mode exists for that.

```bash
caffeinate -i npm run discover -- --assess --signals --paper --explore --dashboard
```

What it changes, all paper:
- Entry edge floors: reward-to-risk 1.0 instead of 1.5, no minimum edge over break-even.
- Strategy thresholds: looser A, B and C entry rules (`EXPLORE_PARAMS`). D, the veto, is unchanged.
- Data quality: 10 trades in 3 minutes instead of 20, a minute of silence allowed instead of 30 s.
- Watchlist: 6 coins instead of 3, cheapest round trip first.

What it does not change: position size, loss per trade, daily loss, entries per day, one position at a time, the losing-streak cool-down, the stress allowance, every token safety gate.

Positions are stored under mode `paper_explore`. `npm run evidence` reports them on one line and excludes them from eligibility. Expect them to lose money on average; the point is the fill data, not the P&L.

## Scanner: seeing a move within seconds

The normal pipeline subscribes to a coin's trades only after it passes the safety check, then waits for 3 minutes of history. That is why signals were minutes late. `--scan` adds one firehose over the whole pump.fun and PumpSwap programs, ranks every coin's last 60 seconds in memory, and pushes the top movers into a fast lane of the safety check. When a mover is watched, its last 3 minutes of trades are backfilled from the scanner, so strategies can judge it on the first tick.

```bash
caffeinate -i npm run discover -- --assess --signals --paper --explore --scan --dashboard
```

Mover rules (`DEFAULT_SCANNER_RULES`): at least 12 trades and 8 distinct buyers in 60 s, net buying of 0.3 SOL or more, price up 3% to 80% over 60 s, at least 3 trades in the last 15 s. The dashboard shows the top 10 with their status in the pipeline.

Load measured on the free public RPC: about 700 transactions a second, two-thirds of them failed bot transactions, 157 MB of memory. Watch your Helius usage the first day; the scanner's WebSocket traffic is separate from the daily RPC call budget the bot counts.

## The desk: http://127.0.0.1:4777/desk

A dark screen meant to stay open. Runs whenever `--signals` and `--dashboard` are on.

- **Market right now.** One word (RISK ON, MIXED, RISK OFF) from how many of the 8 big coins are up over 24 h, plus BTC, ETH and SOL moves and how busy the meme market is. Price and trade data only; no news feed is connected, and the screen says so.
- **BUY NOW.** Meme-coin scalps that cleared every gate, in plain words: buy up to, sell at, get out at, max CAD, done within N minutes. Flashes green and beeps (turn sound on once; the browser needs a click).
- **WATCH.** Good pattern, failed the cost gate or a daily limit. Says why in one sentence.
- **LONG / SHORT.** Hourly Donchian breakouts on BTC, ETH, SOL, XRP, DOGE, ADA, AVAX, LINK from Coinbase public candles. When a coin's range is holding instead, a RANGE TRADE at its bottom or top fifth (stop just outside the range). Every plan: go long/short between A and B, three targets at 1x, 2x, 3x the stop distance (range: middle, far side, beyond), get out at, size for CAD 2.50 of risk. Hold hours to a day.
- **Bias.** Each big coin's tile shows its lean on the day, 4 h and 1 h (▲ ▼ ▬): close against the 20-period average and the average's slope. Plans are tagged WITH TREND or AGAINST TREND by the daily lean, FLAT MARKET when there is none. The scorecard will show whether that tag matters.
- **SWING.** The same rule on daily candles. Hold days to weeks. Rare.
- Tags on every card: FRESH, REWARD x× RISK, TRIP COSTS n%, N MIN MAX, VOLUME x×, STOP n%. `--no-majors` turns the big-coin desk off.
- **Scorecard.** Every valid setup gets its USD price stamped when it appears and again at 1, 5, 30 minutes and 4 hours. "Beat cost" is the share whose move exceeded the signal's own round-trip estimate. Until that number is high over hundreds of signals, nothing here is an edge.

## The board: http://127.0.0.1:4777/board

A coin moves left to right. The whole trip can take five minutes.

1. **LAUNCHED.** Born in the last 3 minutes, newest on top, with buyers per minute from the scanner.
2. **QUICK TEST PASSED.** The assessor's quick pass: mint and freeze revoked, not a mayhem curve, sells back, real SOL in it, trip cost known. No holder read, so it takes seconds. The full check with holders is queued right behind it; a quick-only coin is watched but cannot be entered until the full check passes.
3. **BUY EARLY.** Strategy C fired: brand new, buyers piling in, not run away yet.
4. **DIP HUNT.** Strategy E fired: it ran at least 15%, pulled back 20 to 60% of the run, bounced 2 to 10% off the low, with 3+ buyers in 10 s, 4+ new wallets in 30 s and buying outweighing selling. "Buyers back" is distinct wallets on chain, not chatter.
5. **SELL.** Strategy D fired on a watched coin: dump, broad selling, failed breakout, liquidity leaving. Shown whether or not we hold it.

The line at the top is the one thing to do right now: the newest BUY that cleared every gate in the last 3 minutes, else the newest SELL, else nothing. Every card carries the live price and whether it is still in the entry zone, gone above it, stopped out or at target.

## Drill mode: a forced paper trade every 5 minutes

For exercising fills and exits only. No strategy. Every 5 minutes, if nothing is open, the bot buys a paper position in the watched coin with the cheapest fresh PASS, with a fixed plan: stop 5% below, target 8% above, 10-minute time stop, the normal D veto and liquidity exits.

```bash
caffeinate -i npm run discover -- --assess --signals --paper --drill --dashboard
```

For a short burst, `--drill-every 30 --drill-hold 60` tries an entry every 30 seconds and holds each for at most a minute; add `--minutes 10` to stop by itself. `--drill-max-open 6` lets the drill hold up to six positions at once (paper only, owner's written request; the per-trade size and loss caps still apply to each).

`--drill-unsafe` bypasses the token safety gate for drill entries: any assessed coin joins the watchlist and can be entered. Costs are assumed at 4% where unmeasured. Expect failed sells and stuck positions; that is the point of seeing it on paper.

Same position size (CAD 35 max) and planned loss per trade (CAD 2.50). The entry count is unlimited and the paper daily loss cap is CAD 25, so a session lasts long enough to produce data. Expect it to lose steadily: every entry pays the round trip with no edge behind it. Positions are stored under mode `paper_drill` and never count toward anything.

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
