# Mirror: architecture, and what we can build

*Written 2026-10-26. Facts only. Every claim carries a tag and a source.*

**Tags**
- **[VERIFIED]** We checked it ourselves for this doc: we computed it (script in the appendix) or read it in our code (read, not run).
- **[NOTE]** Our earlier research note `docs/research/mirror-infra.md` says it. That note records a text read of the JavaScript behind Mirror's invite-gated site (2026-10-23 and 2026-10-26). It was not re-checked for this doc. It is not a public app, and nothing here says trading is live.
- **[DOCS]** Mirror's docs say it. **[DOCS·mockup]** marks text from an illustration widget, not a stated rule.
- **[UNKNOWN]** Not stated anywhere in the sources. No guesses.

**Sources**
- `docs/sources/mirror/*.md`: Mirror's docs pages, fetched 2026-10-26. Paths shortened to `mirror/<page>.md:<line>`.
- `docs/research/mirror-infra.md`: our earlier note on the JavaScript behind Mirror's invite-gated site. Only its direct findings are used here, tagged [NOTE]. Its `[INFERENCE]` lines are not used as facts.
- `src/`, `server/src/`, `web/src/`: our code.

---

## TL;DR

**Architecture.** Mirror describes one exchange core: an order book with a bonding curve on top, and matching plus risk in one atomic thread [DOCS]. Bad debt is settled only by auto-deleveraging (ADL) inside the same transaction. There is no insurance fund [DOCS]. Markets are isolated and sharded across threads [DOCS]. Attention tokens are the launch market: a 60-second snipe auction, then an x·y=k spot curve, and a perp priced from that curve [DOCS]. Our research note says the code behind Mirror's invite-gated site has spot, sniping, signed trading keys and deposit addresses on many chains, and nothing for perps [NOTE]. Pre-IPO, stocks, on-chain tokens and prediction markets are plans only. Their price sources are not stated [UNKNOWN].

**Buildable.** Four mechanisms are fully specified, and we reproduced their numbers: the spot curve, the snipe clearing price, the builder fee, and the fee and referral splits [VERIFIED]. We already built the curve, the perp oracle from the curve, atomic liquidation plus ADL, isolated markets, an order book and external price feeds [VERIFIED]. Not built yet: sniping, curve-on-book routing, builder fees, referrals and fee routing [VERIFIED]. Mirror publishes none of these: fee rates, margin and liquidation rules, the ADL ranking, the funding formula or the graduation thresholds [UNKNOWN]. Our values for these are our own.

---

## 1. Architecture

### 1.1 Box diagram

```
  Users, bots, third-party apps
        │  HTTPS /api/v1/*  +  wss://api.mirror.exchange/ws        [NOTE]
        │  each request signed with a registered trading key       [NOTE]
        ▼
 ┌──────────────────────────── one core per shard ─────────────────────────────┐
 │  Matching engine  ══ same thread ══  Risk engine                    [DOCS]   │
 │   · order book (CLOB)                · solvency check before every          │
 │   · x·y=k curve layered on the book    trade and every price tick   [DOCS]   │
 │     → each order takes the better    · ADL runs inside the same tx  [DOCS]   │
 │       of curve or best resting order · no insurance fund, no vault  [DOCS]   │
 │                              [DOCS]  · isolated margin by default   [DOCS]   │
 │  Shards = groups of isolated markets, one thread each               [DOCS]   │
 └──────────────────────────────────────────────────────────────────────────────┘
        ▲ price inputs                                   │ every trade
        │                                                ▼
  Attention: own spot curve  [DOCS]            Fee → USDC on every trade  [DOCS]
  User-managed: deployer's oracle  [DOCS]        ├ attention: 50% to profile owner [DOCS]
  Stocks / pre-IPO / tokens /                    ├ referrers, builders, deployers  [DOCS]
  prediction markets: source not stated          └ net fees: 90% buy+burn $MIRROR,
                          [UNKNOWN]                          10% buy+burn $DESO [DOCS]

  Money in/out: Mirror-issued deposit addresses on ~20 chains,
  credited after per-chain confirmations                         [NOTE]
  Who holds the keys, consensus, validators, proofs              [UNKNOWN]
```

### 1.2 Components

| Component | What it does | Tag | Source |
|---|---|---|---|
| Matching + risk core | Matching and risk run as one monolithic core, atomically on every transaction. | [DOCS] | `mirror/how-microperps-work.md:31` |
| Throughput | Over 300k steady-state transactions per second on one thread. | [DOCS] | `mirror/how-microperps-work.md:32`, `mirror/attention-markets.md:110` |
| Sharding | Markets are sharded across threads. This relies on isolated margin. | [DOCS] | `mirror/how-microperps-work.md:32` |
| Isolated margin | Default for all markets. Cross or portfolio margin is "a simple flag-flip" later. | [DOCS] | `mirror/how-microperps-work.md:33` |
| Solvency rule | Each market must be solvent after every state transition. Checks run before every trade and every price tick. | [DOCS] | `mirror/how-microperps-work.md:30-31` |
| Bad-debt handling | ADL only. The exchange is not a backstop. No insurance fund or vault. | [DOCS] | `mirror/how-microperps-work.md:20-21` |
| ADL algorithm | Who is deleveraged first, and by how much. | [UNKNOWN] | not stated |
| Liquidation and margin rules | Maintenance margin, liquidation price, liquidation fees. | [UNKNOWN] | not stated |
| Order book + curve | A full order book. A continuous curve can sit on top. An order fills against the curve or the nearest resting order, whichever is better. | [DOCS] | `mirror/attention-markets.md:110` |
| Order request | Rust-syntax struct: side, price, base_size, quote_size, time_in_force, client_order_id, builder_fee. | [DOCS] | `mirror/referrers-and-builder-revenue.md:29-39` |
| Leverage | 3x when the spot market is created. Rises with volume and depth to 100x. Thresholds are withheld. | [DOCS] | `mirror/how-microperps-work.md:15,35-36` |
| Funding | Starts at its "maximum base rate", then stabilizes. Inactive markets keep paying the last rate. No formula given. | [DOCS] | `mirror/how-microperps-work.md:39-42` |
| Mark price | "A standard mark price" once a market matures. No formula given. | [DOCS] | `mirror/how-microperps-work.md:36` |
| Attention token ID | Network plus user id, parsed from a pasted link. Networks at launch: X, Instagram, YouTube, GitHub, Twitch, OnlyFans, DeSo. | [DOCS] | `mirror/attention-markets.md:17` |
| Sniping phase | 60 seconds after first search. Bids are in USDC. All clear at one price, P_open. | [DOCS] | `mirror/attention-markets.md:19-23` |
| Spot curve | x·y=k, x0 = 5,000 USDC, y0 = 1,000,000,000 tokens. Max supply is 1B. | [DOCS] | `mirror/attention-markets.md:21,109,148` |
| Launch drip | First 24h sniping only. Then snipe-weighted opens over 28 days. The schedule is "tentative". | [DOCS] | `mirror/attention-markets.md:62-73` |
| Drip size | The tentative schedule opens 7 + 168 + 336 + 2,016 = 2,527 tokens over days 2–29. | [VERIFIED] | computed from `mirror/attention-markets.md:67-72` |
| Stealth mode | Opt-in. Hides a user's orders from the public log and book. Anonymizes their executions. | [DOCS] | `mirror/private-trading.md:15` |
| Public transaction log | Exists (named in the Stealth Mode text). | [DOCS] | `mirror/private-trading.md:15` |
| Agentic trading | "Coming Soon!" No content. | [DOCS] | `mirror/agentic-trading.md:15-17` |
| User-managed markets | A deployer supplies the oracle and metadata, gets 90% of fees, and pays nothing to deploy. | [DOCS] | `mirror/how-microperps-work.md:25-27`, `mirror/referrers-and-builder-revenue.md:53-54` |
| Fees | Charged on every trade, converted to USDC. Rates not published. | [DOCS] / rates [UNKNOWN] | `mirror/tokenomics.md:119` |
| Fee routing | Attention: 50% to the profile owner. Net fees: 90% buy+burn $MIRROR, 10% buy+burn $DESO. | [DOCS] | `mirror/tokenomics.md:119-120,135` |
| Referrals | Pre-sale 2.5% (1.75/0.5/0.25). Trading fees 14/4/2%. Referee gets 10% off. | [DOCS] | `mirror/referrers-and-builder-revenue.md:17-25` |
| Builder fee | Optional per-order fee on the taker, paid to any account_id. Max 50%. | [DOCS] | `mirror/referrers-and-builder-revenue.md:28-51` |
| Realtime feed | `wss://api.mirror.exchange/ws`, sequence-numbered snapshots and deltas. Staging at `api.staging.mirror.exchange`. | [NOTE] | `docs/research/mirror-infra.md:32` |
| REST API | `/api/v1/` markets, tokens, ticker, orderbook, trades, candles, search, stats, register-signing-key, answer-challenge, post, pulse/new-pairs, pulse/final-stretch, pulse/migrated. | [NOTE] | `docs/research/mirror-infra.md:95-97` |
| Realtime channels | trades, orders, orderbook, marketStats, activeAssetCtx. The market page shows book, trades, recent snipes, top snipes. | [NOTE] | `docs/research/mirror-infra.md:99-101` |
| Auth | Wallet or email/phone login. The browser makes a keypair, registered as a "Trading Key" with permissions. Requests carry `X-Gigadex-Api-Key`, `-Timestamp`, `-Signature`. | [NOTE] | `docs/research/mirror-infra.md:44-48` |
| Deposits | Per-chain deposit addresses fetched from Mirror's API. Credited after confirmations (e.g. Ethereum 12, Bitcoin 2). | [NOTE] | `docs/research/mirror-infra.md:54-66` |
| Withdrawals | USDC, USDT, SOL, ETH, TRX, BNB, BTC, DESO. Per-asset `can_withdraw` flag. | [NOTE] | `docs/research/mirror-infra.md:68` |
| "Chain" | The chain table's id 1 is "Mirror". The block explorer is "Coming soon!". | [NOTE] | `docs/research/mirror-infra.md:36-37` |
| Consensus, validators, custody keys, proofs | Who runs the core and who holds deposit keys. | [UNKNOWN] | not stated; `mirror-infra.md:39-40` found no such strings |
| Perps in the site code | Leverage, funding, liquidation and ADL appear only in docs and marketing cards. No routes, channels or forms for positions or margin. | [NOTE] | `docs/research/mirror-infra.md:102-104` |
| Launch status | Token countdown shows "– –" and "countdown activates soon". Profile mockup says "Real prices and volumes will show at launch." | [DOCS] | `mirror/what-is-mirror.md:42,275-284` |

### 1.3 Market types

"In site code" means our research note found it in the JavaScript behind Mirror's invite-gated site [NOTE]. It does not mean public trading is open (see the launch-status row above).

| Market type | Spot on Mirror? | Perp? | Where the perp price comes from | Status |
|---|---|---|---|---|
| Attention (profiles) | Yes. Snipe auction, then x·y=k curve [DOCS] `mirror/attention-markets.md:20-23,77-78` | Yes, a MicroPerp from day one [DOCS] `mirror/attention-markets.md:20` | "Uses that spot price for its oracle price calculation" [DOCS] `mirror/attention-markets.md:20`. Exact formula (instant, TWAP, other) [UNKNOWN] | Spot + sniping in site code [NOTE] `mirror-infra.md:95-101`. Perp documented only [NOTE] `mirror-infra.md:102-104` |
| Pre-IPO (VC-backed private companies) | No. These companies "do not even have a valid spot market yet" [DOCS] `mirror/how-microperps-work.md:47` | Yes, planned. Auto-listed from a VC whitelist [DOCS] `mirror/how-microperps-work.md:47` | "Robust in the absence of a price feed"; "pricing starting whenever the market opens" [DOCS] `mirror/how-microperps-work.md:46-47`. Mockup shows "≈ $91.5B implied val" [DOCS·mockup] `mirror/what-is-mirror.md:47`. Source [UNKNOWN] | Planned ("Immediately after") [DOCS] `mirror/what-is-mirror.md:43` |
| Stocks (and commodities) | [UNKNOWN] | Yes, planned: NYSE, SSE, Euronext, TSE; CME for commodities [DOCS] `mirror/how-microperps-work.md:46,48` | "Every equity with a price"; "robust to gaps in the price feed" [DOCS] `mirror/how-microperps-work.md:46`. Feed provider [UNKNOWN] | Planned [DOCS] `mirror/what-is-mirror.md:43,102` |
| On-chain tokens | Spot lives on the external DEX (Uniswap, pump.fun, others) [DOCS] `mirror/how-microperps-work.md:49`. Spot on Mirror itself [UNKNOWN] | Yes, planned. Starts at 3x "the moment a spot market is created" [DOCS] `mirror/how-microperps-work.md:35,49` | How the DEX price becomes an oracle [UNKNOWN] | Planned [DOCS] `mirror/what-is-mirror.md:43,90`. Site code has `pulse/new-pairs`, `final-stretch`, `migrated` routes [NOTE] `mirror-infra.md:96-97` |
| Prediction markets | [UNKNOWN] | Yes, planned: one per Polymarket and Kalshi market [DOCS] `mirror/how-microperps-work.md:50` | Mockup shows Polymarket prices (Brazil 22¢) copied to the perp (22.0¢) [DOCS·mockup] `mirror/what-is-mirror.md:58-71`. Feed and settlement rule [UNKNOWN] | Planned [DOCS] `mirror/what-is-mirror.md:43,57` |
| Real estate (Zillow) | No | Planned | Basket of Zillow listings aggregated into a city oracle [DOCS] `mirror/how-microperps-work.md:51` | Planned |
| User-managed | [UNKNOWN] | Yes | The deployer's oracle [DOCS] `mirror/how-microperps-work.md:26` | Documented only |
| $MIRROR token | Pre-sale, then an x·y=k curve [DOCS] `mirror/tokenomics.md:20-22,56` | [UNKNOWN] | — | Not launched: countdown not active [DOCS] `mirror/tokenomics.md:148-157` |

---

## 2. What we can build

**Spec levels.** FULL = a rule or formula precise enough to reproduce Mirror's own numbers. PARTIAL = the behaviour is stated but key parameters are missing. NONE = not specified.

**"In our code?"** comes from reading our code. Tests were not run for this doc.

| Mechanism | Spec | Source | In our code? | What's missing |
|---|---|---|---|---|
| x·y=k spot curve (x0 5,000, y0 1B) | FULL | `mirror/attention-markets.md:78,148,175-178` | Yes. `src/engine.ts:76-83,368-374,635-682` | Spot fee rate. Ours is 1% by default, our assumption (`src/engine.ts:134`) |
| Snipe clearing price P_open and allocation | FULL | `mirror/attention-markets.md:152-169` | No. No "snip" in `src/`, `server/src/`, `web/src/` | The whole phase. Also where the extra USDC goes (see §3, item 5) |
| Snipe USDC accounting (B vs. curve reserve) | NONE | not stated | No | Destination of B − (x1 − x0) |
| Launch drip (sniping-only day, snipe-weighted opens) | PARTIAL ("tentative") | `mirror/attention-markets.md:62-73` | No | Final schedule; sampling method |
| Attention ID from a link | PARTIAL | `mirror/attention-markets.md:17` | Partly. Handle-only listing, no network. `server/src/api.ts:131-149` | Per-network link parsing; "every piece of content" IDs (`mirror/what-is-mirror.md:32`) |
| Perp oracle from own spot curve | PARTIAL | `mirror/attention-markets.md:20` | Yes. Instant or TWAP. `src/engine.ts:85-89,250-279` | Mirror's formula |
| Atomic solvency + ADL every transaction | PARTIAL | `mirror/how-microperps-work.md:30-31` | Yes. Clone, apply, check invariants, commit. `src/engine.ts:786-835`; `resolveDistress` `src/engine.ts:550` | Mirror's ADL ranking. Ours: size or PnL pro-rata, `src/engine.ts:53-62,538-547` |
| Isolated markets | PARTIAL | `mirror/how-microperps-work.md:32-33` | Yes. `src/engine.ts:1-4` | Thread sharding (ours is one process); cross-margin flag |
| Margin and liquidation rules | NONE | not stated | Yes, our own: 3x initial, 6x maintenance. `src/engine.ts:179` | Mirror's rules |
| Leverage graduation 3x → 100x | PARTIAL | `mirror/how-microperps-work.md:35-36` | Yes, our thresholds. `src/engine.ts:26-40,480-490` | Mirror's thresholds (withheld) |
| Funding | PARTIAL | `mirror/how-microperps-work.md:39-40` | Yes, our rates. `src/engine.ts:42-50,492-526` | Mirror's formula and rates |
| Inactive market pays last funding rate | FULL | `mirror/how-microperps-work.md:42` | Yes. `src/engine.ts:42-48,684-699` | — |
| Order book | PARTIAL | `mirror/attention-markets.md:110`; request struct `mirror/referrers-and-builder-revenue.md:29-39` | Yes. Price-time priority, GTC/IOC/ALO. `server/src/book.ts:1-6` | quote_size orders; Mirror's matching details |
| Curve-on-book routing | PARTIAL | `mirror/attention-markets.md:110` | No. Spot goes to the curve only; the book is for perps. `server/src/exchange.ts:95-101` | Split-fill and tie rules |
| Builder fee | FULL | `mirror/referrers-and-builder-revenue.md:28-51` | No. No "builder" in our code | Everything |
| Referral splits | FULL (splits) / PARTIAL (caps) | `mirror/referrers-and-builder-revenue.md:17-25` | No | Meaning of "weighted volume"; how snipe referrals scale toward 2.5% |
| Fee routing (profile owner, buy+burn) | FULL (shares) | `mirror/tokenomics.md:119-120,135` | No. Fees pool in `s.fees`. `src/engine.ts:118` | Fee rates (NONE) |
| Trading fee rates | NONE | not stated | Spot 1% (ours) | Everything |
| User-managed markets | PARTIAL | `mirror/how-microperps-work.md:25-27` | Partly. Any user can list an attention market. `server/src/api.ts:131-149` | Deployer oracle; 90% fee share |
| External price feeds (stocks, tokens, prediction) | NONE | venues named only, `mirror/how-microperps-work.md:46-50` | Yes. Hyperliquid mids, Polymarket midpoints. `server/src/feeds.ts:1-3` | Mirror's sources |
| Prediction-market resolution | NONE | not stated | Yes. Resolve and margin taper. `src/engine.ts:16-23,701-716` | Mirror's rule |
| Stealth mode | PARTIAL | `mirror/private-trading.md:15` | No | Everything beyond one paragraph |
| Signed trading keys | PARTIAL (note) | `docs/research/mirror-infra.md:44-48` | No. Bearer API key. `server/src/api.ts:4`, `server/src/exchange.ts:443` | Signature scheme |
| Realtime websocket | PARTIAL (note) | `docs/research/mirror-infra.md:32,99-101` | Yes. Diff-per-channel push every 500 ms. `server/src/api.ts:326-328` | Sequence numbers, deltas |
| Deposits and withdrawals | PARTIAL (note) | `docs/research/mirror-infra.md:54-68` | Paper money only. `server/src/exchange.ts:451-469` | Custody |
| $MIRROR pre-sale price | FULL | `mirror/tokenomics.md:21-36` | No | — |
| $MIRROR curve seed (y = sold/19, x = P_end·y) | FULL | `mirror/tokenomics.md:84-97` | No | — |
| Agentic trading | NONE | `mirror/agentic-trading.md:15-17` | — | Everything |

### 2.1 Proof of every FULL item

All numbers come from `appendix: check.py` [VERIFIED].

**x·y=k spot curve.** Rule: `price = (5,000 + D)² / (5,000 × 1,000,000,000)` (`mirror/attention-markets.md:78`). Mirror's table (`:81-87`) and ours:

| USDC demand D | Mirror price | Our price | Mirror multiple | Ours |
|---|---|---|---|---|
| $0 | $0.0000050 | $0.0000050 | — | — |
| $10,000 | $0.0000450 | $0.0000450 | — | — |
| $20,000 | $0.0001250 | $0.0001250 | 2.778x | 2.778x |
| $100,000 | $0.0022050 | $0.0022050 | — | — |
| $200,000 | $0.0084050 | $0.0084050 | 3.812x | 3.812x |
| $1,000,000 | $0.2020050 | $0.2020050 | — | — |
| $2,000,000 | $0.8040050 | $0.8040050 | 3.980x | 3.980x |

Widget check (`mirror/attention-markets.md:93-98`): $100K of spot buys after a $100K snipe gives 160M tokens and a $3.125M market cap. Mirror shows 160M and $3.1M.

**Snipe clearing price.** Rule: `x1 = (x0 + √(x0·(x0 + 4B))) / 2`, `P_open = x1² / (x0·y0)`, tokens `= y0 − x0·y0/x1` (`mirror/attention-markets.md:164-168`). Mirror's table (`:51-57`) and ours:

| Snipe total B | Mirror P_open | Our P_open | Mirror multiple | Ours |
|---|---|---|---|---|
| $0 | $0.0000050 | $0.0000050 | — | — |
| $10,000 | $0.0000200 | $0.0000200 | — | — |
| $20,000 | $0.0000328 | $0.0000328 | 1.640x | 1.640x |
| $100,000 | $0.0001250 | $0.0001250 | — | — |
| $200,000 | $0.0002342 | $0.0002342 | 1.874x | 1.874x |
| $1,000,000 | $0.0010733 | $0.0010733 | — | — |
| $2,000,000 | $0.0021025 | $0.0021025 | 1.959x | 1.959x |

Widget check (`mirror/attention-markets.md:33-37`): B = $100K gives 800M tokens (80%) at a $125K market cap. We get 800,000,000 and $125,000.

**Inactive market pays last funding rate.** Rule, quoted: "any active perp positions continue to exist, paying the funding rate determined at the last tick" (`mirror/how-microperps-work.md:42`).

**Builder fee.** Rules, quoted: "an additional charge on the taker", "1bp = 100_000 nanos", "Must be in (0, MAX_BUILDER_FEE_RATE]", max "50% = 500_000_000 nanos", taker fills only, and no referral discount or kickback on the taker side of builder-fee trades (`mirror/referrers-and-builder-revenue.md:36-51`). Checks: 0.0001 × 10⁹ = 100,000; 0.5 × 10⁹ = 500,000,000. Example: $100 notional × 2.5% = $2.50 to the exchange, × 1% = $1.00 to the builder. Mirror says the same (`:48`).

**Referral splits.** Rule: 2.5% of pre-sale buys, split 70/20/10 (`mirror/referrers-and-builder-revenue.md:17-18`). A $1M buy gives $17,500 / $5,000 / $2,500, as in the example (`:18`). The full raise of $118.75M gives $2,968,750 ("nearly $3M", `:17`). Trading-fee shares are 14 + 4 + 2 = 20%, and 14/20 : 4/20 : 2/20 = 70/20/10 (`:21-22`).

**Fee routing.** Rule: 50% of attention fees go to profile owners; net fees go 90/10 (`mirror/tokenomics.md:119-120`). Example: $200M attention + $900M other gives $1.0B net and $900M to $MIRROR. Mirror says the same (`:135`).

**$MIRROR pre-sale price.** Rule: effective price rises linearly from $0.001 to $0.0015 as the sale fills (`mirror/tokenomics.md:27`). As a function of tokens sold T: `p(T) = 0.001 + 0.0005·T/95B`, raised `= ∫p dT`. This reproduces every row of the table (`:30-36`): 10B tokens → $10,263,158 raised, $0.0010526, 42.5% bonus; 47.5B → $53,437,500, $0.0012500, 20.0%; 95B → $118,750,000, $0.0015, 0%.

**$MIRROR curve seed.** Rule: `y_open = sold/19`, `x_open = P_end·y_open` (`mirror/tokenomics.md:85`). This reproduces every row (`:91-96`): 10B → 526,315,789 tokens, $554,017, $210.5M cap; 95B → 5,000,000,000 tokens, $7,500,000, $300.0M cap. The launch-simulator widget (`:62-82`) matches a $10.0M raise and a $200K post-launch buy. The input values themselves are not in the extract [UNKNOWN].

---

## 3. Contradictions in Mirror's own material

| # | Statement A | Statement B | Check |
|---|---|---|---|
| 1 | "100% of trading fees collected go back to token-holders via a buy & burn mechanism. 90% … $MIRROR … 10% … $DESO" (`mirror/what-is-mirror.md:251`) | 50% of attention fees go to profile owners; only "net fees" are burned (`mirror/tokenomics.md:119-120`). Referrers get up to 20% of fees (`mirror/referrers-and-builder-revenue.md:21-22`). Market deployers get 90% (`mirror/how-microperps-work.md:26`). | [DOCS] both |
| 2 | Pre-sale bonus "decays linearly to 0% as tokens are sold" (`mirror/tokenomics.md:22`) | Effective price "increases linearly from $0.001 to $0.0015" (`:27`). The table shows a 20.0% bonus at the half-way point (`:33`). A bonus linear in tokens sold would be 25.0% there. | [VERIFIED] computed |
| 3 | "More precisely, the price quadruples every time the USDC demand for a token doubles" (`mirror/attention-markets.md:77`) | Their own table shows 2.778x and 3.812x for a doubling (`:83,85`). It approaches 4x only for large demand. `mirror/tokenomics.md:83` says "roughly 4x'es". | [VERIFIED] computed |
| 4 | All markets are isolated margin by default (`mirror/how-microperps-work.md:33`). Every market starts at 3x (`:15,35`). | Pre-IPO mockup: "Leverage 10× cross" (`mirror/what-is-mirror.md:51`). Token mockup: "20× leverage" (`:98`). Prediction mockup: "10× MAX" (`:68`). | [DOCS] vs [DOCS·mockup] |
| 5 | x is the USDC reserve; price = x/y (`mirror/attention-markets.md:146`) | The snipe derivation never sets x1 = x0 + B (`:155-168`). For B = $100K, the curve's x grows by $20,000. If every sniper sells back, they get $20,000 of the $100,000 before fees. Where the other $80,000 goes is not stated. | [VERIFIED] computed; destination [UNKNOWN] |
| 6 | Attention tokens "start with a spot market and a MicroPerp market" (`mirror/attention-markets.md:20`) | Our research note found no routes, channels or forms for positions, margin, leverage or funding in Mirror's site code (`docs/research/mirror-infra.md:102-104`). | [DOCS] vs [NOTE] |
| 7 | "Every social profile and every piece of content" gets a market (`mirror/what-is-mirror.md:32`) | A token is identified by network plus user id (`mirror/attention-markets.md:17`). No ID scheme for content is given. | [DOCS] both |

---

## 4. Chat summaries

**Architecture**
```
Mirror = one core per shard: order book + x·y=k curve, matching and risk on one thread [DOCS].
Every trade and tick checks solvency; ADL settles bad debt in the same tx; no insurance fund [DOCS].
Attention tokens: 60s snipe at one price, then x·y=k spot, perp priced off that spot [DOCS].
Site code (per our note): spot, sniping, signed keys, deposits on ~20 chains; no perps [NOTE].
Pre-IPO, stocks, DEX tokens, prediction markets: planned perps; price sources unstated [UNKNOWN].
Custody, consensus, fee rates, margin, ADL ranking, funding formula: not published [UNKNOWN].
```

**What we can build**
```
FULL specs, numbers reproduced: spot curve, snipe P_open, builder fee, fee/referral splits [VERIFIED].
Already ours: curve, curve-priced perp, atomic liquidation + ADL, isolated markets, CLOB, feeds [VERIFIED].
Missing in ours: sniping, curve-on-book routing, builder fee, referrals, fee routing [VERIFIED].
Our own params (Mirror publishes none): margin, graduation tiers, funding, ADL policy, fees [VERIFIED].
Blocked by spec gaps: snipe USDC accounting, oracle sources, prediction-market settlement [UNKNOWN].
```

---

## Appendix: check.py

Run with `python3 check.py`. It needs only the standard library. Output is quoted in §2.1 and §3.

```python
from math import sqrt
x0, y0 = 5000.0, 1e9; k = x0*y0
for D in [0,10e3,20e3,100e3,200e3,1e6,2e6]:                     # spot curve
    print("spot", D, (x0+D)**2/k)
for B in [0,10e3,20e3,100e3,200e3,1e6,2e6]:                     # snipe clearing
    x1 = (x0+sqrt(x0*(x0+4*B)))/2; y1 = k/x1
    print("snipe", B, x1/y1, y0-y1, "curve x gain", x1-x0, "unaccounted", B-(x1-x0))
x1 = 25000; y1 = k/x1; x2 = x1+100e3                            # widget: $100K snipe + $100K spot
print("spot tokens", y1-k/x2, "mcap", x2*x2/k*1e9)
for T in [0,10e9,25e9,47.5e9,60e9,75e9,95e9]:                   # $MIRROR pre-sale + curve seed
    p = 0.001+0.0005*T/95e9; R = 0.001*T+0.0005*T*T/(2*95e9)
    print("presale", T, R, p, "bonus", 0.0015/p-1, "if linear", 0.5*(1-T/95e9), "seed", T/19, T/19*p)
y = 513.1e6; p = 0.001+0.0005*y*19/95e9                         # launch simulator widget
print("sim raise", 0.001*y*19+0.0005*(y*19)**2/(2*95e9), "post buy", (sqrt(0.0019753/0.0010513)-1)*y*p)
print("fees", 0.9*(200e6*0.5+900e6), "refs", [1e6*0.025*s for s in (.7,.2,.1)], 118.75e6*0.025)
print("builder", 100*0.025, 100*0.01, 0.0001*1e9, 0.5*1e9, "drip", 7+7*24+7*48+7*288)
```
