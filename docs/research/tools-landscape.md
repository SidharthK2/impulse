# Existing tools and gaps for MicroPerp / ADL research

*Research agent report, 2026-10-09, from web search and page fetches. **[UNVERIFIED]** = aggregator, vendor or news
snippets only. The agent couldn't find Mirror via public search; that's expected, since its docs are invite-gated
(we read them directly: see `../sources/mirror/`).*

## 1. Perp risk tooling

**Public ADL research code (the strongest existing asset):**
- arXiv **2512.01112** (Chitra / Gauntlet). Cite **v3** only (v1: 8× and ~$630M; v2: 28× and $653M; v3: $45.0–51.7M
  excess haircut).
- **`pluriholonomic/autodeleveraging-analysis`** (MIT): Python package `oss_adl` and `out/` CSVs (per-wave policy
  metrics). Regenerates the paper's figures, and `--full` clones the two repos below.
- **`ConejoCapital/HyperReplay`:** replays Hyperliquid S3 archives into account state (34,983 ADL fills; 1,147
  negative-equity accounts). **Non-commercial license; commercial use is paid.**
- **`ConejoCapital/HyperMultiAssetedADL`:** taxonomy data for 10/10 (~$2.10B ADL notional, 162 assets). **No
  license**, and the README contradicts itself (p99 leverage 122.69× vs 74.18×).

**Other papers:**
- arXiv **2602.15182** (ADL as online learning): no separate code.
- arXiv **2603.15963** (Risk-Based ADL, Campbell, Hey, Moallemi, Nutz): content and code unverified by this agent.
  The literature agent read the abstract: minimax-leverage ADL is optimal.
- arXiv **2603.09164** (Slippage-at-Risk, Sepper): Hyperliquid book snapshots (5 min, 184 perps, Oct 9 – Nov 3 2025).
  No code stated.
- arXiv **2607.27070**: early-warning signals across seven liquidation cascades. Says its data and pipeline are
  public, and that Binance's liquidation dumps were discontinued.
- Also arXiv 2512.19113 (DeFi derivatives Monte Carlo) and 2102.04591 (EVT BTC margins).

**Hyperliquid analytics:** Hypurrscan (free explorer), Hyperdash (free), ASXN dashboards [UNVERIFIED], Bitquery
(paid liquidation API), Kiyotaka (liquidation heatmaps). **No dedicated insurance-fund or ADL tracker.**

**Commercial and institutional:**
- Coinglass liquidation map: modelled, not actual; paid API.
- **Chaos Labs and Gauntlet:** closed, institutional. Neither has a public perp or ADL simulator.
- Block Analitica: nothing found.
- Drift: margin logic in `drift-labs/protocol-v2` (Apache-2.0), no risk simulator. The third-party `percli` CLI
  exists.

## 2. Leverage on prediction markets

| Product | What | Status |
|---|---|---|
| Lattica | Credit/leverage on Polymarket positions, ≤10×, epoch premiums | Waitlist, closed; no public parameters |
| PredMart | Lending against Polymarket CTF shares on Polygon, 4–5× | Hashlock audit; TVL ~$6k [UNVERIFIED] |
| Amplifi | Prime brokerage, ≤10×, TEE liquidations | pm.wiki only [UNVERIFIED] |
| Kalshi | CFTC margin filing 22 Sep 2026 (self-clearing members, collateral rising into settlement, excludes sports and mentions) | Pending |
| Polymarket Perps | Launched 3 Sep 2026 on crypto, equities, gold and oil (not outcomes). 20× cap, 10× stocks, MM = ½ IM, hourly funding capped at 4%/h, not for US users | ADL and insurance not found [news only] |
| Hyperliquid HIP-4 | Fully collateralized outcome markets (2 May 2026), settled in USDH | No leverage |
| dYdX TRUMPWIN (2024) | Polymarket-referenced election perp | No post-mortem found |

Closest prior art for our setting: **arXiv 2605.10400** (Nechepurenko). No code or data link.

## 3. Prediction-market analytics

- **`Jon-Becker/prediction-market-analysis`** (MIT, ~3.9k stars): a pre-collected **36 GiB** Kalshi + Polymarket
  market and trade dataset. Its analyses are mostly calibration and favourite-longshot bias; no jump analysis
  confirmed.
- **Dune:** prediction-markets dataset (Kalshi from 2021 hourly, Polymarket from Nov 2022). Heisenberg candles;
  EntityML order books (Polymarket from 2025-09-01, Kalshi from 2026-02-17).
- **Whale and insider tools** (Unusual Whales, PolyAlertHub, Polywhaler, Prediedge): closed products.
- **Wash trading:** a Columbia/SSRN study estimates ~25% of Polymarket volume.
- **Resolution incidents:** UMA oracle gamed in the Ukraine minerals market.
- **Not found:** Hashdive, PolymarketAnalytics. **No public jump/gap dataset, and no depth or manipulation-cost model
  for Polymarket.**

## 4. Memecoin and bonding-curve analytics

Mostly commercial APIs (Solana Tracker, Codex, Mobula) and bots. MadeOnSol stats (561k deployers, 1.89% bond rate)
[UNVERIFIED]. **No open labelled manipulation dataset, and no price-impact quantifier.**

**Incident corpus:**

| Incident | Date | What happened |
|---|---|---|
| Hyperliquid POPCAT | Nov 2025 | ~$4.5–5M HLP bad debt; ~5× leverage plus a buy wall |
| Hyperliquid JELLYJELLY | Mar 2025 | Thin-book manipulation |
| dYdX YFI | Nov 2023 | OI from $0.8M to $67M. Remedies: margin thresholds, OI monitoring, profit-withdrawal limits |
| Mango Markets | 2022 | >$100M |

## 5. Oracle-manipulation cost

- Euler: Uniswap v3 TWAP manipulation study and an attack simulator (Bentley). No "oracle risk grader" found.
- Uniswap blog ("v3 TWAP Oracles in PoS"): multi-block attack cost; suggests TWMP or winsorized oracles. There's also
  a Chaos Labs TWAP PDF (unread).
- RedStone/Credora: an oracle risk-rating framework. Chaos Edge streams risk data.
- **Everything targets AMM-TWAP lending oracles. There's nothing for bonding curves or thin oracle-linked perp books.**

## 6. Leverage and listing frameworks

- **Hyperliquid margin tiers** are public and mechanical. Leverage falls with notional (BTC 40× → 20× above $150M;
  ETH 25× → 15× above $100M), and MM = ½ IM. No listing criteria.
- **HIP-3:** deployers set the oracle, leverage and settlement. 500k HYPE stake, slashable. Isolated-only;
  halt-and-settle.
- **Polymarket:** flat caps by asset class. **Kalshi:** tightening toward settlement.
- **No venue publishes a data-driven mapping from depth, volatility or OI to max leverage.** Closest: SaR, EVT,
  Nechepurenko.

## Gaps a solo engineer could build in days to weeks

1. **Prediction-market jump/gap dataset and library** (per-market jump distributions, time-to-resolution hazard,
   terminal gap, correlated resolutions). Nechepurenko used one week. → INTERMEDIATES #2
2. **Open ADL / cascade simulator with pluggable policies** (queue, pro-rata, Chitra-optimized, capped-PnL,
   risk-based) plus replay adapters. **Impulse already has the core.** → INTERMEDIATES #4
3. **Cost-to-move calculator** for thin books and bonding curves, back-tested on POPCAT, JELLY and YFI.
   → INTERMEDIATES #3
4. **Listing-leverage recommender:** depth, volatility/jump stats and OI cap in; max leverage and OI limit out, for a
   target shortfall probability.
5. **Structured incident event study** (POPCAT, JELLY, YFI, SUSHI, Mango, TRUMPWIN, UMA disputes).
6. **Public ADL and insurance-fund dashboard** on Hyperliquid data.
7. **Resolution-risk module** (UMA dispute and early-resolution history).
8. **Cross-venue parameter benchmark** time series (leverage, MM, OI caps, funding caps). → part of INTERMEDIATES #1

**Licensing:** HyperReplay is non-commercial, so a product needs a clean-room rebuild or a license.
HyperMultiAssetedADL has no license.
