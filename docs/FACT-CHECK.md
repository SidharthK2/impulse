# Fact-check: Mac's memo ("Levered markets with no continuous book", 4 Oct 2026)

Checked 2026-10-05 against primary sources: the arXiv API and PDFs, the venue docs (`.md` endpoints),
Crossref, and X posts via fxtwitter. I spot-checked the starred (★) rows myself. The rest were checked by research agents and the
evidence is quoted from the sources.

**Bottom line.** Most of the memo's facts check out, and most of its numbers are real and correctly transcribed. It has
**four material errors**: Ventuals is shut down, Ventuals leverage is 3× not 5×, the "$653M Gauntlet" figure is
superseded or misattributed, and the Nechepurenko papers don't actually evaluate ADL designs like Mirror's. It has
several minor ones too. One verified source, Chitra, **supports the memo's ADL recommendation over the rule this PoC
currently uses**.

## Material errors

| Memo says | Reality | Source |
|---|---|---|
| ★ Ventuals is a "product live today"; "the private-company mark, in the form that is already shipping" | **Ventuals is sunsetting as of 15 Jun 2026.** OPENAI/ANTHROPIC marks were frozen at 24h TWAPs and settled ($1,341.80 / $1,618.90). Index and commodity markets were settled by 18 Jun. The IPO-day flatten the memo calls "the whole product" never happened. The pre-IPO markets were settled to their own book TWAP, "considering that these markets do not have a realtime external reference price." | docs.ventuals.com/sunset-guide, CoinDesk 15 Jun 2026 |
| ★ Private-company venues: "Leverage there is 5x, isolated"; table says Ventuals "Deployer-set" | **Ventuals: 3× max** (SPACEX/OPENAI/ANTHROPIC) and isolated-only. trade[XYZ] is 5× to 10×. | docs.ventuals.com/overview/markets |
| "Gauntlet's later read … unnecessary haircuts near $653M versus an optimal policy" | This is **not a separate Gauntlet study**. It's the **v2 wording of Chitra's own paper** (Chitra is at Gauntlet). In v3 (16 Feb 2026, current), $653.6M is *positions closed*, and excess haircuts are **$45.0–51.7M**. The memo presents the old and new versions as two different estimates. | arXiv:2512.01112 v1–v3 |
| ★ "The event-contract papers say [Mirror's ADL-on-every-transaction] does not survive a resolution to 0" | Nechepurenko 2605.10400 **never mentions ADL or Mirror**. It explicitly says "account shortfall is not identical to exchange bad debt. Exchange loss depends on … insurance funds, and loss-sharing rules." The papers show *accounts* go negative at resolution. They don't show an ADL venue fails. | arXiv:2605.10400 §3.3 |

## Minor errors and imprecision

| Memo says | Reality |
|---|---|
| ★ trade[XYZ] pre-listing funding "0.5% of the normal HyperCore premium, multiplier 0.005" | The docs say **"1% of the standard XYZ perpetual funding calculation"**, i.e. multiplier 0.005 against the standard 0.5. Not universal: SpaceX, Quantinuum and Cerebras used 0.5. |
| trade[XYZ] lists "Oura, Shein, SK Hynix" | SHEIN, SKHY, CXMT and UNITREE are **Converted**. Only OURA is Live (anticipated listing 2 Oct 2026, grace to 1 Dec). |
| trade[XYZ] default settlement "TWAP … unless a transaction price exists" | TWAP from launch is the default. A transaction price *may* be used (M&A, take-private). That's discretionary, not automatic. |
| Lattica "up to 10x, epochs 1h to 90d", "must be flat or rolled before resolution" | 10× and 1h–90d come from the **product site**, not the paper (paper: LTV 40–75%, horizons up to 168h in the tables). Rolling is shown, but no explicit "flat before resolution" rule was found. |
| Lattica's formula "F_ψ = L · P(liquidated) · expected loss" | **Not in Lattica's paper.** It prices shortfall `(B−R)⁺` under a Wang-distorted conditional CDF. The F_ψ notation is the memo's own gloss. |
| Nechepurenko: "Dynamic margin and a staged halt cut final-hour liquidations" | Dynamic margin and leverage compression **liquidated more paths**, and pooled drawdown fell only 5.1%. The *staged halt* cut final-hour liquidations, and terminal shortfall got *slightly worse*. Three of five pre-registered materiality tests failed. The author calls the results "negative design lessons." |
| HIP-3 docs "say to be careful with" blended thin-book/private-mark oracles | The docs warn generally ("most price indices are not amenable as perp oracle sources"). Thin books and private marks aren't mentioned. That part is the memo's inference. |
| HIP-3 slashing "100% for invalid state transition" | The trigger is "irregular inputs that cause invalid state transitions or prolonged downtime". The docs add "inputs that … are not irregular are not slashable" and "in the most likely outcome, slashing never happens on mainnet." |
| Mirror's docs: HIP-3 needs "~$40M" stake | 500k HYPE × ~$92–93 (5 Oct 2026) ≈ **$46M**. Mirror's figure is stale, not the memo's. |
| Polymarket valuation markets: OpenAI, SpaceX, Anthropic, Stripe, Anduril, Databricks | Correct, but a subset of 23 markets (also Kraken, Canva, Epic, Lambda, Neuralink, Perplexity). They're on Polymarket **international**, not the US CFTC venue. |
| Kalshi filing excludes "sports and mention markets" | Also excludes **cultural** markets. Filed 22 Sep 2026 under Reg 40.5. Earliest effective date is about 9 Nov 2026 after a 45-day review. |
| 409As "are a floor, not the mark" | Not in the Ventuals spec. This is the memo's own commentary. |
| Typos: "siix", "didnt not", "Soar … OpenAI the same morning" | OpenAI later drifted to $816.0B (−4.2%) by 29 May, so the "control" isn't stable. |
| Gupta & Polson arXiv:2609.05433 | The paper exists and matches. Its arXiv record oddly shows "submitted 22 Jun 2026" under a 2609 ID. This is cosmetic. |

## Confirmed (selected)

- **arXiv, all 11 exist with matching authors and topics**:
  - **Chitra 2512.01112:** trilemma; $2.1B closed by ADL in 12 min on 10 Oct 2025; $45.0–51.7M overshoot.
  - **Chitra et al. 2602.15182:** production regret about 50% of the bound vs 2.6% optimized; overshoot down to $3M.
  - **Nechepurenko 2605.10400:** terminal equity `−x·p0(1−1/L)`; 13,298 of 61,087 markets; basis-funding weakness near bounds.
  - **Nechepurenko others:** Axient 2608.00631 (smallest sale whose settled-proceeds floor covers debt plus buffer; "not a production-safety claim"); 2605.10428; 2605.10486 (four conduct channels; enforceable position limits can reverse the leverage effect).
  - **Others:** Sepper 2603.09164 ("undefined for new assets"); Cheng et al. 2102.04591 (33% long / 20% short); He et al. 2212.06888; Kim & Park 2506.08573.
- **HIP-3:** 500k HYPE; 183 days; oracle, leverage and `haltTrading` belong to the deployer; slashing 100/50/20%; "does not distinguish between malicious and incompetent"; cross margin irreversible; the 50%-daily-move exclusion; first 3 assets free, then Dutch auction.
- **Ventuals spec** (as a design reference only, since the venue is closed): valuation/1e9; `P = ⅓·Notice + ⅔·EMA_2h(mark)`; polled ≥1/min; hourly funding (~15% annualized below 5% gap, ~1%/h cap above 19%); 1% per 3s mark limit; 0.8–1.2× oracle and 4/7–2× Notice bands; IPO-day mechanics. A1 Research says an "eight-hour" EMA, but the primary spec says 2h.
- **trade[XYZ]:** 30-min EWMA of impact price; ±50% on most (SKHY 10%, SpaceX ±30%); Oura at $50, two resets, 5×, 60-day grace.
- **Lattica paper:** 63–4,000 bps per epoch; about 397M trades and 885M epochs; GPD tails; Wang distortion; +92.5%/3.6% DD vs −27.2%/85%, about 12× loans (a held-out historical replay, not production); cites Rasmussen.
- **Rasmussen / Messari:** 21 Nov 2025, fair fee offsets levered upside, rolling epoch fee. The formula was verified by algebra (the page itself is bot-walled).
- **Soar note (5 Jun 2026):** every number matches, and the arithmetic is internally consistent (11.55%, 60.62% of print, 83.99%, 0.39%). Limits as stated.
- **Kalshi:** the filing exists, with collateral rising into settlement and self-clearing members only.
- **Mirror announcement:** Nader Al-Naji, 22 Sep 2026. The tweet itself only pitches seed-stage startups with leverage. The 3×→100×, ADL and asset list come from the docs.
- **DOIs:** Shiller 1993 (JF 48(3), perpetual futures in the title); Fabozzi–Shiller–Tunaru JEP 2020 (property derivatives retrospective; its "why the housing perp never listed" framing is plausible but I didn't confirm it from the text); Wang 2002 ASTIN.

## Single-sourced or unverifiable

- "$2.1B in 12 minutes" comes only from Chitra's paper. No independent Hyperliquid or press confirmation was read.
- The Messari report body is bot-walled. Its claims were confirmed via the author's tweet, search snippets, and algebra.

## What this changes for Impulse

1. **The ADL rule.** Chitra (v3) proves **capped pro-rata on positive PnL, principal protected,** is the unique rule
   that's monotone, scale-invariant and Sybil-resistant. This PoC's size-pro-rata rule hits principal (scenario B,
   frank). So the memo's recommendation is backed by the source. The catch for an ADL-only venue: positive PnL since entry
   can be smaller than the shortfall, and then principal *must* be touched or solvency fails. That's the trilemma
   in practice. Next step: implement capped-PnL pro-rata with a principal fallback, and report when the fallback fires.
2. **The memo's main template for private companies is a closed venue.** The IPO-flatten was never exercised.
   Ventuals had to settle on its own book's TWAP because it had no external reference. That's evidence *for* the
   difficulty, but against citing it as "already shipping".
3. **Leverage compression into settlement is now the regulated incumbent's own proposal** (Kalshi's filing). That
   supports testing a pre-resolution taper or hard-flat in this engine.
