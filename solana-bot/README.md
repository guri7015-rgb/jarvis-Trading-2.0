# solana-bot

Research bot for Solana meme coins. **Paper research only.** No wallet, no signing and no transactions; live trading is a hard-coded `false`.

It is separate from the forex/crypto app in the parent folder and shares no code with it.

## Status

| Phase | State |
|---|---|
| 1. Architecture | Done: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 2. Discovery, normalization, freshness, provider health | Done: [docs/PHASE2-REPORT.md](docs/PHASE2-REPORT.md) |
| 3. Safety gate, liquidity, quotes, cost measurement | Not started |
| 4–9 | Not started. Live trading needs your explicit written approval. |

## Quick start

See [docs/SETUP.md](docs/SETUP.md). In short:

```bash
npm ci && cp .env.example .env   # add your own free keys locally, never in chat
npm test
npm run probe
npm run discover -- --minutes 30
npm run coverage
```

## Layout

```
src/core/        types (with evidence labels), config, clock, redacting logger
src/net/         HTTP client (rate limits, 429 handling, retries, size caps), reconnecting WebSocket
src/health/      provider health + fail-closed discovery gate
src/solana/      read-only RPC with daily budget, mint and pump.fun curve decoders
src/providers/   PumpPortal (read-only feeds), GeckoTerminal, Jupiter Tokens, DexScreener
src/discovery/   token registry (dedupe, merge, ordering), on-chain confirmer
src/storage/     SQLite schema, sessions and gaps
src/app/         service wiring
src/cli/         discover, coverage, probe
test/            unit, integration and failure-injection tests; fixtures are real captured payloads
docs/            architecture, research, legal/terms, setup, phase reports
```

## Evidence labels

Every fact is tagged with where it came from:
- `ONCHAIN_CONFIRMED`: read by us from Solana at a known slot.
- `PROVIDER_REPORTED`: a third party said so.
- `DERIVED`: computed by us, and no stronger than its weakest input.

The chain wins when they disagree. A disagreement is recorded as `CONFLICT`.
