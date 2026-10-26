# Solana Meme-Coin Scalping Bot — Phase 1 Architecture Report

Status: **Phase 1 (research and architecture). No trading code exists yet.**
Research date: 2026-10-26. Sources for every provider claim are in
[`PROVIDER-RESEARCH.md`](./PROVIDER-RESEARCH.md).
Operating mode for everything described below until Phase 9 approval: **paper only.**

---

## 0. Executive summary

1. **None of your four accounts can drive automated trading.**
   - **Pump.fun:** has no official hosted API. Its on-chain programs are public, so we read them.
   - **Fomo:** its terms ban bots outright.
   - **Coinbase and Robinhood (Canada):** have no API for Solana meme coins. At most they are manual ways to buy SOL and send it to a wallet.
2. **We can build the first version for $0.**
   - **Data:** we read on-chain data through free Solana data feeds.
   - **Discovery:** Helius free tier, with GeckoTerminal and PumpPortal's free new-token feed as cross-checks.
   - **Prices:** we use real executable Jupiter quotes as the paper "fills".
   - **Wallet:** none is needed.
3. **Jupiter can quote pump.fun tokens.** It routes pump.fun bonding-curve tokens, PumpSwap, Raydium LaunchLab and Meteora DBC. One live quote on a token minted the same morning routed through "Pump.fun". Free limits are tight: 0.5 req/s with no key, 1 req/s with a free key.
4. **The cost math is the biggest risk to the whole idea.**
   - Pump.fun's documented curve fee is 1% on buys and 1% on sells.
   - Add price impact, priority fees and the token-account rent you lock up.
   - On a CAD $30 position, round-trip costs likely sit around **2–4%** before any adverse move. That is a guess, and Phase 3 will measure it.
   - The strategy has to beat that, repeatedly, against faster bots. If it can't, the honest result is "don't trade."
5. **We will be slower than the snipers.** A home or cheap-VPS setup on free data reacts in seconds, not milliseconds. Strategy C, early acceleration, will face the worst adverse selection. A and B work on tokens with a few minutes of history and are the more realistic research targets.

---

## 1. Workspace inspection (Phase 1A)

| Item | Finding |
|---|---|
| Repo | `jarvis-v2`: forex/gold brain on OANDA, plus a crypto paper engine on Bybit/OKX/Kraken candles. Plain JS (ESM), Node ≥18, one runtime dependency (`@anthropic-ai/sdk`). |
| Tests | None. No test runner configured. |
| Solana code | None. No Solana packages installed. |
| Runtime available | Node 22.22, Python 3.13, Bun, Go, Rust toolchain. |
| Credentials | No Solana, Helius, Jupiter or wallet secrets present. Generic cloud/GitHub tokens exist in the container environment and were not read or used. |
| Network | Public Solana RPC, DexScreener and GeckoTerminal reachable. Jupiter keyless endpoint rate-limited (HTTP 429) under light use from this shared egress IP. |

**Decision:** the Solana bot lives in its own folder (`solana-bot/`) with its own package, config, tests and data directory.
- It does not import or change the forex or crypto modules.
- It is not wired into the existing dashboard server.
- Sharing code with an untested forex engine would mix risk domains for no gain.

**Proposed stack:** TypeScript (strict), Node 22, Vitest, SQLite for the ledger and state, `@solana/kit` for RPC types. All amounts are `bigint` in base units (lamports, token atoms). Floats are used only for display and for signal maths, never for balances.
*Open question Q1 below. If you'd rather stay in plain JS to match the repo, say so.*

---

## 2. Integration classification

Legend:
- **V** = Verified and supported.
- **A** = Available only after approval/sign-up.
- **R** = Read-only.
- **M** = Manual-only.
- **U** = Unsupported or unverified.

### 2.1 Your existing accounts

| Integration | Class | Why |
|---|---|---|
| Pump.fun account / website API | **M** | No official API, developer portal or approval process. The `frontend-api` hosts are undocumented; we will not use them. |
| Pump.fun on-chain programs (bonding curve `6EF8…F6P`, PumpSwap `pAMM…EA`) via RPC + official IDL | **V / R** | Program IDs and IDLs are published in pump.fun's official docs repo. Public chain data; no account needed. |
| Pump.fun terms of use | **U** | The terms page returned 403 to automated fetch. Excerpts suggest bots are restricted on the site. We only read the public chain, not the site. **You should read the live terms yourself** before Phase 9. |
| Fomo (fomo.family) | **M** | Terms §16 (dated 17 Aug 2026) ban bots that trade, scrape or interact with accounts. No developer API. Not used in any phase. |
| Coinbase (Canada) — buy SOL, send SOL on Solana | **M** (U for Canada specifics) | Possible manual funding path. Help pages blocked automated fetch, so the Canadian SOL deposit/withdraw network is unverified. **Check in the app before sending anything.** |
| Coinbase — pump.fun / unlisted SPL tokens | **U** | Not supported on the Coinbase account. Unsupported tokens sent there may be lost. |
| Coinbase Advanced Trade / CDP APIs | **U** for this use | Advanced Trade is Coinbase-exchange spot only. CDP Trade API lists no Solana. Neither swaps meme coins on-chain. |
| Robinhood (Canada) | **M** | Live in Canada since 1 Jul 2026, run by Coinsquare. Lists SOL and supports SOL external transfers (44-char addresses). Crypto API is US-only. No meme-coin SPL support. |

### 2.2 Proposed providers

| Integration | Class | Role | Limits that matter |
|---|---|---|---|
| Solana public RPC (`api.mainnet.solana.com`) | **V**, R | Fallback reads, `getAccountInfo`, mint/authority checks | 100 req/10 s per IP, 40/10 s per method. "Not intended for production." |
| Helius free plan (RPC, WebSocket, Parsed Streams, DAS) | **A** (you sign up and create the key) | Primary discovery + trade-flow stream; holders via DAS | 1M credits/mo, 10 RPC req/s, DAS 2 req/s, 5 WS. Parsed Streams are on a **beta** host. Credits can run out on a wide stream. |
| Jupiter Swap API, quote/build path (keyless) | **V**, R in paper | Executable buy/sell quotes = paper fills, price impact, route | 0.5 req/s keyless. No Jupiter fee on `/build`. `lite-api` is being retired, so use `api.jup.ag`. |
| Jupiter API with free key | **A** (you sign up at developers.jup.ag/portal) | Same, at 1 req/s | Key goes in local `.env` only. |
| Jupiter `/order` + `/execute` | **U for this project** | Not proposed | Adds a 50 bps fee on tokens under 24h old, and the transaction can't be inspected or modified. Fails our "validate every instruction" rule. |
| Jupiter Tokens v2 (`/recent`, `audit`, `organicScore`) | **V**, R | Discovery cross-check, authority flags, dev-balance % | 30 newest tokens per call. "Recent" means first pool, not mint time. Credit-costed. |
| Jupiter Price v3 | **V**, R | Display / sanity check only | Not an executable price. |
| GeckoTerminal public API | **V**, R | New-pool cross-check, trade backfill (last 300), OHLCV for replay | 30 calls/min keyless (hit 429 on the 2nd call in testing). Polling, not real-time. |
| DexScreener API | **V**, R | Pair liquidity/volume snapshot, cross-check | 300/min on pair endpoints. **No new-pairs endpoint.** Shows `liquidity: null` for bonding-curve tokens. |
| PumpPortal data WebSocket (`subscribeNewToken`, `subscribeMigration`) | **R**, third-party | Free backup for new pump.fun mints and graduations | Not affiliated with pump.fun. One connection only, 1-hour bans. Trade streams are paid and need a funded linked wallet, so not proposed. |
| PumpPortal Lightning trade API | **U — never** | — | PumpPortal holds the signing wallet, so it is custodial. Breaks key rules. |
| PumpPortal Local trade API | **U** | Not proposed | 0.5% fee per trade on top of pump.fun fees. Jupiter `/build` covers the same pools with no added fee. |
| Raydium Trade API | **V**, not proposed for v1 | Possible second quote source later | Optional 1% referrer fee. Rate limits not documented. |
| `@pump-fun/pump-sdk`, `@pump-fun/pump-swap-sdk` (npm) | **U** | Possible reference for decoding curve state | Published from the `pump-fun` GitHub org. Not confirmed as endorsed in pump.fun's own docs. **Phase 3 will decode accounts from the official IDL directly.** |
| Birdeye free (Standard) | **R**, partly U | Optional holder distribution spot checks | 30k compute units/mo (~1,200 listing calls). Pricing and access pages contradict each other. |
| Bitquery, Moralis, Shyft, QuickNode, Solana Tracker | Not proposed | — | No useful free tier for this, or $99–$499/mo. Out of scale for a CAD $500 account. |
| Any LLM (Claude etc.) in the trade loop | **Not permitted** | Post-hoc explanations only | Deterministic code decides. |

**Nothing marked A, U or "not proposed" will be implemented until it is verified in a later phase and you approve it.**

---

## 3. System architecture

```
                 ┌───────────────────── ingestion (Phase 2) ─────────────────────┐
 Helius Parsed ─▶│ adapters ─▶ normalizer ─▶ dedupe/order (slot, txIdx) ─▶ event log│
 PumpPortal new ▶│   (one per provider, each with health + staleness clock)      │
 GeckoTerminal ─▶│                                                               │
 Public RPC ────▶└───────────────────────────────┬───────────────────────────────┘
                                                 ▼
                          token registry (keyed by mint) + per-token state
                                                 ▼
                ┌─────────── research side (no money, no keys) ───────────┐
                │ safety gate ─▶ liquidity/exit gate ─▶ features ─▶ A/B/C/D│
                └───────────────────────────────┬─────────────────────────┘
                                                ▼  TradeIntent (pure data)
                               risk manager (deterministic, owns all limits)
                                                ▼  ApprovedIntent
                     quote service (Jupiter) ─▶ executor interface
                                    ├─ PaperExecutor   (Phases 5–8, default)
                                    └─ LiveExecutor    (stub that throws until Phase 9)
                                                ▼
                    ledger (append-only SQLite) ─▶ portfolio/accounting ─▶ CSV export
                                                ▼
                     monitor: terminal + local web dashboard, alerts, kill switch
   Independent watchdog process: position protector + emergency stop (no strategy imports)
```

### 3.1 Data sources and freshness

- Every event carries `slot`, `blockTime`, `receivedAt`, `provider` and `providerEventId`.
- Ordering key is `(slot, transactionIndex, instructionIndex)`. `blockTime` is whole seconds and can be approximate, so it is never used for ordering.
- Each provider has a staleness clock. If the primary stream has been silent longer than `maxStreamSilenceMs`, discovery is marked DEGRADED and **all new entries stop**. That threshold gets tuned from measured gap stats in Phase 2.
- Reconnect logic re-fetches the slot gap from RPC (`getSignaturesForAddress` on the program) to backfill missed swaps. Any gap that can't be backfilled is recorded, and affected tokens are flagged `INCOMPLETE_HISTORY`.

### 3.2 Token discovery coverage

| Venue | How we see new mints / pools | Verified? |
|---|---|---|
| pump.fun bonding curve | Helius Parsed Streams on `6EF8…F6P` (`create` / `create_v2`); PumpPortal `subscribeNewToken` backup | Program ID verified. Helius parsing of the new `create_v2` / `buy_v3` instructions is **unverified**, and Phase 2 must test it. |
| PumpSwap (graduations) | Stream on `pAMM…EA`; PumpPortal `subscribeMigration` | Program ID verified |
| Raydium LaunchLab / CPMM / AMM v4 | Stream on their program IDs | IDs verified from Raydium SDK. Helius LaunchLab parsing unverified. |
| Meteora DBC / DAMM v2 / DLMM | Stream on program IDs | IDs verified from Meteora docs. Helius DBC parsing unverified. |

Rules:
- Tokens are keyed by **mint address only**.
- `firstObservedAt` is when *we* saw it. `onChainCreatedAt` is set only if we saw the creation instruction or fetched it.
- If we can't prove the launch time, the token is **not** labelled "new".

Categories:
- `NEW_LAUNCH`: we saw creation, age < N min.
- `EARLY`: age known, N–M min, has trade history.
- `TRENDING`: older, existing liquidity.
- `EXTENDED`: price already up more than X from its first observed price.

N, M and X are config values. Phase 6 data sets them.

### 3.3 Market data and candles

- Trades are rebuilt from parsed swap events: wallet, side, SOL amount, token amount, pool, slot.
- Candles (1 s / 15 s / 1 min) are built only from our own event log. A candle with fewer than `minTradesPerCandle` trades is marked `SPARSE`, and strategies that need structure refuse to use it.
- Price types are kept as separate fields and never mixed:
  - `lastTradePrice`
  - `poolMidPrice` (from reserves)
  - `execBuyQuote` and `execSellQuote` (Jupiter, sized to our position)
  - `markValue` (= the exec sell quote for our size)
  - `realizedProceeds` (paper fill or, later, on-chain balance delta)

### 3.4 Wallet and transaction data

- Holders: Helius DAS `getTokenAccounts` (2 req/s free), only for tokens that pass the cheap gates. Pool, burn and program accounts are excluded by known-address list.
- Creator history: creator wallet's prior pump.fun creates via parsed history.
- Wallet clustering is **inference only**. It is shown as "suspected" with the evidence (shared funder, same-slot buys, identical sizes). We never state two wallets have one owner.

### 3.5 Safety and tradability gate (Phase 3)

Hard rejects:
- No sell quote for our estimated acquired amount.
- Exit price impact over the limit.
- Mint authority present.
- Freeze authority present.
- Token-2022 with any of: permanent delegate, transfer hook, non-transferable, default-frozen state, pausable, confidential transfer.
- Transfer fee over the limit.
- Quote route touching a program outside our allowlist.
- Data older than the freshness limit.
- Creator sold more than X% within Y seconds.
- Top-10 non-program holders above Z%.

Every rejection stores `{mint, rule, observedValue, threshold, dataTimestamp}`. A token comes back only when that same rule passes on fresh data.

Thresholds start as **labelled placeholders** and are set from replay data. They are never presented as industry standards.

### 3.6 Strategy engine (Phase 4)

- Strategies A (continuation after consolidation), B (breakout/retest, with and without the retest as separate variants), C (early acceleration) and D (momentum failure, used for exits and entry vetoes only) are separate modules.
- Each is a pure function: `(TokenSnapshot, now) → Signal | NoSignal`, with a reason string.
- Each strategy has its own spec file (allowed conditions, trigger, invalidation, max extension, exits, cooldown, promotion evidence).
- No blended score. If we ever combine strategies, the weights get documented and must beat each one on its own out of sample.

### 3.7 Risk manager

A single module that owns every limit. Strategies cannot import config limits or call the executor.

It checks the 11 gates in your §8 order. Initial caps come from your spec:

| Cap | Value |
|---|---|
| Reference equity | CAD 500 |
| Max position | CAD 25–40 |
| Planned loss per trade | ≤ CAD 2–3 including costs |
| Daily loss stop | CAD 10 |
| New entries per day | 3 |
| Open positions | 1 |
| Pending entries/exits | 0 before any new entry |

- Raising any cap needs a config change **plus** a typed confirmation at startup. Lowering doesn't.
- Halts block new entries only. They never block reconciliation or a permitted protective exit.

### 3.8 Quote and execution engine

**Quote service.**
- Uses Jupiter `/swap/v2/build` (or the v1 quote that maps to it).
- Restricted to an allowlist of DEX labels.
- Rejects quotes older than `maxQuoteAgeMs`.
- Has a request budget so we stay under 0.5–1 req/s.

With one open position and a few candidates, the budget works out like this:
- One sell-quote refresh every ~3 s for the open position.
- Entry quotes only for tokens that passed all earlier gates.
- Whether that cadence is fast enough for 1–5 min holds is a Phase 6 question.

**PaperExecutor.** At decision time it records the quote, waits a simulated latency (sampled from measured distributions), then **re-quotes**. The paper fill is that second quote, minus a stress haircut.

It also simulates:
- failure probability
- priority fee
- base fee
- token-account rent

Unsellable outcomes are modelled by letting a position go `STUCK` when sell quotes disappear.

**LiveExecutor** (Phase 9 only) is an interface plus a stub that throws. Its future checklist:
- validate mints and program IDs in every instruction
- simulate
- cap the priority fee
- fresh blockhash
- `maxRetries=0` with our own bounded rebroadcast until `lastValidBlockHeight`
- reconcile by signature and balance delta before any replacement

**Signer.** Phase 9 design: a separate local process holding the dedicated wallet key.
- It accepts only a structured `ApprovedIntent` plus a transaction.
- It re-checks mints, programs, amounts and caps itself before signing.
- It never receives free-form instructions.
- The strategy process never sees the key.

### 3.9 Portfolio accounting and ledger

- Append-only SQLite: `events`, `intents`, `orders`, `fills`, `positions`, `cash_moves`, `fx_rates`, `halts`.
- State transitions are idempotent and keyed by `intentId`.
- Position states: `PROPOSED → ENTRY_PENDING → OPEN → EXIT_PENDING → CLOSED | STUCK | FAILED`.
- SOL is the accounting currency. CAD is derived with a stored `(rate, source, timestamp)`. CAD never feeds back into position sizing without a fresh rate.
- Costs are itemised per trade:
  - base fee
  - priority fee
  - venue fee
  - Jupiter/platform fee
  - price impact
  - slippage vs quote
  - rent locked/refunded
  - failed-tx fees
- Gross chart return, quote-expected, simulated and (later) realized returns are separate columns.
- CSV export for tax review. It makes no claim about tax treatment.

### 3.10 Paper-trading simulator and replay

The same code path is used for live data and replay. Only the clock and the event source differ.

- Replay reads our own recorded event log. We don't have historical quotes, so the replay quote model is labelled **modelled** and has conservative and harsh settings.
- Forward paper trading (Phase 6) uses real Jupiter quotes and is the main evidence for a decision.
- Look-ahead guard: every feature records the max slot it used. A test fails if it is newer than the decision slot.

### 3.11 Monitoring and alerts

- Terminal dashboard plus a local-only web page (bound to 127.0.0.1) showing everything in your §17.
- Every decision is logged as ENTER / HOLD / EXIT / REJECT / HALT with a one-line reason.
- Alerts start as terminal and log only. Phone alerts are a Phase 6 item and need your choice of channel.
- **Watchdog:** a separate small process that reads the ledger and pool state.
  - It can flip the kill switch.
  - In live mode, it can request a protective exit through the signer.
  - It imports no strategy code.

### 3.12 Deployment and secrets

**Phases 2–5:**
- Run on your own machine.
- Secrets live in `solana-bot/.env` (git-ignored, mode 0600) holding only the Helius and Jupiter keys.
- No wallet.

**Phase 6** (forward paper) needs something always-on:
- This cloud container is ephemeral and **not** suitable.
- The options are your PC left on or a small VPS. Price: [confirm before choosing].

**Phase 9:**
- A dedicated wallet, created by you, on the machine that runs the signer.
- Funded with only the approved amount.
- The key never goes into the repo, logs, this chat or any API.

Logs pass through a redactor that strips anything matching key or base58-secret patterns.

---

## 4. Costs and small-account economics

### 4.1 Monthly operating cost

| Setup | Monthly (USD) | Notes |
|---|---|---|
| Phase 2–5, free tiers | **$0** | Helius free + Jupiter keyless/free + GeckoTerminal + DexScreener + PumpPortal free feed. Coverage and speed limited. |
| Upgrade if free Helius credits run out | $49 | Helius Developer: 10M credits, more WS connections. |
| Upgrade if 1 req/s quotes are too slow | $25 | Jupiter Developer: 10 req/s. |
| Always-on host | [confirm] | Needed from Phase 6. |

**Every paid tier comes out of the edge.**
- $74 USD/month is roughly 20% of a CAD $500 bankroll every month. The exact share depends on the exchange rate.
- To cover it, the bot would need to clear that much net profit each month just to break even on tools.
- **We stay on free tiers until paper results justify spending.**

### 4.2 Per-trade cost (estimates, to be measured in Phase 3)

| Item | Source | Status |
|---|---|---|
| Pump.fun curve fee 1% buy + 1% sell | pump.fun official program docs | Verified as documented. **Live fee config may differ**; Phase 3 reads it on-chain. |
| PumpSwap / Raydium / Meteora pool fees | Each venue | **Unverified**. Phase 3 measures them from quotes vs reserve math. |
| Jupiter fee on `/build` | Jupiter docs | 0 (verified) |
| Base fee | Solana docs | 5,000 lamports per signature (verified) |
| Priority fee | Market | Unknown. Measured via `getRecentPrioritizationFees`, then capped. |
| Token account rent | Solana docs | 0.00203928 SOL per new account (Token-2022: 0.00207408+). Refunded only if we close the account after selling. |
| Price impact / slippage | Quote vs re-quote | Measured |

**Break-even rule:**
- The bot computes `breakEvenMovePct` for every proposed trade.
- It rejects the trade unless the strategy's expected move clears break-even plus an uncertainty margin.
- The margin is a config value, set from Phase 5–6 data.

---

## 5. Known limitations

1. **Latency.** Free-tier streams plus 0.5–1 req/s quotes mean seconds of reaction time. Professional snipers on paid gRPC are faster. Expect to be on the wrong side of the earliest moves.
2. **No historical quotes.** Backtests can only model execution. Forward paper trading is the only real evidence, and it takes calendar time.
3. **Parser coverage.** Pump.fun recently added new instruction versions (`create_v2`, `buy_v3`/`sell_v3`, PumpSwap `buy_v2`/`sell_v2`/`multi_hop_swap`), and `virtual_quote_reserves` can go negative. Third-party parsers may lag. Phase 2 must check Helius output against raw transactions.
4. **Sample size.** At ≤3 entries a day, collecting a few hundred trades takes months. A small sample can't separate an edge from luck, and the report will say so.
5. **Manipulation detection is inference.** Clustering, wash trading and bundling flags are risk signals, not proof.
6. **Provider changes.** Jupiter `lite-api` is being retired. Helius Parsed Streams is beta. Pump.fun's program changed recently. Adapters must fail closed when payload shapes change.
7. **Legal / tax.** Not checked in depth:
   - whether automated DEX trading of these tokens raises any BC or CSA issue for you
   - how CRA would treat frequent trading (likely business income rather than capital gains, but that's for an accountant)
   - The bot produces records only.

---

## 6. Phased plan (unchanged from your spec)

| Phase | Output | Gate to move on |
|---|---|---|
| 1 | This report | Your answers to §7 |
| 2 | Ingestion, normalizer, registry, discovery, health | 48 h recorded stream with measured gaps, dupes, parser coverage |
| 3 | Safety gate, liquidity/exit gate, quote service, cost measurement | Measured fee and impact table per venue |
| 4 | Strategies A–D, risk manager | Unit tests for every rule and limit |
| 5 | Paper executor, ledger, replay, failure injection | Full test suite green; replay report |
| 6 | Forward paper trading | Minimum trade count and condition coverage (set in Phase 5) |
| 7 | Security and execution review | Written findings closed |
| 8 | Live readiness report | **Your explicit written approval and limits** |
| 9 | Dedicated wallet, capped live trading | — |

---

## 7. Open questions for you

1. **Language:** TypeScript in a separate `solana-bot/` folder (recommended), or plain JS to match the existing repo?
2. **Keys:** Will you create a free Helius key and a free Jupiter key yourself and put them in your local `.env`? You never paste them here. Until then, Phase 2 runs on keyless sources only: public RPC, GeckoTerminal, DexScreener and PumpPortal's free feed. That means polling, lower coverage and no full trade stream.
3. **PumpPortal:** OK to use its free new-token and migration feed as a read-only backup? It is a third party, not affiliated with pump.fun, and needs no account for those two channels.
4. **Where it runs:** your own computer for Phases 2–5? Which OS? This cloud container resets and can't hold a multi-day forward test.
5. **Data budget:** stay at $0/month until paper results justify spending? That is the recommendation. Or set a ceiling now.
6. **Pump.fun terms:** please read https://pump.fun/docs/terms-and-conditions yourself. Automated fetch was blocked, so I can't confirm what it says about Canada or automated trading.
