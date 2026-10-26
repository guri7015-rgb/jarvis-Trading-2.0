# Terms and Canadian Rules: What We Could Verify

Researched 2026-10-26. This is a record of sources, not legal or tax advice. **Live trading stays off until you have checked the open items below**, with a lawyer and an accountant where noted.

Source types:
- **Live:** we read the page directly.
- **Archived:** a dated web archive copy.
- **Excerpt:** search-engine text only. It may be reworded, so treat it as unconfirmed.

## Verified

### Jupiter terms of use
Source: https://developers.jup.ag/docs/legal/terms-of-use.md (live). The page shows no revision date.
- **Where it doesn't serve wallets:** the United States, the Republic of China, Singapore and a list of sanctioned regions. **Canada is not named.**
- **VPNs:** using a VPN to get around those restrictions is forbidden.
- **What the terms cover:** "the Interface", meaning the website. The terms describe the Protocol separately, as "operated directly by users calling functions on it."
- **Your responsibility:** "you are solely and entirely responsible for compliance with all laws and regulations that may apply to you."
- **Bots:** the terms say nothing about bots.

### Jupiter API licence
Source: https://developers.jup.ag/docs/legal/sdk-api-license-agreement.md (live).
- **What the licence is (§2.1):** "fee-bearing", "solely for the purpose of Licensee's internal development efforts".
- **Volume (§3.2(e)):** use may not exceed "reasonable request volume" or be "excessive or abusive". Our rate limits stay under the free-tier caps.
- **Keys (§5.1):** access is through keys Jupiter issues.
- **Compliance (§7.3):** you must comply with applicable laws, "including … securities laws … or virtual assets regulations".

### pump.fun public docs repo
Source: https://github.com/pump-fun/pump-public-docs (live).
- Technical program documentation only.
- It has no terms, no licence file, and no jurisdiction text.
- So we don't copy its IDL files into this repo. Our decoders cite the field order and the commit instead.

### BCSC / CSA
- **CSA/IIROC Staff Notice 21-329** (Mar 29, 2021), BCSC PDF (live).
  - It covers platforms that "facilitate … the trading of" crypto contracts.
  - Foreign platforms with Canadian clients are "expected to comply with Canadian securities legislation."
  - It defines a decentralized exchange.
  - It says nothing about individual traders.
- **CSA Staff Notice 21-332** (Feb 22, 2023), BCSC PDF (live).
  - It covers pre-registration undertakings for unregistered platforms.
  - It does not mention DeFi or DEXs.
- **BCSC InvestRight, "Crypto Assets" page** (live).
  - "Some crypto assets fall under BC's securities law, while others may not."
  - "In Canada, many platforms are currently not registered with securities regulators."

### CRA (live pages)
- **Business income vs capital** (modified 2025-12-02).
  - Indicators of business income include "extensive buying and selling" and holding "for a short period of time, and you turn them over quickly."
  - The CRA decides case by case. A 1–5 minute scalping bot fits several of these indicators. That is for your accountant to assess.
- **Records** (modified 2025-11-10). For each transaction, keep:
  - the date and time
  - the amount and type
  - the value in CAD
  - its purpose
  - the other party
- **Also keep:** your wallet addresses, plus opening and closing balances each year.
- **How long:** "for at least six years." The ledger in Phase 5 will be built to export these fields.

### FINTRAC
- **Registration guidance** (modified 2024-08-22).
  - Money-services registration applies to those "engaged in the business of providing" the service "at the request of another person or entity."
  - The guidance says nothing about individuals trading their own funds.

## Not verifiable (blocked or absent)

- **pump.fun terms and conditions:**
  - Every pump.fun legal page returned HTTP 403, even with a normal browser user agent.
  - An archived copy dated 2026-10-14 exists, but it could not be fetched.
  - Everything below comes from search excerpts only:
    - §6.1 allows bots only "as we expressly permit from time to time".
    - §21(h) bans bots and scraping otherwise.
    - The §32 prohibited jurisdictions list the UK, Cuba, Iran, North Korea, Syria, Russia, Belarus and parts of Ukraine. **Canada was not in the excerpt.** We could not confirm the full list.
    - We could not confirm whether the terms reach direct on-chain program calls, which is what this bot does.
- **AMF (Québec) warning on pump.fun** (2026-09-25):
  - Excerpt only (the page returned 403). It says pump.fun is not registered with the AMF and not authorized to solicit Québec investors.
  - You are in BC, not Québec. We found no BCSC equivalent, but that doesn't prove none exists.
- **CSA website:** blocked by a bot challenge. OSC pages returned 403. We could not read CSA Staff Notice 21-327 or any 2025–2026 CSA crypto notice.
- **No primary source found on:**
  - whether an individual trading their own funds through a DEX must register
  - CSA or BCSC statements on meme coins, pump.fun or trading bots
  - CRA guidance applying the superficial-loss rule to crypto
- **CARF** (the crypto-asset reporting framework): only an excerpt saying it is "set to commence as of 2027, pending legislation."

## Open items for you

1. **Read pump.fun's terms yourself in a browser.** Check:
   - §32 (prohibited jurisdictions) and §30B (restricted features) for Canada or BC
   - what "expressly permit" means for bots under §6.1
   - whether the terms cover direct program calls
2. **Ask a lawyer** whether direct on-chain trading through Jupiter, or pump.fun's programs, falls under either platform's terms. Ask too whether BC securities law or FINTRAC rules apply to you.
3. **Ask an accountant:**
   - business income or capital gains for frequent bot trading
   - how superficial-loss and identical-property rules apply to tokens
4. **Jupiter's licence is "fee-bearing".** Confirm the free plan and your intended volume fit it before relying on it for live quotes.
5. **Nothing here says any activity is permitted.** A blocked page or a third-party summary is not permission.
