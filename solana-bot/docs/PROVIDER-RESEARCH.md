# Provider Research Notes — 2026-10-26

These are the sources behind `ARCHITECTURE.md`.
- "Fetched" means the page was read directly.
- "Excerpt" means the page blocked automated fetch and only a search excerpt was seen.
- Everything marked UNVERIFIED needs a re-check before anyone relies on it.

## Pump.fun

- **Official docs repo** (fetched): https://github.com/pump-fun/pump-public-docs
  - Bonding curve program: `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
  - PumpSwap AMM: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
  - The docs say the curve charges a 1% fee on buys and sells, and that completed curves migrate to PumpSwap.
  - Recent program changes: `create_v2`, `buy_v3`/`sell_v3`, PumpSwap `buy_v2`/`sell_v2`/`multi_hop_swap`. `virtual_quote_reserves` can be negative.
- **Hosted API:** no official REST API, developer portal or approval process was found. The `frontend-api*.pump.fun` hosts are undocumented and are not used.
- **Terms:** https://pump.fun/docs/terms-and-conditions returned HTTP 403 (excerpt only). It appears to restrict bots unless "expressly permitted" and to exclude "Prohibited Jurisdictions". The Canada status is UNVERIFIED.
- **npm packages:** `@pump-fun/pump-sdk` 4.3.1 and `@pump-fun/pump-swap-sdk` 2.2.0 come from the pump-fun GitHub org. pump.fun's own docs don't endorse them, so UNVERIFIED.

## PumpPortal (third party)

- **Not affiliated:** https://pumpportal.fun/legal (fetched) says it is "NOT AFFILIATED" with pump.fun or Raydium.
- **Data WebSocket:** `wss://pumpportal.fun/api/data`.
  - `subscribeNewToken` and `subscribeMigration` are free.
  - Trade subscriptions cost 0.01 SOL per 10k events and need an API key plus a linked wallet holding at least 0.02 SOL (since 1 May 2026).
  - One connection only. Breaking that gets a 1-hour ban.
- **Trade APIs:**
  - Lightning costs 1% per trade, and PumpPortal holds the signing wallet. Rejected.
  - Local costs 0.5% per trade and you sign it yourself. Not proposed.
  - Fee page: https://pumpportal.fun/fees

## Fomo

- **Terms:** https://fomo.family/terms (fetched), dated 17 Aug 2026, issued by FOMO Labs, Inc.
  - §16 bans "automated scripts, bots … execute trades, or otherwise control or interact with account activity", scraping, data mining and reverse engineering.
  - §11 excludes Canadian residents from Robinhood Tokens.
- **API:** no developer API was found.

## Coinbase

- **Help center:** help.coinbase.com returned 403 (excerpts only).
  - Unlisted SPL tokens are not supported. A reclaim tool exists for some tokens sent by mistake (Coinbase post on X, Apr 2025).
  - Canadian SOL network deposit and withdrawal: UNVERIFIED.
- **APIs:**
  - Advanced Trade API covers Coinbase-exchange spot only: https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/overview
  - The CDP Trade API lists Ethereum, Base, Arbitrum, Optimism and Polygon only. No Solana.
- **Canada stablecoins:** USDT was delisted for Canadians in 2024. USDC was reported compliant (Circle, Dec 2024). The 2026 status is UNVERIFIED.

## Robinhood Canada

- **Launch:** Robinhood newsroom, 1 Jul 2026 (fetched). It runs through Coinsquare Capital Markets Ltd. (CIRO member) and is crypto only.
- **Offer:** https://robinhood.com/ca/en (fetched) lists 50+ cryptocurrencies, including SOL, with external wallet send and receive.
- **SOL transfers:** https://robinhood.com/ca/en/support/articles/crypto-transfers/ (fetched).
  - 44-character Solana addresses are supported.
  - "Any unsupported coins sent to a Robinhood address may be lost."
- **API:** the Crypto Trading API is US only: https://robinhood.com/us/en/support/articles/crypto-api/

## Jupiter

Docs now live at https://developers.jup.ag (old dev.jup.ag and station.jup.ag links redirect there).

- **Swap V2:** `https://api.jup.ag/swap/v2`.
  - `/order` + `/execute`: Jupiter builds the transaction and lands it. A platform fee applies, and the transaction can't be modified.
  - `/build`: raw instructions, with no Jupiter fee.
  - Ultra has moved to `/order`. v1 `/quote` maps to `/build`.
  - Sources: https://developers.jup.ag/docs/swap/index.md and the migration pages.
- **lite-api.jup.ag:** being phased out, with its rate limit cut in steps: https://developers.jup.ag/docs/portal/migration.md
- **Plans:**

| Plan | Price | Requests/sec |
|---|---|---|
| Keyless | $0 | 0.5 |
| Free key | $0 | 1 |
| Developer | $25/mo | 10 |
| Launch | $100/mo | 50 |
| Pro | $500/mo | 150 |

  - Limits use a 60 s sliding window and apply per organisation.
  - Sources: https://developers.jup.ag/docs/portal/rate-limits.md and https://developers.jup.ag/docs/portal/plans.md
- **`/order` fees:**

| Pair | Fee |
|---|---|
| Pegged assets and Jupiter tokens | 0 bps |
| SOL to stablecoin | 2 bps |
| LST to stablecoin | 5 bps |
| Everything else | 10 bps |
| Tokens under 24 h old | 50 bps |

  - One live test on a same-day token showed 10 bps, which doesn't match the docs. UNVERIFIED, so plan on 50 bps.
- **Slippage:** the RTSE estimator is the default on `/order`. On `/build` it's opt-in with `slippageBps=rtse`, otherwise 50 bps. The docs suggest a fixed slippage for memecoins.
- **Priority fees:** `/build` takes `computeUnitPricePercentile`. The docs warn the estimate can spike, so we clamp it ourselves.
- **Simulation:** not done by Jupiter. Simulate it yourself with `replaceRecentBlockhash`.
- **Routing coverage:** https://developers.jup.ag/docs/swap/routing/amm/market-listing.md lists Pump.fun bonding curve, Pump.fun AMM, Raydium LaunchLab, Meteora DBC, Moonshot and Boop.fun.
  - Bonding-curve markets drop out after a grace period if the token doesn't graduate.
  - After that, a 30-minute liquidity test applies.
  - A live quote on a token minted that morning routed via "Pump.fun".
- **Tokens v2:** `/recent` returns 30 tokens, ordered by first pool time.
  - Fields include `organicScore`, `audit.mintAuthorityDisabled`, `audit.freezeAuthorityDisabled`, `audit.devBalancePercentage`, `stats5m…stats24h`, `holderCount` and `liquidity`.
- **Terms:** https://developers.jup.ag/docs/legal/terms-of-use.md. The restricted list names the US, Singapore and sanctioned regions. **Canada is not named.** The operator is Block Raccoon S.A. (Panama).
- **Live probes from this container:** keyless calls hit HTTP 429 after about 5 requests in 10 s. The headers are `x-ratelimit-remaining`, `x-ratelimit-current` and `x-ratelimit-reset`.

## Solana (official docs)

- **Blockhash expiry:** valid for 150 slots, about 60–90 s. Re-sign only after `lastValidBlockHeight`.
  - Sources: https://solana.com/developers/cookbook/transactions/confirmation.md and https://solana.com/developers/cookbook/transactions/retry.md
- **Commitment:** `processed` can be rolled back. Use `confirmed` for most reads.
- **Retries:** under congestion, use `maxRetries=0` and rebroadcast yourself. Keep preflight on.
- **Fees:** 5,000 lamports per signature base fee. Priority fee = compute unit price × compute limit.
  - Source: https://solana.com/docs/core/fees/fee-structure.md
- **Token account rent:**
  - Token Program: 2,039,280 lamports.
  - Token-2022: 2,074,080 lamports or more.
  - Closing the account refunds it, but only once the token balance is zero.
- **Public RPC:** `https://api.mainnet.solana.com`.
  - Limits per IP: 100 req/10 s, 40/10 s per method, 40 connections.
  - "Not intended for production."
  - Source: https://solana.com/docs/references/clusters.md
- **Token-2022 extensions to reject on:** permanent delegate, transfer hook, non-transferable, default-frozen state, pausable, confidential transfer. Transfer fee gets a limit.
  - Source: https://solana.com/docs/tokens/extensions/

## Data providers

- **Helius:** https://www.helius.dev/docs/billing/plans (updated 2026-10-06).
  - Free plan: 1M credits, 10 RPC req/s, DAS 2 req/s, 5 WebSocket connections.
  - Developer plan: $49.
  - Business plan: $499, includes mainnet gRPC.
  - Parsed Streams (`wss://beta.helius-rpc.com`) are on the Free plan at 1 credit per event. They cover pump.fun, PumpSwap, Raydium CPMM/CLMM and Meteora: https://www.helius.dev/docs/parsed-streams
- **GeckoTerminal:** about 30 calls/min keyless.
  - `networks/solana/new_pools` showed pools 39–74 s old: pump-fun, pumpswap, meteora-dbc and meteora-damm-v2.
  - Trades endpoint returns the last 300 in 24 h.
  - OHLCV goes down to 1 s.
- **DexScreener:** https://docs.dexscreener.com/api/reference
  - Pair endpoints allow 300/min.
  - No new-pairs endpoint.
  - Bonding-curve pairs show `liquidity: null`.
- **Birdeye:** https://data.birdeye.so/docs/guides/payment/pricing
  - Free plan: 30k compute units/mo.
  - Lite plan: $39.
  - The tier pages contradict each other on what the free plan can access.
- **Program IDs from official SDKs and docs:**
  - Raydium AMM v4 `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
  - Raydium CPMM `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`
  - Raydium CLMM `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`
  - Raydium LaunchLab `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`
  - Meteora DLMM `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo`
  - Meteora DAMM v1 `Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB`
  - Meteora DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG`
  - Meteora DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`
- **Not proposed** because of cost or no free tier:
  - Shyft (gRPC from $199)
  - Bitquery (trial only)
  - Moralis ($149)
  - QuickNode (gRPC add-on $499)
  - Solana Tracker (WebSocket at €397)

## Mint addresses

- Wrapped SOL: `So11111111111111111111111111111111111111112`
- USDC: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`
