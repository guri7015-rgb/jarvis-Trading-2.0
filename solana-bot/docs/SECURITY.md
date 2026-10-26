# Security Checklist

Status as of Phase 5. Items marked **[Phase 9]** apply only once live trading is approved and don't exist yet.

## What exists today

| Control | State |
|---|---|
| No wallet, key, seed or signer anywhere in the code | Enforced by `test/safety.test.ts`, which fails the build if signing, sending or trade endpoints appear in `src/`. |
| Live trading flag | A hard-coded `false` constant (`LIVE_TRADING_ENABLED`). No environment variable or config can flip it. |
| Secrets | Only two: a Jupiter key and a Helius RPC URL. They live in `.env` (git-ignored, `chmod 600`). The logger redacts registered secrets, `api-key=` query strings, `x-api-key` headers and 64-byte key arrays. Config errors name the bad key, never its value. |
| Provider payloads | Every response is schema-checked (zod) and size-capped (4 MB HTTP, 64–256 KB WebSocket). Unknown shapes are rejected and counted. Prototype-pollution keys are ignored. |
| Trade events | Accepted only when printed by the real pump.fun or PumpSwap program (invoke stack checked). Forged copies are counted as spoofed. |
| Provider claims vs chain | Every discovered mint and curve is re-read from the chain. Disagreements are marked CONFLICT and never traded. |
| Rate limits and budgets | Per-provider token buckets under each free tier. A persisted daily RPC budget. 429s honour the provider's reset time. |
| Risk limits | Loosening any limit needs a separate confirmation file containing the SHA-256 of the limits file. Tightening needs nothing. Unconfirmed loosening blocks all entries. |
| Daily halts | Persisted in SQLite. A restart cannot clear a halt or a loss limit. |
| Dashboard | Binds to 127.0.0.1 only. Read-only except the emergency stop, which closes every open paper position and blocks new entries for the day. The stop needs the page's own per-process token and a matching Origin, so a page on another site cannot trigger it. |
| Token logos | The page shows names, symbols and logos as reported by Jupiter. Your browser loads each logo from the URL the token's creator published (https only, no referrer). A creator could see your IP in their image server's log. That is the same exposure as opening the token on any explorer. Nothing about a logo feeds a gate or a trade. |
| Dependencies | Four runtime packages, exact-pinned. `npm audit` clean at the last check. Lockfile committed. |
| No AI in the loop | No model output can trigger, size or override a trade. Deterministic code only. |

## Before Phase 9 (live) — none of this is built

- **[Phase 9]** A dedicated trading wallet created by you, on your machine, funded with only the approved amount. Never the main wallet.
- **[Phase 9]** A separate signer process. It accepts only a structured intent plus a transaction, re-checks mints, program IDs, amounts and caps itself, and signs nothing else. The strategy process never sees the key.
- **[Phase 9]** Every transaction simulated before sending. Every instruction's program ID checked against an allowlist. Destination accounts verified.
- **[Phase 9]** Priority fee capped. Fresh blockhash. `maxRetries=0` with bounded rebroadcast until `lastValidBlockHeight`. Reconcile by signature and balance delta before any replacement transaction.
- **[Phase 9]** Startup reconciliation: wallet balances and outstanding signatures checked before any new order.
- **[Phase 9]** Watchdog process independent of the strategy engine that can flip the kill switch and request a protective exit.
- **[Phase 9]** Dependency scanning on every install, and a review of the four packages' maintainers.

## Things to check yourself

1. `git status` must never show `.env`.
2. `ls -l solana-bot/.env` should show `-rw-------` (owner only).
3. The dashboard URL must start with `127.0.0.1`. Never expose it with a tunnel or port forward.
4. If you ever see a private key, seed phrase or wallet address of yours in a log, stop and tell me. There should be none.
