# Phase 7 Report: Security and Operations Review

Date: 2026-10-27. Mode: paper. No wallet exists. No transaction has ever been built, signed or sent.

An independent read-only review of the whole `solana-bot/` tree was run on 2026-10-26 (code, tests, docs, the committed tape, dependencies). This report lists every finding, what was done about it, and what is left. Nothing here changes the Phase 8/9 position: live trading stays off until the Phase 6 evidence exists and you approve it in writing.

## Findings and what changed

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | High | The dashboard halt closed every open position, but three places said it only blocked new entries. And `POST /api/halt` had no origin or token check, so a page on any website could trigger it against `127.0.0.1:4777`. | Fixed. The halt is now documented everywhere as "closes open paper positions and blocks entries for the day". The request must carry a per-process token the page received and matching `Origin` and `Host` headers; anything else gets 403. Test covers the cross-site case. |
| 2 | High | Two coins approved in the same 5-second tick could both open, breaching "one position" and the daily entry count, because the decisions were made against one snapshot. | Fixed twice over. The engine re-checks open positions, pending orders, entries and halt right before each approved entry. The paper trader re-checks the ledger again at the moment of entry. Test covers two approvals in a row. |
| 3 | Medium | Tape import took column names from the file and built SQL from them. Imported `positions` rows in state OPEN would have been managed by this machine's trader and credited to its paper cash. | Fixed. Column names are filtered against the real table schema. Values must be scalars. Decompressed size and row counts are capped. Imported positions and orders get mode `imported:<mode>`, which this machine's ledger never reads; `npm run evidence -- --imported` analyses them. |
| 4 | Medium | A crash between proposing an entry and recording its fill left a row PROPOSED forever, which blocked every future entry with no way out. A crash between an exit fill and the daily risk-state update lost that trade's loss. Repeated exit calls could credit cash twice. | Fixed. `Ledger.recover()` runs at start: unresolved entries become FAILED with zero P&L and no cash movement; pending exits reopen. Sell orders take a caller key and a replay is a no-op. Transactions nest as savepoints, so the fill and the risk-state update commit together. Tests cover recovery, replay and nested rollback. |
| 5 | Medium | The no-execution test was a text scan with gaps: `sendAndConfirm*`, `generateKeyPair`, Jupiter Ultra/Trigger/Recurring endpoints, dynamic `import()`, and the RPC client accepted any method string. | Mostly fixed. The scan now covers those names, is case-insensitive on `keypair`, and flags dynamic imports. A new test asserts every RPC call uses a literal method name starting with `get`. Still true: `@solana/kit` is installed in full and only four address helpers are used. Replacing it with `@solana/addresses` is listed below. |
| 6 | Low | Keyed HTTP requests followed redirects, so an `x-api-key` header could be sent to another host. Dashboard `reason` and `failure` strings bypass the log redactor. The limits-file confirmation is a SHA-256 the same user writes. | Redirects are now refused (`redirect: "error"`). The other two are documented below as accepted. |
| 7 | Low | CSV export did not neutralise cells beginning with `= + - @`. A hostile route label would run as a formula in Excel. | Fixed. Such cells are prefixed with `'`. Negative numbers are untouched. |
| 8 | Low | Strategy parameters can loosen from a file with only a logged hash, unlike risk limits. | Accepted for now. Parameters decide how often a strategy fires; the money limits still cap what any trade can lose. Revisit before Phase 9. |
| 9 | Info | Backtest never resets daily state and assumes fresh assessments. `peak_net` is not rescaled after a partial exit. A failed simulated entry counts as a loss for the streak. `node:sqlite` is experimental; `tsx` runs the code. | Documented. The partial-exit peak bug is dormant while profit mode is "full". The failed-entry rule is conservative on purpose. |

## Found during Phase 6 operation, same period

- A coin that passed the safety check was re-checked every 10 minutes, but an entry needs a check under 2 minutes old. Every live strategy signal on 2026-10-27 was rejected for this reason. Passed coins are now re-checked every 90 seconds.
- Added explore mode and drill mode (paper only) so execution can be measured while no strategy clears the cost bar. Both keep the position size and loss per trade. Both are stored under their own ledger mode and excluded from live eligibility. See `docs/PHASE6-GUIDE.md`.

## Accepted risks and known limitations

- **The limits-file confirmation is a speed bump, not a boundary.** The same person writes both files. It stops an accidental edit; it does not stop a deliberate one. That is its purpose.
- **Dashboard strings are not redacted.** Feed reasons and failure strings come from provider error messages. None carries a key today. If a provider ever echoed a URL with a key, it could appear on the local page.
- **Token logos are loaded by your browser from creator-published URLs.** Same exposure as any explorer. Documented in `docs/SECURITY.md`.
- **`@solana/kit` is installed in full.** The safety scan is the control. Replacing it with the smaller `@solana/addresses` package is the cleaner fix.
- **`node:sqlite` is experimental** and prints a warning at start. It has been stable in use.
- **The stress allowance (2%) is a guess** until the drill and explore fills measure it.

## What remains before Phase 8

1. Phase 6 evidence: 100+ resolved paper trades under the real rules, positive after costs, over 5+ days. Nothing is close to that yet.
2. Replace `@solana/kit` with `@solana/addresses`.
3. Strategy parameter changes to need the same confirmation as limits.
4. A second review of this report's fixes by someone other than the author.

## Tests

`npm test`: 181 passed, 0 failed. `npm run typecheck`: clean. `npm audit`: 0 findings at the time of the review.
