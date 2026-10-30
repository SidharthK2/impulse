# Literature survey: what's measured and what's still open

*Research agent report, 2026-10-09. **[V]** = abstract read via the arXiv API. **[W]** = web or secondary only.
**[?]** = unconfirmed. Abstracts only; full papers weren't read. Several 2026 papers are single-author and
synthetic or short-window.*

## 1. Jump and gap distributions

**Measured:**
- **Nechepurenko 2605.10400 [V]:** mechanical replay of Polymarket paths over one week (21–27 Apr 2026); 13,298 of
  61,087 markets pass its filters. Dynamic margin pre-empts more paths, pooled drawdown falls only 5.1%, and a staged
  halt cuts final-hour liquidations but not terminal shortfall. It isn't a fitted jump distribution.
- **2510.15205 [V]:** logit jump-diffusion for Polymarket and a belief-vol surface. Sample size not stated.
- **2604.24366 [V]:** Polymarket microstructure on 600 markets, 30B book events over 52 days. Depth isn't
  concentrated at the top of book. Inferred trade sign matches on-chain only ~59% of the time. No jumps.
- **2609.06005 [V]:** 173.7M trades and 44,976 "dislocations" (≥5pp, one-sided flow). It takes **~$0.7–1.0M to move
  a market 5pp** and get it cited. That's price impact, not a gap distribution.
- **2606.19517 [V]:** Polymarket BTC thresholds vs option-implied: a 5.6–6.3pp gap, AR(1) half-life ~4h.
- **2610.00173 / 2610.00165 / 2609.15368 [V]:** Kalshi and Polymarket settlement timing.
  - Kalshi: determination to endpoint averages 322.5s, max 7,133s.
  - Polymarket: median request-to-first-proposal is 182s (legacy) vs 176k–744k s on modern routes.
  - **Price behaviour between "decidable" and "settled" is unmeasured.**
- **Memecoins:**
  - 2507.01963 [W]: 82.8% of tokens that gained >100% show artificial growth.
  - 2602.14860 [V]: pump.fun graduation modelling.
  - 2606.08232 [V]: 15-day paper deployment; skew −1.21, excess kurtosis 6.6.
  - Solidus [W]: 98.6% of pump.fun tokens are scams.
  - **No fitted tail index at 1m/1h/1d.**
- **Pre-IPO:**
  - **Gupta & Polson 2609.05433 [V]:** SpaceX perp consensus beat the bookbuilt offer (one event).
  - Cerebras and SpaceX anecdotes [W].
- **Cheng et al. 2102.04591 [V]:** BitMEX BTC GEV. Daily liquidations 3.51% long and 1.89% short. Margin 33% long and
  20% short for a 1% daily call rate.

**Missing:**
- Cross-venue jump distributions by horizon, liquidity and time-to-resolution.
- Final-hours vs terminal-gap behaviour.
- Memecoin tail indices.
- A pre-IPO perp vs secondary-mark time series.

## 2. Margin and leverage calibration for new or illiquid assets

- **Sepper SaR 2603.09164 [V]:** forward-looking liquidation-slippage quantiles from book microstructure, mapped to
  capital requirements. "Predictive validity" is claimed, not quantified.
- **Hyperliquid tiers [W]:** leverage by position notional, not market OI. HIP-3 deployers set flat caps (e.g. 20×
  on xyz equities).
- **Chaos Labs / Gauntlet [W]:**
  - Order-book-based size tiers (dYdX); conservative heuristics for new listings.
  - Chaos lending caps at 2× the liquidity within the liquidation-penalty price impact.
- **CCP literature [W]:** FHS and anti-procyclicality (Bank of England, Gurrola-Perez & Murphy). **Never applied to
  crypto perps.**
- **Axient 2608.00647 [V]:** 5× leverage "materially increases capital pressure" (synthetic).
- **Missing: any empirical rule linking leverage to depth or volume.** Nothing validates Mirror's 3×→100×.

## 3. ADL and loss socialization

- **Chitra et al. 2512.01112 [V]:**
  - Proves a trilemma.
  - Hyperliquid 10 Oct 2025: $2.1B closed in 12 minutes.
  - Overshoot: $45.0–51.7M of excess profit lost (≈$653.6M of positions closed).
  - Binance overused ADL more than Hyperliquid did.
  - The only public ADL-event dataset analysis.
- **2602.15182 [V]:** online-learning formalisation.
- **Campbell, Hey, Moallemi, Nutz, "Risk-Based Auto-Deleveraging" 2603.15963 [V]:** **minimax-leverage
  (water-filling) ADL is optimal for all monotone risk measures in single-asset isolated margin**; distribution-free
  and resistant to wash trading. **A third rule for Impulse's policy comparison** (INTERMEDIATES #4).
- No analysis of Drift/Paradex pro-rata, BitMEX/OKEx clawbacks, or FARTCOIN Apr 2026 [W, unconfirmed].
- **Missing: ADL on long-tail, low-depth perps.** Everything public is one large-cap day.

## 4. Oracle and manipulation cost

- **AMM TWAP [W]:**
  - Mackinga, Nadahalli, Wattenhofer (ePrint 2022/445): attacks on Uniswap v2 TWAPs.
  - Euler's v3 cost note (Bentley).
  - Chaos Labs / Uniswap PoS post: two-block attacks on top pairs are prohibitively expensive.
  - Large pairs only.
- **Prediction markets:**
  - **2503.03312 [V]:** randomised price shocks in 817 markets; effects persist 60 days, and more traders and volume
    resist manipulation.
  - Rothschild & Sethi (Intrade 2012) [W].
  - 2606.31675 [V]: 5-minute BTC contracts attract settlement-time spot flow.
  - 2609.06005 [V].
  - **Nechepurenko 2605.10486 [V]:** leverage weakly enlarges the manipulation payoff unless impact, detection or
    position limits bite.
- **Perp incidents [W]:** Mango (spot oracle up >13× in 30 minutes), JELLY, POPCAT, XPL.
- **Missing:** cost-to-move vs OI/depth for long-tail perp marks; tests of smoothing parameters; funding
  manipulation; bonding-curve cost-to-move.

## 5. Funding for illiquid or non-tradable underlyings

- He et al. 2212.06888 [V]: no-arbitrage pricing and bounds; crypto deviations exceed FX and shrink over time.
- Ackerer, Hugonnier, Jermann 2310.11771 [W]: perp = expected spot at a random time.
- Kim & Park 2506.08573 [V]: BSDE funding to track a target.
- Gupta & Polson 2609.05433 [V]: the funding rule picks both the benchmark and the discount; a vol risk premium can
  break the peg; the pre-listing premium is structural.
- 2605.10400 [V]: funding trilemma near the boundaries.
- **2605.31431 [V]:** an implied settlement-discount term structure from near-certain Polymarket contracts. **Relevant
  to carry and funding near resolution.**
- **Missing:** empirical funding paths for prediction-market, memecoin and pre-IPO perps.

## 6. Leverage on prediction markets (to Oct 2026)

- **Rasmussen (Messari, Nov 2025):** fair jump-risk pricing cancels levered upside. Cites dYdX TRUMPWIN (Oct 2024,
  20×, Polymarket oracle).
- **Nechepurenko series:**
  - 2605.10400, 2605.10428 (taxonomy), 2605.10486 (manipulation).
  - Axient 2608.00631 (hard-flat) and 2608.00647 (credit waterfall).
  - Sep–Oct 2026 finality papers: 2609.15368, 2609.15373, 2609.16642, 2610.00165, 2610.00173, 2610.00183.
  - Axient 2610.02834 and 2610.02838.
  - Mostly synthetic or one-week.
- **Kalshi [W]:** a CFTC-approved BTC perp (leverage figure unconfirmed), equity-index perp filing (Aug 2026), margin
  filing (Sep 2026).
- **No public liquidation or shortfall data from any live prediction-market perp venue.**

## Open questions, ranked

Each is unanswered with public data, doable solo in days to weeks with public data plus the Impulse engine, and sets
a product parameter.

| # | Question | Data | Output | Product parameter |
|---|---|---|---|---|
| 1 | Jump and terminal-gap distribution for binaries by horizon, liquidity and time-to-resolution | Polymarket prices-history + trades; Kalshi 1m candles | Tail quantiles of \|Δp\| at 1m/1h/1d; last mark vs 0/1; the L keeping P(ADL) < target | Leverage caps, taper schedule |
| 2 | Empirical leverage-vs-depth rule | Hyperliquid/Binance low caps + depth snapshots, or spot OHLCV + pool depth | Max L with P(1-day loss > 1/L) < target, per depth bucket, vs SaR | Graduation tiers keyed to depth |
| 3 | ADL on thin markets: frequency, haircut size, and whether the rule matters | On-chain fills for JELLY, POPCAT, XPL | Winner haircut, solvency and exits under pro-rata / capped-PnL / minimax | ADL rule |
| 4 | Cost-to-move vs OI/depth, and oracle smoothing | Pool/book depth, incident reconstructions | Capital to trigger liquidations and shortfall vs window and OI cap | OI caps, smoothing window, min-depth listing |
| 5 | Does the final-hours path predict the terminal gap? (stale-terminal cases) | Decidability clocks (2610.00173, 2609.16642) + price paths | How often the price is still uncertain after the outcome is decidable | Taper start, delisting rule |
| 6 | Funding for prediction-market perps | Settlement-discount term structure (2605.31431), Polymarket paths | Funding paths and payer-solvency failures per rule | Funding formula and clamp |
| 7 | Memecoin tails and survival at perp horizons | pump.fun / DEX OHLCV | Tail index and survival by launch age, fed to the pump-attack sweep | Leverage for new curve assets |
| 8 | Pre-IPO perp mark vs secondary mark | HIP-3 `xyz` candles vs secondary/IPO prices | Basis, funding and gap at listing | Mark design for non-tradables (small sample) |

**Unconfirmed in this survey:** Lattica's 885M-epoch figure (it's in Lattica's paper per the earlier fact-check),
Kalshi's 5.9×, Binance's $188M.
