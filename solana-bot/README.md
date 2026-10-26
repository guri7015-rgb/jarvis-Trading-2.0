# solana-bot

Research bot for Solana meme coins. **Paper research only.** No wallet, no signing and no transactions; live trading is a hard-coded `false`.

It is separate from the forex/crypto app in the parent folder and shares no code with it.

## Status

| Phase | State |
|---|---|
| 1. Architecture | Done: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 2. Discovery, normalization, freshness, provider health | Done: [docs/PHASE2-REPORT.md](docs/PHASE2-REPORT.md) |
| 3. Safety gate, liquidity, quotes, cost measurement | Done: [docs/PHASE3-REPORT.md](docs/PHASE3-REPORT.md). Holder checks need your Helius key. |
| 4. Strategies A–D, risk manager, exit engine | Done: [docs/PHASE4-REPORT.md](docs/PHASE4-REPORT.md), [docs/STRATEGIES.md](docs/STRATEGIES.md). Zero signals on real tapes with placeholder thresholds. |
| 5. Paper simulator, accounting, backtest, dashboard, tax export | In progress: [docs/PHASE5-REPORT.md](docs/PHASE5-REPORT.md) |
| 6–9 | Not started. Live trading needs your explicit written approval. |

## Quick start

See [docs/SETUP.md](docs/SETUP.md). In short:

```bash
npm ci && cp .env.example .env   # add your own free keys locally, never in chat
npm test
npm run probe
npm run discover -- --minutes 30
npm run coverage
npm run discover -- --assess --minutes 30   # also price CAD 30 round trips (quotes only)
npm run costs
npm run discover -- --assess --signals --research   # watch live trades, record strategy/risk decisions
npm run signals                                      # strategy and risk report
npm run replay                                       # strategies over the recorded tape (counts only)
npm run discover -- --assess --signals --paper --dashboard   # paper trading with the local dashboard at http://127.0.0.1:4777
npm run backtest                                     # recorded tapes with modelled fills, split train/validation/test
npm run export                                       # positions.csv and orders.csv for your records
```

## Layout

```
src/core/        types (with evidence labels), config, clock, redacting logger
src/net/         HTTP client (rate limits, 429 handling, retries, size caps), reconnecting WebSocket
src/health/      provider health + fail-closed discovery gate
src/solana/      read-only RPC with daily budget, mint, token-account and pump.fun curve decoders
src/market/      Jupiter quotes (read-only), SOL/CAD from Jupiter + Bank of Canada
src/risk/        tradability gate, policy (placeholder thresholds), costs, holders, curve fee check
src/assess/      assessor: picks candidates and runs the gate
src/strategy/    features, strategies A-D, exit engine, signal engine
src/paper/       ledger, paper executor, paper trader, backtester, CSV export
src/dashboard/   local dashboard (127.0.0.1 only)
src/providers/   PumpPortal (read-only feeds), GeckoTerminal, Jupiter Tokens, DexScreener
src/discovery/   token registry (dedupe, merge, ordering), on-chain confirmer
src/storage/     SQLite schema, sessions and gaps
src/app/         service wiring
src/cli/         discover, coverage, probe, costs, signals, replay, backtest, export
test/            unit, integration and failure-injection tests; fixtures are real captured payloads
docs/            architecture, research, legal/terms, setup, strategies, testing guide, security, phase reports
```

## Evidence labels

Every fact is tagged with where it came from:
- `ONCHAIN_CONFIRMED`: read by us from Solana at a known slot.
- `PROVIDER_REPORTED`: a third party said so.
- `DERIVED`: computed by us, and no stronger than its weakest input.

The chain wins when they disagree. A disagreement is recorded as `CONFLICT`.
