# How Mirror is built (infrastructure)

*Researched 2026-10-23. Sources:*
- *Mirror's invite-gated docs (`../sources/mirror/`).*
- *Mirror's production web-app JavaScript bundle, fetched 2026-10-23 with the invite cookie and inspected as text (not executed).*
- *Public press coverage of DeSo DEX.*

*Tags:*
- ***[DOCS]*** *Mirror states this in its docs.*
- ***[BUNDLE]*** *Seen in the front-end code.*
- ***[INFERENCE]*** *Our reading of the evidence.*

## Short answer

Mirror runs its own order-book exchange: a central limit order book (CLOB) plus a bonding curve, with matching and risk in one Rust core.
- They present it as a chain, with chain id 1 "Mirror" and a "block explorer" marked coming soon.
- Users never touch smart contracts to trade. They sign API requests with a trading key registered to their account.
- Money comes in through Mirror-issued deposit addresses on about 20 external chains, credited after confirmations. It goes out to withdrawal addresses.
- The docs and the bundle show no on-chain contract for matching, margin or custody.

## Evidence

### Matching and risk engine

- **[DOCS]** "Mirror is a fully-fledged order-book exchange", with a continuous curve layered on top of the book. Each order fills against the curve or the nearest resting order, whichever is better.
- **[DOCS]** The matching and risk engines are one "single monolithic core" that runs atomically on every transaction.
  - Solvency checks run before every trade and price tick, with ADL inside the same transaction.
  - Over 300k steady-state transactions per second on a single thread.
  - Markets are sharded across threads, which is safe because markets are isolated.
- **[DOCS]** The engine is written in Rust. The builder-revenue section shows `pub base_size: Option<Size>`.
- **[DOCS]** Mirror has a "public transaction log". Stealth Mode hides a user's orders from the log and the public book.
- **[BUNDLE]** Market data is streamed over `wss://api.mirror.exchange/ws` as sequence-numbered snapshots and deltas. A staging environment exists at `api.staging.mirror.exchange`.

### A chain of its own, at least in name

- **[BUNDLE]** The chain table starts with `1: {key: "mirror", name: "Mirror", shortLabel: "MIR"}`, followed by Solana, Ethereum, Tron, Arbitrum, Base, BNB Smart Chain, Bitcoin, XRP, Dogecoin, Cardano, DeSo and others (23 ids).
- **[BUNDLE]** The UI has a stub: "Coming soon! The block explorer will give you full visibility into all your transactions."
- **[INFERENCE]** Founder history points the same way: in Jan 2023 DeSo DEX launched on the DeSo L1, billed as a "fully on-chain order book" doing about 40k matches a second. Mirror looks like the next version of that idea: a purpose-built sequencer or chain, now with 300k+ tps and perps.
  - Nothing shows whether there are independent validators or consensus, or whether it's a single operator publishing a log.
  - The front-end has no strings for proofs, Merkle trees or validators.

### Accounts and signing

- **[BUNDLE]** You log in with a wallet (Phantom for Solana, MetaMask for EVM) or with email or phone.
  - The browser generates a keypair.
  - The wallet signs a message, and the public key is registered as a named "Trading Key" with permissions: reading, spot trading, perps trading, withdrawals, internal and external transfer, key management.
  - Subaccounts are supported.
- **[BUNDLE]** Every API request and the websocket `Auth` message is signed with that key, using the headers `X-Gigadex-Api-Key`, `X-Gigadex-Timestamp` and `X-Gigadex-Signature`.
- **[INFERENCE]** "Gigadex" looks like the internal name of the exchange backend.
- **[INFERENCE]** This is the same pattern as Hyperliquid's agent wallets, or a CEX API key: the wallet is your identity, and trading is fast off-wallet signing against Mirror's engine.

### Custody: deposits and withdrawals

- **[BUNDLE]** The app fetches **deposit addresses** for each chain and asset from Mirror's API (`depositAddressesByKey`). It also fetches **withdrawal addresses** and withdrawal fee options.
- **[BUNDLE]** Deposits need per-chain confirmations before they're credited. The estimated wait (`estimatedSeconds`) is the bundle's figure.

  | Chain | Confirmations | Estimated wait |
  |---|---|---|
  | Ethereum | 12 | ~240s |
  | Tron | 20 | — |
  | Arbitrum | 12 | — |
  | Base | 12 | — |
  | BSC | 15 | — |
  | Bitcoin | 2 | ~1800s |
  | Solana | n/a | ~30s |
  | DeSo | n/a | ~20s |

- **[BUNDLE]** Withdrawable assets: USDC, USDT, SOL, ETH, TRX, BNB, BTC, DESO. Each asset has a `can_withdraw` flag and needs a fee asset.
- **[DOCS]** Fees are converted to USDC on every trade.
- **[INFERENCE]** Bitcoin, Tron and XRP can't host the kind of bridge contract Hyperliquid uses on Arbitrum. Issued deposit addresses plus confirmation counts is how a **custodial** exchange works: Mirror or a custody provider holds the keys, possibly with MPC. We don't know whether any chain gets a contract-based bridge.

## Comparison

| | Matching | Margin and risk | Custody | Trading auth |
|---|---|---|---|---|
| **Mirror** | Own CLOB + curve, Rust, one atomic core | Same core | Issued deposit addresses on ~20 chains (custodial, inferred) | Registered trading key signs requests |
| Hyperliquid | Own L1 (HyperBFT validators) | On the L1 | Bridge contract on Arbitrum | Agent wallets |
| dYdX v3 | Off-chain | Off-chain | StarkEx contract + validity proofs | API keys |
| Phoenix / OpenBook | On Solana | On Solana | Solana programs | Wallet signs each tx |

## What this means for us

- A builder needs to build an **exchange engine** (CLOB plus curve plus risk in one atomic core), a **custody and deposit system**, and a **signed API**. Smart contracts aren't the core.
- Our simulation is a prototype of the risk half of that core. The order book and the curve-on-book routing are the next missing pieces.
- **Still open:**
  - Is there consensus or validators, or a single operator?
  - Who holds the deposit keys?
  - Is the public log verifiable (proof of solvency or reserves)?
  - These matter because "mathematically guaranteed solvency" is only as trustworthy as the operator running the core.

## Re-check, 2026-10-26

The production bundle (57 JS files, linked from the invite-gated pages) was fetched again and read as text, not
executed.
- **REST routes found:** `/api/v1/` `markets`, `tokens`, `ticker`, `orderbook`, `trades`, `candles`, `search`,
  `stats/`, `register-signing-key`, `answer-challenge`, `post`, and `pulse/new-pairs`, `pulse/final-stretch`,
  `pulse/migrated`. **[INFERENCE]** The three `pulse` names match the categories memecoin trading terminals use for
  new, about-to-graduate and graduated launchpad tokens.
- **Realtime channels:** `trades`, `orders`, `orderbook`, `marketStats`, `activeAssetCtx`, plus an
  `ORDERBOOK_UPDATED` event with `affected_side`. The market page groups order book, market trades, recent snipes
  and top snipes.
- **Perps:** the words leverage, funding, liquidation and auto-deleveraging occur only inside the docs pages, the
  router's page descriptions and marketing cards (`ZillowPerpCard`, the referral share text "trade early-stage
  startups with leverage"). There are no routes, channels or forms for positions, margin, leverage or funding.
  **[INFERENCE]** The shipped client is a spot + sniping exchange; perps are documented but not visible in code yet.
  Absence from the client doesn't prove absence from the backend.
- Deposit, withdrawal and trading-key code is as described above (`depositAddress`, `estimatedSeconds`,
  `X-Gigadex-*`, `api.mirror.exchange`).

