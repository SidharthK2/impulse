# Data sources for replay, depth and liquidations

*Research agent report, 2026-10-09. **CONFIRMED** = a live, unauthenticated request returned data. **DOCS** = documentation or
web only. **UNCONFIRMED** = could not verify (no keys, no AWS account, or a geo-block). No accounts were created.*

## Polymarket

| Source | Endpoint | Returns / history | Auth / cost | Status |
|---|---|---|---|---|
| Gamma API | `gamma-api.polymarket.com/markets?closed=true` | Metadata, `clobTokenIds`, `conditionId`, `outcomePrices` (resolved: `["0","1"]`), `umaResolutionStatus`, `closedTime`, `resolvedBy`, `umaBond`, liquidity, volume. Deep `offset` is rejected, so use `/markets/keyset` | Free | CONFIRMED |
| CLOB prices-history | `clob.polymarket.com/prices-history?market=<tokenId>&interval=max&fidelity=1` (or `startTs`/`endTs`) | `{t,p}` sampled price, not OHLC or bid/ask. `fidelity` is in minutes, and 1 works. A busy market returned ~1 month with `interval=max`; older markets untested | Free | CONFIRMED |
| CLOB book | `clob.polymarket.com/book?token_id=<id>` | Current full L2 only. **No historical book endpoint** | Free | CONFIRMED (current only) |
| data-api trades | `data-api.polymarket.com/trades?market=<conditionId>&offset=` | Trades with wallet, side, size, price, timestamp, tx hash. Reached ~3 weeks back on a busy market; ceiling untested | Free | CONFIRMED |
| Goldsky subgraphs (old) | `api.goldsky.com/.../orderbook-subgraph` | `ENDPOINT_DEPRECATED` after the V2 migration. Points to the Edge Data API (untested) | — | Dead |
| HF `SII-WANGZJ/Polymarket_data` | orderfilled / trades / markets / users / quant parquet | Claims ~1.9B records, ~163 GB, from Nov 2022. Modified 2026-10-05 | Free | File list CONFIRMED |
| HF `moose-code/polymarket-onchain-v1` (Envio) | CLOB fills + splits/merges/redemptions to 2026-04-24 | CC-BY-4.0, DuckDB over `hf://`. Static | Free | File list CONFIRMED |
| HF `trentmkelly/polymarket_historical_data` | ~5-minute snapshots: `market_snapshots`, `order_book_depth`, `top_holders` from 2026-07-23 | CC-BY-4.0, live, skewed to active markets | Free | CONFIRMED live |
| pmxt Orderbook Archive v2 | `archive.pmxt.dev` hourly parquet (`book`, `price_change`) from 2026-04-13; also Kalshi | You rebuild books from the events | Free (docs) | UNCONFIRMED (empty response) |
| Commercial | Telonex (books from 2025-10-11), Oddpool (from 2026-03-20, free tier), PolyOrderbooks, Apify | Tick depth | Paid | DOCS |

**Historical Polymarket depth exists only in third-party captures.** To get depth for new markets, record `/book`
yourself.

## Kalshi

Base `api.elections.kalshi.com/trade-api/v2`. Public market data needs no auth. Rate limits unverified.

- `/markets` (including `status=settled`): result, `settlement_ts`, `close_time`. CONFIRMED.
- `/markets/trades`: yes/no price, count, taker side, time. CONFIRMED.
- **`/series/{s}/markets/{t}/candlesticks?period_interval=1|60|1440`:** trade OHLC **plus yes_bid / yes_ask OHLC**,
  volume and OI, at 1-minute granularity. CONFIRMED. The bid/ask is unusually good for gap and spread work.
- `/markets/{t}/orderbook`: current depth only. CONFIRMED.
- `/historical/cutoff`, `/historical/markets`, `/historical/trades`: data older than **2026-08-10** (orders before
  2026-09-25) lives under `/historical/*`. CONFIRMED. Historical candles and books untested.

## Hyperliquid

`POST api.hyperliquid.xyz/info`, no auth, ~1200 weight per minute per IP (DOCS).

- **`candleSnapshot`:** **only the latest 5,000 candles per interval.** For 10 Oct 2025, 1m, 15m and 1h returned
  `[]`, while 4h and 1d worked (BTC low 100,837 on Oct 10). CONFIRMED. Deep fine-grained history needs S3, a vendor,
  or your own recorder.
- `l2Book`: current only, 20 levels per side. CONFIRMED.
- `recentTrades`: both wallets, tid, hash. CONFIRMED.
- `fundingHistory`: hourly with premium, back to Oct 2025. CONFIRMED.
- **HIP-3:** `{"type":"perpDexs"}` lists `xyz, flx, vntl, hyna, km, abcd, cash, para, mkts, io`. `meta` with
  `dex:"xyz"` lists 129 assets with `maxLeverage`, `onlyIsolated`, `growthMode` and OI caps. Candles and books work
  for `xyz:TSLA` and `xyz:SPCX`. CONFIRMED.
- `userFillsByTime`: any address, latest 10k fills (DOCS).
- **S3 `hyperliquid-archive`:** `market_data/[date]/[hour]/l2Book/[coin].lz4` (hourly L2) and
  `asset_ctxs/[date].csv.lz4` (funding, OI, oracle). Requester-pays, updated roughly monthly. 403 without
  credentials (DOCS).
- **S3 `hl-mainnet-node-data`:** `node_fills_by_block`, `node_fills`, `node_trades`, `explorer_blocks`,
  `replica_cmds`, `misc_events_by_block`. Fills reportedly start 2025-07-27 (a vendor claim) (DOCS).
- **Hydromancer Reservoir:** fills, liquidations and 1-second candles from 2025-07-28, requester-pays. This is the
  dataset Chitra et al. credit (DOCS).
- **Liquidations and ADL in fills:**
  - Liquidation fills carry `liquidation {liquidatedUser, markPx, method: market|backstop}`.
  - A third-party doc (Nautilus Trader) says ADL fills have `dir == "Auto-Deleveraging"`. **Unverified; check one
    real fill.**
  - Official docs: ADL executes at the previous mark/oracle price, ranked by `(mark/entry)·(notional/account value)`.
- **Rebuilding 10 Oct 2025:**
  - Chitra et al. used 34,983 ADL fills across 19,337 wallets and 162 tickers, grouped into waves by a 5-second gap.
  - Possible via `node_fills_by_block` for 2025-10-10 and 11, filtered on `dir` and `liquidation`.
  - Costs a few dollars of egress and needs AWS credentials. UNCONFIRMED end to end.
- Vendors (DOCS, prices unknown): Dwellir, Allium, Bitquery, QuickNode, GoldRush, 0xarchive.

## Memecoins and bonding curves

- **GeckoTerminal v2:** no key, ~30 requests/min. CONFIRMED.
  - `trending_pools` gives price, FDV and `reserve_in_usd`.
  - `/pools/{a}/ohlcv/minute?aggregate=1` gives 1-minute OHLCV, ~6-month window per docs.
  - `/pools/{a}/trades` covers the last ~24 hours only.
- **DexScreener:** no key, ~300 requests/min. Current price, transaction counts, volume and liquidity. No OHLC or
  trades. CONFIRMED.
- **pump.fun API:** geo-blocked from this IP. PumpPortal `/api/data` returned 404. UNCONFIRMED.
- **Solana RPC:** public `getSlot` works, but it's rate-limited with no deep history. Helius needs a key.
  Curve reserves are in the bonding-curve account (`getAccountInfo`, per the IDL; unverified).
- **Key needed:** Bitquery (pump.fun trades and curve progress; free trial claimed), Birdeye, Dune API, The Graph
  gateway.

## Pre-IPO and private valuations

- **HIP-3 `xyz` (trade[XYZ]):** `xyz:SPCX` daily candles since 2026-05-17 (146 days, 180.0 → 162.69), 20× max
  leverage, live book. Also `xyz:CBRS`. CONFIRMED.
- **HIP-3 `vntl` (Ventuals):** `vntl:ANTHROPIC` 1d candles (~1100 = $B valuation). CONFIRMED, though Ventuals
  sunset in June 2026 (see FACT-CHECK.md).
- Pre-IPO OI ~$106M, cumulative volume $1.46B per Coin Metrics (DOCS).
- Polymarket NPM valuation markets (from 2026-05-19) use the standard Polymarket APIs.
- Notice, Forge and Caplight: paywalled or scrape-only (untested).

## Attention and social data

YouTube Data API needs a key and returns current counts only. X follower history is paid or third-party. Wayback
snapshots are sparse. **Feasible only as a self-recorded series from now on.**

## Ranked by use

| Use | Best sources (effort: S < 1 day, M 1–3 days, L > 3 days) |
|---|---|
| Replaying real paths with gaps | Kalshi 1m candles with bid/ask (S) · Polymarket `prices-history` `fidelity=1` + Gamma (S) · HF trade parquet (M, large) · Hyperliquid candles, funding, HIP-3 (S, recent only at fine granularity) · GeckoTerminal 1m OHLCV (S) |
| Depth and manipulation cost | Your own `l2Book` recorder for Hyperliquid incl. HIP-3 (S, forward-only) · Polymarket/Kalshi `/book` recorders (S) or trentmkelly / pmxt history (S–M) · GeckoTerminal liquidity + PumpSwap reserves via RPC (M) · pump.fun curve via RPC/Bitquery (L) |
| Real liquidations and ADL | Hyperliquid S3 node fills (M–L, AWS, requester-pays) · vendor APIs (S–M, pricing unknown) · live websocket `userFills`/`trades` (S, forward-only) · Chitra et al. tables for validation |

**The single most plan-changing fact:** Hyperliquid's 5,000-candle cap and the lack of historical books. Budget for
recording your own data from now on.
