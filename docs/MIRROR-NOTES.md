# Mirror: what the docs say, what they don't

I retrieved these on 2026-10-03 with the invite cookie flow (visit the invite URL Cesar shared, then reuse the cookie jar):
`/launch`, `/docs/what-is-mirror`, `/docs/how-microperps-work`. These notes come from reading those pages
directly, not from the project brief. On 2026-10-05 I also read `/docs/attention-markets`, `/docs/private-trading`, `/docs/agentic-trading` (a stub),
`/docs/tokenomics` and `/docs/help` (the FAQ).

## What we know for sure (as of 2026-10-26)

Very little is proven. No one outside Mirror has watched their engine run, and as of 2026-10-26 it isn't live (the
docs show a "$MIRROR launches in … countdown activates soon" banner).

**How this was checked (2026-10-26).** All 8 docs pages were re-fetched and diffed sentence by sentence against
the 2026-10-03/05/09 copies: **no substantive change**, only formatting (the formulas now render). Copies are in
[sources/mirror/2026-10-26/](sources/mirror/2026-10-26/), including the new standalone *Referrers & Builder Revenue*
page. The live web-app bundle (57 JS files) was re-read as text.

**Fact: things we checked ourselves**
- **The attention-token spot curve:** x·y=k with x0 = $5,000 and y0 = 1B, so price = (5,000 + USDC in)² / (5,000 × 1B).
  It reproduces all 7 rows of their spot price table exactly (re-computed independently 2026-10-26; also `src/engine.ts`).
- **The sniping-phase open price:** x1 = (x0 + √(x0·(x0 + 4B)))/2 and P_open = x1² / (x0·y0), where B is total snipe
  USDC. It reproduces all 7 rows of their P_open table exactly. The formula is fully specified in their appendix.
  Impulse doesn't implement the sniping phase yet.
- **What the shipped web app contains** (2026-10-23 and re-checked 2026-10-26). That the code is there is a fact;
  that the backend does it isn't. Details in [research/mirror-infra.md](research/mirror-infra.md).
  - REST routes: `/api/v1/` `markets`, `tokens`, `ticker`, `orderbook`, `trades`, `candles`, `search`, `stats/`,
    `register-signing-key`, `answer-challenge`, and `pulse/new-pairs`, `pulse/final-stretch`, `pulse/migrated`.
  - Realtime channels `trades`, `orders`, `orderbook`, `marketStats`, `activeAssetCtx`, with an `ORDERBOOK_UPDATED`
    event. The market UI has tabs for order book, market trades, recent snipes and top snipes.
  - **No perp-trading client code was found.** Leverage, funding, liquidation and ADL appear only in the docs text and
    marketing cards. There are no routes or channels for positions, margin, leverage or funding. Absence from this
    client doesn't prove absence from the backend.
  - Chain #1 "Mirror", deposits to Mirror-issued addresses on ~22 external chains (12 confirmations for Ethereum, 2
    for Bitcoin, 20 for Tron), withdrawals in USDC, USDT, SOL, ETH, TRX, BNB, BTC or DESO.
  - Login by wallet (Phantom or MetaMask) or email/phone. A browser-generated "Trading Key" signs every request
    (`X-Gigadex-*` headers). API at `api.mirror.exchange`, websocket at `/ws`. Block explorer "coming soon".
- **The team:** led by Nader Al-Naji, creator of DeSo and Basis. DeSo DEX launched in Jan 2023 as an on-chain order
  book.

**Claims: Mirror's docs say so, unverified** (quotes in the next section and in `sources/`)
- No insurance fund. Solvency is checked "before every single trade and every single price tick", with ADL run
  "atomically within the transaction itself if anyone has gone negative."
- Matching and risk run in one Rust core, at 300k+ transactions per second per thread. Markets are isolated by default
  and sharded across threads; cross/portfolio margin is "a simple flag-flip" later.
- "Mirror is a fully-fledged order-book exchange" that can "layer a continuous curve on top of the order-book"; an
  order hits "the curve liquidity or the nearest resting order, whichever offers the better price." This is stated in
  the attention-markets page, about spot.
- "All Attention Tokens start with a spot market and a MicroPerp market that uses that spot price for its oracle price
  calculation." How the perp mark is smoothed, if at all, isn't stated.
- An attention token exists for every social profile and piece of content (X, Instagram, YouTube, GitHub, Twitch,
  OnlyFans, DeSo) from the moment anyone searches its link, with a 60-second sniping auction at one uniform price.
  At platform launch: 24h sniping-only, then a "drip" of openings.
- **Fees:** for Attention Tokens, "50% of this fee is allocated to profile owners", 50% retained by the exchange. Net
  fees go to buy-and-burn: 90% $MIRROR, 10% $DESO. Referrers get 14% / 4% / 2% of fees (3 degrees), referees 10% off;
  2.5% of pre-sale buys and up to 2.5% of snipes go to referrers. Builder fees up to 50% on taker fills. The base fee
  schedule isn't published; one example uses a hypothetical 2.5%.
- Leverage starts at 3× "the moment a spot market is created" and reaches 100× by "a combination of volume and depth".
  The criteria are withheld. Marketing mockups show 10× cross (Stripe pre-IPO), 20× ($ANSEM memecoin perp) and
  10× max (Polymarket mirror).
- New perps start empty, at the "maximum base rate" of funding to attract shorts. Inactive markets keep paying "the
  funding rate determined at the last tick".
- Pre-IPO and VC-backed companies: "robust in the absence of a price feed … companies that do not even have a valid
  spot market yet"; "pricing starting whenever the market opens." A whitelist of VCs' portfolios is auto-listed.
- Third-party markets: the deployer provides the oracle and metadata and earns 90% of that market's fees.
- Stealth Mode hides a user's orders from the public log and book.
- Planned markets: VC-backed startups, every Uniswap and pump.fun token, NYSE/international equities, CME
  commodities, every Polymarket and Kalshi market, Zillow homes.

**Unknown (not in the docs or the app)**
- Whether the engine behaves as claimed, and whether perp trading exists in the backend yet.
- The ADL ranking rule, liquidation mechanics (threshold, penalty, through the book or not), and the funding formula.
- The perp mark/oracle for attention tokens (instant or smoothed), and for pre-IPO markets beyond "no price feed".
- Leverage graduation thresholds, and whether leverage can go down.
- How a pre-IPO perp is settled or flattened at an actual IPO.
- The base trading fee schedule.
- Validators or a single operator, who holds the deposit keys, and whether the log is verifiable.

**Corrections to things we said (2026-10-26)**
- *"Creators don't launch or earn from attention tokens."* **Wrong on earnings.** Profile owners get 50% of
  attention-token trading fees (tokenomics, "$MIRROR Buybacks"). Correct on launching: tokens exist when anyone
  searches the link; the creator doesn't launch them.
- *"Fees go 90/10 to $MIRROR/$DESO burns."* Incomplete: that split applies to **net** fees, after the profile owner's
  50% on attention tokens and after referral payouts.
- *"Mirror's perp is order-book only."* Our assumption, not a doc statement. The curve-plus-book hybrid is described
  for attention-token spot; the docs are silent on the perp's liquidity, and the shipped client has no perp code.
- *"Robinhood's OpenAI tokens drew pushback"* (said in chat about pre-IPO legality) isn't in any of our sources.
  Treat it as unverified.

Every core mechanic (ADL, solvency, leverage, funding) is a claim. Impulse shows whether those claims hang together
and what they cost winners. It can't show that Mirror actually does them.

## Stated in the docs (claims, not verified behaviour)

- **No exchange backstop.** ADL is the *sole* means of settling bad debt: no insurance fund, no HLP-style vault.
  The pitch is that this enables permissionless listing ("first-to-list for everything").
- **"Mathematically-guaranteed solvency".** "Solvency checks before every single trade and every single price tick,
  and running ADL atomically within the transaction itself if anyone has gone negative."
- **One core.** The matching and risk engines are one single-threaded core. They claim >300k tx/s per thread.
- **Isolated margin by default** lets markets shard across threads. Cross/portfolio margin is "a flag flip" later,
  and the docs warn that it can spread socialized losses into other markets.
- **Leverage** starts at 3× and rises with "volume and depth" up to 100×. The criteria aren't disclosed.
- **Funding:** a new market starts at the "maximum base rate" to attract short liquidity. Inactive markets keep
  paying "the funding rate determined at the last tick".
- **Oracles:** third parties can deploy markets by *supplying the oracle* and setting fees, in exchange for 90% of fees.
  Prediction markets get "a mirrored MicroPerp" on Polymarket/Kalshi. The docs **imply** the venue price is the oracle
  but don't say so.
- **Robustness claims:** "function on arbitrarily illiquid price feeds (and even on no price feed at all)", and handle
  equities over nights and weekends because "MicroPerps are robust to gaps in the price feed".

## Architecture details (from the other pages)

- **Hybrid book plus curve.** "Mirror is a fully-fledged order-book exchange, but it also supports the ability to layer a
  continuous curve on top of the order-book." An order fills against whichever of the curve or the best resting order is better.
- **Engine in Rust**, with integer fixed-point: the order request structs use `StandardAtoms` sizes and `RateNanos` (1e-9) fee rates.
- **Attention tokens:** 1B fixed supply on an xy=k virtual-reserve curve (floor market cap $5k; price is quadratic in USDC demand).
  There's a 60s batch "sniping" auction that clears at one uniform price, equal to the post-batch marginal price. At platform
  launch it's sniping-only for 24h, then markets open one at a time in a "drip".
- **Attention perps:** "All Attention Tokens start with a spot market and a MicroPerp market that uses that spot price for its oracle
  price calculation." So the oracle is **Mirror's own curve and book**. How the price is smoothed, if at all, isn't stated.
- **Stealth Mode:** order placements are hidden from the "public transaction log" and the public book, and executions are anonymized.
- **Fees:** referrers get 14% / 4% / 2% of fees across three degrees, and referees get 10% off. Builder fees go up to 50% on taker
  fills. The fee schedule itself isn't published; one example uses a hypothetical 2.5%.
- **Org and token:** "not a company", bootstrapped by founder Nader Al-Naji (Basis, DeSo). $MIRROR pre-sale at $0.0015 base
  ($300M circulating market cap) with a bonus decaying to an effective $0.001, cap of about $118.7M, refundable before launch.

## Not in the docs (we had to choose)

| Gap | Our choice |
|---|---|
| ADL counterparty selection | pro-rata by opposing position size |
| ADL price | bankruptcy price (mark + shortfall haircut) |
| Liquidation before E<0 (MM level, penalty, partial?) | full close at mark when E < MM, no penalty |
| Margin formula on a [0,1]-bounded asset | notional-based, capped at max loss |
| Mark price (oracle vs. last trade vs. blend) | oracle only |
| What "no price feed" means for margin | not supported: trading needs a first tick |
| Withdrawal of unrealized PnL | realized cash only, above IM |
| Prediction-market resolution | final tick to 0/1 + settle all |
| Funding formula | omitted |

## What their solvency claim does *not* say

"Solvent after every state transition" means every account's equity is ≥ 0 and the claims sum to the vault.
It doesn't mean winners get paid in full. On a gap, the winners pay for it, through forced closes and haircuts.
The claim also doesn't address oracle manipulation. If a third party supplies the oracle, it can ADL the
other side of its own position.
