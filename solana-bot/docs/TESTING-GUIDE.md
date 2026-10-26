# Backtesting and Forward-Testing Guide

This covers the three ways the bot is tested, what each can and can't tell you, and the rule for moving a strategy forward.

## 1. Automated tests

```bash
npm test
```

166 tests. No network. They use real captured payloads (Jupiter quotes, Solana account bytes, PumpPortal messages, pump.fun trade logs) and failure injection: dropped sockets, rate limits, stale data, forged events, failed fills, vanished sell routes, restarts.

Run them after every change. A failing test is fixed, never skipped or weakened.

## 2. Replay and backtest on recorded tapes

The bot records every trade it sees for watched tokens. Two commands replay that tape:

```bash
npm run replay     # how often each strategy would have fired; no fills, no P&L
npm run backtest   # same strategies, risk manager and exits, with MODELLED fills and P&L
```

**What "modelled" means.** There are no historical Jupiter quotes. The backtester prices a fill from the first trade that arrived after the decision plus a simulated 4–12 s delay, then applies a per-venue cost model: venue fee, price impact and a 1% haircut per side, 10% failed fills, and 1–2% of sells finding no route. The venue numbers come from Phase 3's live measurements (`docs/PHASE3-REPORT.md`). They are averages. A real fill on a thin token can be worse.

**Windows.** Each tape is split by time into train (first 50%), validation (next 25%) and test (last 25%). The rule:

- Tune thresholds on **train** only.
- Check them on **validation**. If they fail, go back to train.
- Look at **test** once, at the end. Never tune on it. If you do, it stops being a test.

**What it reports.** Per window and per strategy: trade count, win rate, average win and loss, expectancy per trade after costs, profit factor, net P&L in SOL and CAD, max drawdown, largest loss, longest losing streak, time in market, and exit reasons.

**What it can't tell you.** The recorded tapes so far are 40 minutes on three tokens. That's enough to prove the machinery, not a strategy. Expect to need days of tape across many tokens before any number means anything.

## 3. Forward paper trading (live data, simulated fills)

```bash
npm run discover -- --assess --signals --paper --dashboard
```

Open http://127.0.0.1:4777 to watch. Every entry uses a real Jupiter quote at decision time, waits a simulated 4–12 s, re-quotes, and fills at the fresh quote minus a 1% haircut. 10% of fills fail and still pay network fees. Exits use fresh sell quotes. A position whose sell route disappears goes STUCK and raises an alert; it's retried every tick, never spammed.

Each position records: both quotes, the delay, the slippage between them, fees, rent, the exit reason, and the FX rate with its timestamps.

```bash
npm run signals   # what fired and why
npm run export    # positions.csv and orders.csv in data/export/
```

**Minimum evidence before anything moves toward live.** Per strategy, not pooled:

- At least 100 closed forward-paper trades. Fewer than that and a 55% win rate is indistinguishable from 45%.
- Expectancy after all costs positive, and still positive if every fill were 1% worse.
- Max drawdown and largest loss inside the limits in `src/risk/limits.ts`.
- Trades spread across different days, hours and liquidity bands, not one lucky afternoon.
- Failed and stuck positions included in the numbers, never filtered out.

A strategy that can't show this is rejected. It is not tuned until it passes, because that would be fitting to noise.

## 4. Things that make results look better than they are

- **Survivorship.** Only watching tokens that were still trading. The watchlist drops idle tokens after 10 minutes, which is a mild form of this. Note it in any report.
- **Look-ahead.** Using a trade before it arrived. The features check arrival time; the backtester fills only from trades that had arrived. If you change either, re-read `test/phase4.test.ts` "no look-ahead" first.
- **Cost optimism.** Modelled costs are medians. Report the worst quartile too.
- **Tuning on test.** See above.
- **Small samples.** Report confidence, not just averages. Ten trades prove nothing.

## 5. Data gaps and restarts

The bot records every window where it wasn't running or its feed dropped, in the `gaps` table. Features treat a gap of 2 s or more in the last 3 minutes as a reason not to signal. `npm run coverage` lists the gaps.

On restart, dedupe keys, the RPC budget, the daily loss limit, the losing streak and any manual halt all come back from the database. A restart never resets a limit.
