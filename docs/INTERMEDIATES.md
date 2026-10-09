# Intermediate projects: useful for research, and feeding the product

*Researched 2026-10-09 (data availability, existing tools, literature). The criterion: free data that's confirmed to
work, a tool that nobody has built yet, and output that sets a product parameter we currently guess.*

## Ranked

### 1. Market recorder (start first: its value accrues daily)

**What.** A lightweight script that takes minute snapshots of order books and pool liquidity, plus a daily archive of
each venue's risk parameters.

| Source | Endpoint (confirmed live 2026-10-09) |
|---|---|
| Hyperliquid books (incl. HIP-3 `xyz` pre-IPO/equities, `vntl`) | `POST api.hyperliquid.xyz/info` `{"type":"l2Book","coin":...}` |
| Hyperliquid risk params | `{"type":"perpDexs"}`, `{"type":"meta","dex":"xyz"}` → `maxLeverage`, `onlyIsolated`, OI caps |
| Polymarket books | `clob.polymarket.com/book?token_id=` |
| Kalshi books | `api.elections.kalshi.com/trade-api/v2/markets/{ticker}/orderbook` |
| Memecoin pools | GeckoTerminal `/networks/solana/trending_pools` (`reserve_in_usd`) |

**Why now.** Free historical depth essentially doesn't exist. Hyperliquid's API is current-snapshot only, and its
candles are capped at the latest 5,000. Third-party archives start in 2025–26 (pmxt Apr 2026, a HF capture Jul 2026,
paid Telonex Oct 2025). Every unrecorded day is lost.

**Feeds the product.** Real depth replaces the open-interest proxy in leverage graduation. The parameter archive is
an untracked benchmark: the leverage real HIP-3 deployers choose, against the depth we measure.

**Effort.** Less than a day to build. A few MB a day, read-only, and runs fine on a laptop.

### 2. Gap atlas for prediction markets (flagship research)

**What.** A census of price jumps and terminal gaps across resolved Polymarket and Kalshi markets, broken down by
horizon (1m / 1h / 1d), liquidity decile, category and time-to-resolution. Then replay through the engine to find
the leverage that keeps ADL probability under a target at each stage before resolution.

**Why.** The literature review and the tools survey both rank it as the top gap. The only replay is
Nechepurenko's one week (arXiv 2605.10400), and nobody publishes jump distributions.

**Data (confirmed free):**
- Kalshi 1-minute candles with trade **and bid/ask** OHLC plus OI
  (`/series/{s}/markets/{t}/candlesticks?period_interval=1`). Data before 2026-08-10 is under `/historical/*`.
- Polymarket `clob.polymarket.com/prices-history?market=<token>&fidelity=1` (sampled price, not OHLC).
- Gamma API for resolution: `outcomePrices`, `umaResolutionStatus`, `closedTime`.

**Feeds the product.** Data-backed leverage caps by time-to-resolution, and the taper start time and shape.

**Effort.** 2–4 days.

### 3. Manipulation meter

**What.** A cost-to-move calculator. From a book snapshot or curve reserves: the capital needed to push the mark X%
for T minutes. Then the engine's pump-attack harness gives attacker profit at a given OI and leverage, and the oracle
window that makes it unprofitable.

**Why.** Existing work covers only Uniswap TWAP oracles on large pairs (Euler, Chaos Labs, Uniswap). There's nothing
for thin books, bonding curves or oracle-linked perp marks. Incidents make labelled test cases: Hyperliquid JELLY
(Mar 2025) and POPCAT (Nov 2025, ~$4.5–5M HLP loss), dYdX YFI (Nov 2023), Mango (2022). A related measurement, the
~$0.7–1.0M it takes to move a Polymarket market 5pp, is in arXiv 2609.06005.

**Feeds the product.** OI caps, the oracle smoothing window, and a minimum-depth listing rule.

**Effort.** 2–3 days, on recorder data.

### 4. ADL rule lab on real incidents

**What.** Add a third rule, minimax-leverage ("water-filling") ADL from Campbell, Hey, Moallemi and Nutz (arXiv
2603.15963), which they show is optimal for monotone risk measures in single-asset isolated margin. Then replay real
Hyperliquid incidents under all three rules (size, capped PnL, minimax).

**Why.** All public ADL analysis is one large-cap day (10 Oct 2025, Chitra et al.). There's no rule comparison on
long-tail incidents.

**Data.**
- Hyperliquid fills in the `hl-mainnet-node-data` S3 bucket (`node_fills_by_block`). Needs an AWS account and is
  requester-pays (a few dollars).
- The ADL `dir` flag in fills is unverified.
- Reconstruction code: `pluriholonomic/autodeleveraging-analysis` (MIT). `ConejoCapital/HyperReplay` is
  **non-commercial only**, and `HyperMultiAssetedADL` has no license.

**Feeds the product.** The ADL rule choice.

**Effort.** Half a day for the rule. 3–5 days for the incident replays.

## Order

1. Start the recorder now.
2. Build the gap atlas while it accumulates.
3. Build the manipulation meter once there are a few weeks of depth.
4. Add the minimax ADL rule whenever there's half a day.

## Avoid

The 163 GB Polymarket datasets on Hugging Face are too big for an 8 GB laptop, and the free APIs cover what's needed.
S3 sources need an AWS account (requester-pays).

## Other gaps found (lower priority)

- **Cross-venue risk-parameter time series** (Hyperliquid, HIP-3, Polymarket Perps, Kalshi, Lattica, PredMart). The
  recorder's parameter archive covers the Hyperliquid part.
- **Structured incident casebook:** attacker pattern, OI and depth at the time, loss, and the venue's response.
- **Resolution-risk module:** UMA dispute and early-resolution history as a haircut input. Settlement timing is
  measured in arXiv 2609.15368 and 2610.00165; price behaviour between "decidable" and "settled" isn't.
- **Memecoin tail indices** at perp horizons. No fitted EVT exists; pump.fun's API is geo-blocked from the US.
- **Pre-IPO perp mark vs secondary mark.** HIP-3 `xyz:SPCX` has daily candles from 2026-05-17. The sample is small.

## Caveats

Agent-verified, not exhaustive:
- Endpoints marked confirmed returned data on 2026-10-09.
- Dataset sizes and ranges come from documentation.
- Several 2026 papers are single-author, synthetic or short-window.
- Lattica and Amplifi parameters, and the Binance and FARTCOIN figures, are unverified.
