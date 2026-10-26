# Local Setup (Mac)

Everything runs on your Mac. No database server, no Docker, no paid services, and no wallet in this phase.

## 1. Install Node

The bot needs Node 22.13 or newer. Node 24 LTS is recommended.

Open Terminal and run:

```bash
# If you have Homebrew:
brew install node@24
# Otherwise download the macOS installer from https://nodejs.org (LTS).
node -v
```

`node -v` must print `v22.13` or higher, or `v24.x`.

## 2. Get the code

```bash
git clone https://github.com/guri7015-rgb/jarvis-Trading-2.0.git
cd jarvis-Trading-2.0
git checkout claude/solana-meme-coin-bot-arch-31tujw
cd solana-bot
npm ci
cp .env.example .env
chmod 600 .env
```

## 3. Add your free keys (you do this; never paste them into chat)

1. **Jupiter.** Create a free key at https://developers.jup.ag/portal. Put it after `JUPITER_API_KEY=` in `solana-bot/.env`. Without it, the bot runs keyless at half speed.
2. **Helius.** Create a free-plan key at https://www.helius.dev. Set `SOLANA_RPC_URL` and `SOLANA_WS_URL` in `.env` to the mainnet URLs Helius gives you. They contain your key. **This one matters:** the public Solana endpoint refuses holder data, so without Helius every token fails the safety gate.
3. Leave `RPC_DAILY_CALL_BUDGET=25000` alone. It keeps the Helius free plan (1M credits a month) from running out.

`.env` is in `.gitignore`. It should never show up in `git status`.

## 4. Run

```bash
npm test                                   # automated tests, no network needed
npm run probe                              # one-shot check that each data source answers
npm run discover -- --minutes 60           # discovery only
npm run discover -- --assess --minutes 60  # also price CAD 30 round trips (quotes only)
npm run discover -- --assess --signals     # also watch trades and record strategy decisions (paper only)
npm run coverage                           # discovery report
npm run costs                              # cost report
npm run signals                            # strategy and risk report
```

Ctrl+C stops the bot cleanly. State is saved in `solana-bot/data/`.

Node prints `ExperimentalWarning: SQLite is an experimental feature` once at startup. That's expected. To hide it:

```bash
export NODE_OPTIONS=--no-warnings
```

## 5. Keeping it running (for Phase 6 forward testing)

Your Mac must stay awake. In System Settings → Battery (or Energy), turn off "Put hard disks to sleep" and set the display to sleep but not the computer. Or run the bot with:

```bash
caffeinate -i npm run discover -- --assess --signals
```

`caffeinate -i` stops the Mac from idling to sleep while the bot runs.

## Restarts

- A crash or power cut is noticed on the next start. The downtime is recorded as a data gap.
- Dedupe keys, the RPC budget and daily risk limits live in `data/solana-bot.sqlite`. A restart never double-counts tokens or resets a loss limit.
- To start fresh, stop the bot and delete `data/`. That throws away all history.
