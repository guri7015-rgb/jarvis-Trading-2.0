# Local Setup

## A note on "detect my OS"

I can't see your computer. This development session runs in a Linux cloud container, so anything I detect here describes the container, not your machine. Instructions for all three systems are below. Tell me which one you use and I'll trim this page to it.

To check yourself:
- **macOS:** Apple menu → About This Mac.
- **Windows:** Start → Settings → System → About.
- **Linux:** run `uname -a` in a terminal.

## What you need

- **Node.js 22.13 or newer.** Node 24 LTS is recommended. The bot uses Node's built-in SQLite, which needs 22.13+.
- **Git.**
- No database server, no Docker and no paid services.
- No wallet in this phase.

## macOS

```bash
# Install Node 24 LTS (Homebrew), or use the installer from nodejs.org
brew install node@24
node -v   # must print v22.13+ or v24.x

git clone https://github.com/guri7015-rgb/jarvis-Trading-2.0.git
cd jarvis-Trading-2.0
git checkout claude/solana-meme-coin-bot-arch-31tujw
cd solana-bot
npm ci
cp .env.example .env
chmod 600 .env
```

## Windows

Two options. Native Windows works because the bot needs no compiled add-ons. WSL2 (Ubuntu) also works and matches the cloud container more closely.

**Native (PowerShell):**

```powershell
winget install OpenJS.NodeJS.LTS
node -v
git clone https://github.com/guri7015-rgb/jarvis-Trading-2.0.git
cd jarvis-Trading-2.0
git checkout claude/solana-meme-coin-bot-arch-31tujw
cd solana-bot
npm ci
Copy-Item .env.example .env
```

Restrict `.env` to your user. In File Explorer, open Properties → Security on the file.

**WSL2:** run `wsl --install`, open Ubuntu, then follow the Linux steps.

## Linux (Ubuntu/Debian)

```bash
# Node 24 LTS via nvm (no sudo needed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
. ~/.nvm/nvm.sh && nvm install 24
git clone https://github.com/guri7015-rgb/jarvis-Trading-2.0.git
cd jarvis-Trading-2.0 && git checkout claude/solana-meme-coin-bot-arch-31tujw
cd solana-bot && npm ci && cp .env.example .env && chmod 600 .env
```

## Adding your free keys (do this yourself; never paste them into chat)

1. **Jupiter:**
   - Create a free key at https://developers.jup.ag/portal.
   - Put it after `JUPITER_API_KEY=` in `solana-bot/.env`.
   - Without it, the bot runs keyless at half speed.
2. **Helius:**
   - Create a free-plan key at https://www.helius.dev.
   - Set `SOLANA_RPC_URL` and `SOLANA_WS_URL` to the mainnet URLs Helius gives you. They contain your key.
   - Without it, the bot uses the public Solana endpoint. That endpoint is fine for testing and is "not intended for production".
3. Leave `RPC_DAILY_CALL_BUDGET=25000` unless you have a reason. It keeps the Helius free plan (1M credits a month) from running out.

`.env` is listed in `.gitignore`. Check that it never shows up in `git status`.

## Run

```bash
npm test           # automated tests; no network needed
npm run typecheck
npm run probe      # one-shot check that each data source answers
npm run discover   # live discovery; Ctrl+C to stop (state is saved in ./data)
npm run discover -- --minutes 60
npm run coverage   # report from what discovery has recorded
npm run coverage -- --hours 2 --dexscreener
```

Node prints `ExperimentalWarning: SQLite is an experimental feature` once at startup. That is expected on Node 22 and 24. To hide it, set `NODE_OPTIONS=--no-warnings`.

## Restarting safely

- **Stopping:** Ctrl+C stops cleanly.
- **Crashes:** a crash or power cut is detected on the next start. The time the bot was down is recorded as a data gap.
- **No double-counting:** dedupe keys and the RPC budget live in `data/solana-bot.sqlite`, so a restart never double-counts tokens or resets the budget.
- **Wiping:** to start fresh, stop the bot and delete `data/`. That throws away the discovery history.
