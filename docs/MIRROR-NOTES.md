# Mirror: what the docs say, what they don't

Primary sources: Mirror's invite-gated docs (8 pages, archived in [sources/mirror/](sources/mirror/), fetched
2026-10-26; first read 2026-10-03/05, unchanged in substance since) and the shipped web-app code
([research/mirror-infra.md](research/mirror-infra.md)).

## What we know for sure (as of 2026-10-26)

Very little is proven. No one outside Mirror has watched their engine run, and as of 2026-10-26 it isn't live (the
docs show a "$MIRROR launches in … countdown activates soon" banner).

**How this was checked (2026-10-26).** All 8 docs pages were re-fetched and diffed sentence by sentence against
the 2026-10-03/05/09 copies: **no substantive change**, only formatting (the formulas now render). Copies are in
[sources/mirror/](sources/mirror/), including the new standalone *Referrers & Builder Revenue* page; the older
copies were removed (recoverable from git history). The live web-app bundle (57 JS files) was re-read as text.

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

**Claims: Mirror's docs say so, unverified** (full text in [sources/mirror/](sources/mirror/))
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

## Not in the docs: what our engine chose

Mirror publishes none of these. Our choices live in `src/engine.ts` (rationale in [DECISIONS.md](./DECISIONS.md)).

| Gap | Our choice |
|---|---|
| Liquidation (threshold, penalty, partial?) | Full close at mark when equity < maintenance margin, no penalty, against the opposing side pro-rata by size |
| ADL: who absorbs a shortfall | Per market: `size` (pro-rata by position size) or `pnl` (capped pro-rata on positive PnL, principal fallback) |
| ADL price | Bankruptcy price (mark plus the shortfall haircut) |
| Margin on a bounded asset | Notional / leverage, capped at max loss; optional pre-resolution taper to full max loss |
| Mark price | External tick, or the market's own curve (instant or TWAP) |
| "No price feed" | Not supported: trading needs a first tick |
| Funding formula | Tier base rate (0.05%/h at launch, falling per tier) + clamp(premium / 8, ±4%/h); premium uses the last trade |
| Leverage graduation | 5 tiers (5×–100×) on cumulative volume **and** a depth proxy (OI + curve USDC); tiers never go down |
| Withdrawal of unrealized PnL | Realized cash only, above initial margin |
| Prediction-market resolution | Final tick to 0/1, settle every position |

## What their solvency claim does *not* say

"Solvent after every state transition" means every account's equity is ≥ 0 and the claims sum to the vault.
It doesn't mean winners get paid in full. On a gap, the winners pay for it, through forced closes and haircuts.
The claim also doesn't address oracle manipulation. If a third party supplies the oracle, it can ADL the
other side of its own position.
