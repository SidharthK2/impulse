# Progress journal

What happened, what we learned, and where things stand. Newest last.

## 2026-10-03: start

- Brief: explore leveraged prediction-market trading inspired by Mirror's MicroPerps (Cesar's suggestion).
- Read Mirror's invite-gated docs directly (`sources/mirror/`). Key claims: ADL as the only backstop, solvency after
  every transition, one single-threaded core, isolated margin, 3×→100×.
- Wrote the accounting model first (`ACCOUNTING.md`), then the engine: single binary market, integer arithmetic,
  atomic transitions, invariants.
- Scenarios A, B and C (gap 0.60→0.05, a levered short resolving YES, a gap-up wick). 23 tests including a seeded fuzz.
- **First findings:** solvency is cheap; winners pay through haircuts and forced closes; resolution always gaps; one
  wick decides PnL.

## 2026-10-04 to 05: research memo and fact-check

- Received an outside research memo ("Levered markets with no continuous book", 4 Oct).
- Full fact-check against primary sources (`FACT-CHECK.md`). Most facts hold, with four material errors: Ventuals
  sunset June 2026, Ventuals 3× not 5×, the $653M figure is from a superseded version of Chitra's paper, and the
  Nechepurenko papers don't evaluate ADL venues.
- Net value: a reading list (Chitra's ADL papers, Rasmussen's fee identity, the Axient taper idea). No implementable
  mechanism.

## 2026-10-05: generalise and extend

- **Scope correction:** generic MicroPerps for any asset, not prediction-market-only.
- Engine generalised: multiple isolated markets, nano-USD, unbounded and bounded prices, wallet/allocate/release.
  Scenarios D (memecoin squeeze: a 0.5× short is bankrupted) and E (isolation holds byte-for-byte).
- Read the rest of Mirror's docs. Found the order book + curve hybrid, the Rust engine, and that attention perps
  price off the token's own curve.
- **Attention curve and pump attack** (scenario F, `pnpm attack`): an instant oracle loses all of the shorts'
  collateral for fees; a TWAP only delays the attack; arbitrage liquidity is what stops it.
  - Bug found and fixed: a TWAP with zero elapsed time fell back to spot.
- **ADL rule comparison** (`pnpm compare`, scenario G): capped-PnL is fairer, but when profits can't cover a
  shortfall, principal pays under any rule.
  - Fuzz found haircutable profit exceeding equity after releases; fixed.
- **Graduation, funding, taper** (scenarios H, I, J):
  - Graduated leverage outlives depth.
  - A taper replaces ADL with lost exposure.
  - Launch funding drains idle positions.
  - A stale last trade creates a reverse funding premium during pumps.
- 53 tests. All parameters for graduation, funding and taper are ours.

## 2026-10-06: brief

- `BRIEF.md` for Cesar: TL;DR, Mirror's claims, nine findings with dollar figures, design recommendations, six
  questions for Mirror, limitations.

## 2026-10-09: research for intermediate projects

- Three research passes (`research/`): data availability (endpoints confirmed live), existing tools, literature.
- **Key facts:**
  - Hyperliquid caps candles at the latest 5,000 and has no historical books.
  - Free historical depth essentially doesn't exist.
  - Kalshi offers 1m candles with bid/ask.
  - Polymarket offers 1m price history.
  - Chitra's ADL reconstruction code is public (MIT).
  - A third ADL rule exists: minimax-leverage (arXiv 2603.15963).
- Plan in `INTERMEDIATES.md`: recorder → gap atlas → manipulation meter → ADL rule lab, each feeding a MicroPerp
  parameter we currently guess.
- Archived the Mirror docs text into `sources/mirror/`. The two core pages were re-fetched and are unchanged in size
  since 2026-10-03.

## 2026-10-23: how Mirror is built

- Inspected Mirror's production web-app bundle (with the invite cookie, read as text). Write-up in
  `research/mirror-infra.md`.
- **Findings:**
  - Mirror runs its own CLOB plus curve in a Rust core, and presents it as its own chain (chain id 1 "Mirror", block
    explorer "coming soon").
  - Trading uses a registered trading key that signs API requests.
  - Custody uses Mirror-issued deposit addresses on about 20 chains, credited after confirmations. That's custodial,
    by inference.
  - No smart contracts in the trading path.
- Still unknown: validators or a single operator, who holds the deposit keys, and whether the log is verifiable.

## 2026-10-24: what we know for sure

- Added "What we know for sure" to `MIRROR-NOTES.md`. It sorts what we know into fact (checked ourselves: the curve
  math, the web-app code, the team), claim (Mirror's docs: every core mechanic), and unknown.

## 2026-10-25/26: MVP, a paper-trading exchange

- **Scope (user):** build an MVP, frontend included. Answers up front: a paper-trading exchange (not a simulator UI,
  not the recorder); live oracles plus own curves; new `server/` and `web/` packages in this repo on branch `mvp`;
  commit locally, no push.
- **Server** (`server/`): an order book per market in front of the unchanged engine. Each match is one atomic
  `allocate + trade` engine transaction, with auto-margin at the chosen leverage, marked at the oracle. Ticks, curve
  trades and a 2-second clock are engine transitions too. Includes the HTTP + websocket API, snapshots, and house bots
  (`maker` plus four noise traders).
- **Oracles:** Hyperliquid mids (BTC, ETH, SOL, HYPE, kPEPE, FARTCOIN, HIP-3 AAPL), and Polymarket midpoints for four
  liquid long-dated binaries (auto-settling on resolution). Two attention markets: one with a TWAP oracle, one instant.
  The admin can mirror any Polymarket market or Hyperliquid perp.
- **Web** (`web/`): trade page (candles with entry/liq/bankruptcy lines, book, tape, order form with margin, liquidation
  and max-loss preview, spot curve panel), positions with an ADL ledger and "who paid", risk feed, leaderboard, how it
  works, admin (gaps, holds, resolve, list, bots). Checked with headless-Chrome screenshots (desktop and phone) and a
  scripted run: sign up → order → limit from the book → cancel → close.
- **Found while building:**
  - Binary positions at the max-loss cap have IM = MM, so the first funding payment liquidated them. The fix is a
    5% buffer at the cap.
  - A restart after downtime would charge the whole outage's funding at once. Downtime is now a pause.
  - After a forced gap, the stale-last-trade funding premium (finding J) goes to ±4%/h until someone trades. It's
    visible live and flagged in the UI.
- 74 tests (53 engine + 15 exchange + 6 API). Full write-up: [MVP.md](../../docs/MVP.md).

## 2026-10-26: fact check against primary sources

- **Trigger:** the user asked for full research from primary sources only, because answers in chat had drifted.
- Re-fetched all 8 Mirror docs pages and diffed them against the archive: **no substantive change** since 2026-10-09.
  Archived in `sources/mirror/` (replacing the older copies), including the new standalone Referrers & Builder
  Revenue page.
- **Recomputed both curve tables independently:** spot price and sniping-phase P_open. 14/14 rows match exactly.
- Re-read the shipped web-app bundle. It has a spot order book, trades, candles, snipes and memecoin-style `pulse`
  feeds; **no perp-trading code**. Mirror isn't live (launch countdown).
- **Corrections** (logged in `MIRROR-NOTES.md`): profile owners **do** earn 50% of attention-token fees; the 90/10
  burn split applies to net fees; "perp is order-book only" was our assumption; one legal remark made in chat
  was unsourced.
- `MIRROR-NOTES.md` "What we know for sure" rewritten as of 2026-10-26; `research/mirror-infra.md` and
  `POSITIONING.md` updated.
- **Pruned:** superseded doc copies, duplicated and stale MIRROR-NOTES sections (refreshed the "what our engine chose"
  table), RESEARCH-NOTES' finished to-do list; added a dated note to BRIEF instead of rewriting what was sent.

## Current state

- **Engine:** v1 complete (simulation). 10 scenarios (A–J), `pnpm demo | attack | compare | test`.
- **MVP exchange** (branch `mvp`): live paper-trading venue on the engine, `pnpm start`. See `MVP.md`.
- **Tests:** 74 (53 engine + 15 exchange + 6 API).
- **Docs:**
  - `BRIEF.md`: findings for Cesar.
  - `ACCOUNTING.md`: the model.
  - `DECISIONS.md`: why.
  - `INTERMEDIATES.md`: what's next.
  - `research/`: the research behind it.
  - `sources/`: archived primary material.
- **Next:** start the market recorder (INTERMEDIATES #1). Its depth data can replace the MVP's open-interest
  depth proxy, and liquidation through the book is the MVP's biggest realism gap.
