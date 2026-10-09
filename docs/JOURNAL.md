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

## Current state

- **Engine:** v1 complete (simulation). 10 scenarios (A–J), `pnpm demo | attack | compare | test`, 53 tests.
- **Docs:**
  - `BRIEF.md`: findings for Cesar.
  - `ACCOUNTING.md`: the model.
  - `DECISIONS.md`: why.
  - `INTERMEDIATES.md`: what's next.
  - `research/`: the research behind it.
  - `sources/`: archived primary material.
- **Next:** start the market recorder (INTERMEDIATES #1).
