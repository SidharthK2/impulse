# Impulse MVP: a paper-trading MicroPerps exchange

*Built 2026-10-25/26 on the `mvp` branch (TypeScript); the backend moved to Rust on 2026-10-30/31. It takes the risk
engine from simulation to a live venue with play money.*

The research engine (`reference/engine/engine.ts`, ported to `rs/engine`) answers *what happens when a price gaps, and who pays?* on
scripted scenarios. The MVP puts that same engine behind a real exchange: order books, live oracles, accounts, bots and a
trading UI. Gaps, liquidations and ADL happen live, and you can watch who pays.

Three products sit on it:

1. **Creator coins**: a bonding-curve coin for a social handle, opened by a 60-second snipe window, with a leveraged
   long/short perp on top.
2. **Pre-IPO perps**: no outside price. The mark is whatever the market's own order book settles on, until an admin IPO
   gaps it to a public price.
3. **ADL instead of an insurance fund**: a shortfall is taken from winners on the other side in the same transaction,
   and every event records who paid.

## Run it

```bash
pnpm install
pnpm start          # builds the web app, then the Rust server (release) serves app + API on http://localhost:8787
pnpm dev            # development: Rust server (debug) on :8787 + Vite on http://localhost:5173 (proxied)
pnpm test           # builds the Rust binaries, then engine, differential, exchange and API tests (vitest)
pnpm test:rust      # cargo test: engine and server unit tests
pnpm typecheck      # engine, TS server and web
```

The TypeScript server is still there as the reference implementation: `pnpm server:ts`, `pnpm dev:ts`.

| Env var | Default | |
|---|---|---|
| `PORT` | `8787` | API + static app (`0` picks a free port) |
| `DATA_DIR` | `rs/data` | snapshot location (gitignored) |
| `WEB_DIR` | `web/dist` | the built app |
| `ADMIN_TOKEN` | `impulse-admin` | header `x-admin-token` for the admin page/API |
| `OFFLINE` | unset | `1` = no network: every market gets a simulated price |
| `BOTS` | on | `0` = no house market maker or noise traders |
| `TEST_CLOCK` | unset | `1` = a clock only `/api/test/*` moves, and those hooks are on (tests only) |

To start fresh, point `DATA_DIR` at a new directory. Nothing deletes old snapshots.

## What's in it

| Piece | Where | What it does |
|---|---|---|
| Risk engine | `rs/engine` (port of `reference/engine/engine.ts`) | Positions, margin, liquidation, ADL, funding, graduation, taper, curves, launches, invariants |
| Exchange | `rs/server/src/exchange.rs` | Order books, matching, auto-margin, accounts, launches, pre-IPO marks, history; every change is an engine transition |
| Order book | `rs/server/src/book.rs` | Price-time priority CLOB per market |
| Units | `rs/server/src/units.rs` | Coins ↔ integer lots (Hyperliquid `szDecimals`), coin price ↔ lot price, ticks |
| Feeds | `rs/server/src/feeds.rs` | Hyperliquid mids, Polymarket midpoints + resolution, offline random walk, chart backfill |
| Bots | `rs/server/src/bots.rs` | `maker` ladders every market; `ape`, `degen`, `whale`, `scalper` trade with leverage, snipe new coins, trade curves |
| API | `rs/server/src/api.rs`, `ws.rs` | JSON over HTTP (axum), websocket hub, static app |
| Views | `rs/server/src/views.rs` | Exact decimal-string JSON for markets, books, accounts, leaderboard |
| Persistence | `rs/server/src/persist.rs` | Whole-exchange JSON snapshot every 15 s and on shutdown (atomic rename) |
| Web | `web/src/` | React trading UI: TanStack Router, Query, Form and Pacer, zustand, a custom canvas chart |

One process, one core: the exchange sits behind a single mutex on a single-threaded runtime, and each request is one
synchronous step against it. Money is `i128` nano-USD everywhere; the engine has no floats.

## How a fill works

1. An order arrives. Validation covers the tick, bounds, leverage against the market's current tier, reduce-only and post-only,
   plus a rough affordability check.
2. Matching walks the opposite side at maker prices. Each match is **one engine transaction**:
   `allocate` margin for each side (only what's needed to reach initial margin at the chosen leverage, at the oracle
   mark), then `trade`. The engine re-checks both sides at mark and asserts every invariant, and the transaction
   commits whole or not at all.
3. If the engine rejects because of the **maker** (it can't afford the fill any more), the maker's order is cancelled
   and matching continues. If the rejection is the taker's, matching stops.
4. After every commit, the exchange records what the engine did (liquidation, bankruptcy, haircuts, forced ADL closes,
   graduations, settlements, opens) into the risk feed, each with the mark at that moment. It also cancels the resting
   orders of anyone liquidated, and returns the collateral of any flat position to its wallet.

Oracle ticks, curve trades and the clock (`advance` every 2 s: book mids for the funding premium, funding, TWAP
refresh, taper, launch opens, pre-IPO marks) are engine transitions too. So "solvent after every transition" holds for the live venue exactly as it does in replay.

## Creator coins

`POST /api/attention {handle}` (anyone) or `POST /api/admin/demo-coin {handle?}` lists `@handle`: an x·y=k curve on
x0 = $5,000 virtual USDC and y0 = 1,000,000,000 tokens, with a perp whose oracle is a 10-minute TWAP of spot.

- **Snipe window, 60 s.** `POST /api/snipe {market, usdc}` takes USDC from the wallet; bids can't be cancelled. The 1%
  spot fee is charged on snipes too. Spot and perp trading are refused until the open. The market view shows the
  window: total, snipers, the projected open price, the 10 largest and 10 latest bids.
- **The open**, on the exchange's 2 s clock: all bids B (net of fee) buy together at one price.
  x1 = (x0 + isqrt(x0·(x0 + 4B))) / 2, y1 = ceil(x0·y0 / x1), P_open = x1 / y1; tokens sold y0 − y1 split pro-rata by
  bid (largest remainder). $100,000 of bids opens at $0.000125 for 800,000,000 tokens.
- **Launch reserve.** Only x1 − x0 enters the curve. The rest of B stays in the market as its launch reserve, counted
  in the engine's USDC conservation invariant (with bids still waiting for an open). In the $100,000 example the curve
  takes $20,000 and the reserve holds $80,000.
- After the open the curve continues from (x1, y1), and the TWAP restarts at the open price as if it had held for a
  whole window, so a pump right after launch takes a full window to move the perp's mark.
- `POST /api/admin/pump {market, usdc}`: a house account buys (usdc > 0) or sells about |usdc| (usdc < 0) on the curve.

## Pre-IPO perps

Kind `preipo`, perp only, source `book` ("own order book"). There's no outside price:

- **Mark** = median(best bid, best ask, last trade). If a side of the book is empty, the last trade; before any trade,
  the seed price. Recomputed after every order, cancel and fill, and on the 2 s clock. Each change is an engine tick, so
  liquidation and ADL run in that transaction.
- `POST /api/admin/preipo {id, name, price, description?}` lists one. **STRIPE-PRE** is seeded at $91.50 on a fresh
  exchange. The implied valuation is mark × 1,000,000,000.
- **IPO**: `POST /api/admin/ipo {market, price}` switches the source to an admin-set public price. The mark gaps to it,
  liquidation and ADL run in that transaction, and a risk event of kind `ipo` records who was hit and the shortfall.
  After it, the market is an ordinary admin-priced perp (`/api/admin/price`).
- The bot maker quotes pre-IPO books with a wider ladder (0.4% to 10% from the mark).

## Markets at launch

| Market | Oracle | Notes |
|---|---|---|
| BTC, ETH, SOL, HYPE | Hyperliquid mid | |
| kPEPE, FARTCOIN | Hyperliquid mid | memecoins |
| AAPL | Hyperliquid HIP-3 (`xyz:AAPL`) | an equity perp |
| 4 × `PM-<id>` | Polymarket midpoint (first outcome) | Picked by 24h volume: ends ≥ 3 days out, price 0.08–0.92. Auto-settles when Polymarket resolves |
| `STRIPE-PRE` | its own order book | pre-IPO perp, seeded at $91.50 |
| `@moonboy` | own xy=k curve, 10-min TWAP | attention market, no snipe window |
| `@anon_dev` | own xy=k curve, **instant** | the pump-attack configuration (finding F) |

Offline (`OFFLINE=1`), the Hyperliquid markets get a simulated random walk and one simulated binary stands in for
Polymarket. Anyone can list a creator coin. The admin can mirror any Polymarket market or Hyperliquid perp, list
manual binaries (optionally with a scheduled resolution and taper), random-walk perps and pre-IPO perps.

## API

`Authorization: Bearer <apiKey>` for trading (the key is issued at sign-up), and `x-admin-token` for admin. Money and
prices are decimal strings in USD; times are ms since epoch. The additions for creator coins and pre-IPO are pinned in
[API-CONTRACT.md](API-CONTRACT.md).

| Method | Path | |
|---|---|---|
| GET | `/api/markets`, `/api/markets/:id`, `/api/markets/:id/candles`, `/api/markets/:id/positions` | public |
| GET | `/api/feed?market=`, `/api/leaderboard`, `/api/config`, `/api/health` | public |
| POST | `/api/accounts` `{name}` | → `{id, apiKey}`, with a $10k paper deposit |
| GET | `/api/account` | wallet, positions (liq/bankruptcy price, ADL ledger), orders, fills, risk history, snipes |
| POST | `/api/faucet` | $10k, once a minute, up to a $100k wallet |
| POST | `/api/orders` `{market, side, type, size, price?, leverage?, reduceOnly?, tif?, slippage?}` | sizes in coins, prices per coin |
| DELETE | `/api/orders/:id` · POST `/api/orders/cancel-all` `{market?}` | |
| POST | `/api/positions/close` `{market}` · `/api/margin` `{market, amount}` (± USD) | |
| POST | `/api/spot/buy` `{market, usdc}` · `/api/spot/sell` `{market, tokens\|"all"}` | curves |
| POST | `/api/attention` `{handle, oracleWindow: 0\|60\|600\|3600, adl}` | permissionless creator coin, 60 s snipe window |
| POST | `/api/snipe` `{market, usdc}` | → `{ok: true}`; only before the open |
| POST | `/api/admin/price` `{market, price, holdSeconds}` · `/api/admin/release` `{market}` | force a gap, hold the feed |
| POST | `/api/admin/demo-coin` `{handle?}` · `/api/admin/pump` `{market, usdc}` | creator-coin demo |
| POST | `/api/admin/preipo` `{id, name, price, description?}` · `/api/admin/ipo` `{market, price}` | pre-IPO |
| POST | `/api/admin/resolve`, `/api/admin/market`, `/api/admin/polymarket` `{ref}`, `/api/admin/hyperliquid` `{coin}`, `/api/admin/deposit`, `/api/admin/bots` | |

Websocket `/ws`: send `{op:"sub", ch}` with `markets`, `feed`, `leaderboard`, `book:<id>`, `trades:<id>`,
`candles:<id>`, or `account` (after `{op:"auth", key}`). The server pushes `{ch, data}` whenever a channel's
payload changes, checked every 500 ms. `markets` carries the snipe, launch, pre-IPO and settings fields, `account`
carries snipes, and `feed` carries the `open` and `ipo` kinds and each event's mark.

## Tests

- `tests/engine/differential.test.ts`: every scenario and 300 random histories (each now launches a creator coin: snipes,
  refused pre-open trades, the open at a random step) through both engines; identical state and effects.
- `tests/engine/engine.test.ts`: engine behaviour, including P_open for $100,000 and the launch reserve in conservation.
- `tests/http/api.test.ts`, `exchange.test.ts`: the HTTP and websocket API, run against an in-process TS server and
  against the Rust binary (started by the vitest global setup with `TEST_CLOCK=1 OFFLINE=1 BOTS=0`).
- `tests/http/launch.test.ts`, `preipo.test.ts`: creator coins and pre-IPO, Rust server only.

Against a server you started yourself:

```bash
TEST_CLOCK=1 OFFLINE=1 BOTS=0 ADMIN_TOKEN=t PORT=8790 DATA_DIR=$(mktemp -d) cargo run --manifest-path rs/Cargo.toml -p impulse-server
BASE_URL=http://localhost:8790 pnpm vitest run tests/http
```

## Demo script (5 minutes)

Start the exchange offline (bots on), and drive it from a second terminal with `curl` and `jq`. The same events show
in the web app at http://localhost:8787 (risk feed, **Who paid**, leaderboard).

```bash
OFFLINE=1 pnpm start                      # terminal 1

B=http://localhost:8787; J='content-type: application/json'; A='x-admin-token: impulse-admin'
KEY=$(curl -s -XPOST $B/api/accounts -H "$J" -d '{"name":"you"}' | jq -r .apiKey); U="authorization: Bearer $KEY"
```

1. **Launch a coin.** A 60-second snipe window opens.
   ```bash
   curl -s -XPOST $B/api/admin/demo-coin -H "$A" -H "$J" -d '{"handle":"demo"}' | jq '{id, snipe}'
   ```
2. **Snipe** $2,000. The bots snipe small amounts too; the projected open price rises with every bid.
   ```bash
   curl -s -XPOST $B/api/snipe -H "$U" -H "$J" -d '{"market":"@demo","usdc":"2000"}'
   curl -s $B/api/markets/%40demo | jq '.market.snipe | {total, snipers, projectedOpenPrice, top}'
   ```
3. **The open**, within 2 s of the window's end: one price for every bid, tokens pro-rata, the rest of the bids held
   as the launch reserve.
   ```bash
   sleep 60; curl -s $B/api/markets/%40demo | jq '.market.launch'
   curl -s $B/api/account -H "$U" | jq '.spot'
   ```
4. **Long with leverage**: 30M tokens (about $300) on the perp at 3×. The bot maker sells it to you.
   ```bash
   curl -s -XPOST $B/api/orders -H "$U" -H "$J" -d '{"market":"@demo","side":"buy","type":"market","size":"30000000","leverage":3}' | jq '{status, fills: [.fills[] | {price, size, maker}]}'
   curl -s $B/api/markets/%40demo/positions | jq
   ```
5. **Pump**: the house buys $50,000 on the curve. Spot jumps about 65×; the 10-minute TWAP mark follows by about 20%
   per 2 s clock step.
   ```bash
   curl -s -XPOST $B/api/admin/pump -H "$A" -H "$J" -d '{"market":"@demo","usdc":"50000"}'
   ```
6. **Shorts liquidated, and who paid.** Within a clock step the short (the maker) is liquidated at maintenance and keeps
   what's left; your long is auto-deleveraged against it at the mark, banking the profit (`ledger.realized`). The
   TWAP steps are smaller than the gap from maintenance to bankruptcy, so there's no shortfall and nobody else pays.
   (On `@anon_dev`, the instant oracle, the same pump bankrupts the shorts inside the pump transaction, and the
   longs pay.)
   ```bash
   sleep 4; curl -s "$B/api/feed?market=%40demo" | jq -r '.[] | "\(.kind)\t\(.price)\t\(.text)"' | head
   curl -s $B/api/account -H "$U" | jq '.ledger'
   ```
7. **Pre-IPO.** STRIPE-PRE's mark is its own book: median of best bid, best ask and last trade, seeded at $91.50.
   Go long 30 shares at 3×.
   ```bash
   curl -s $B/api/markets/STRIPE-PRE | jq '.market | {mark, bestBid, bestAsk, last, preipo}'
   curl -s -XPOST $B/api/orders -H "$U" -H "$J" -d '{"market":"STRIPE-PRE","side":"buy","type":"market","size":"30","leverage":3}' | jq '{status}'
   ```
8. **IPO at $60**: the mark gaps about 35% in one transaction. A 3× long is bankrupt.
   ```bash
   curl -s -XPOST $B/api/admin/ipo -H "$A" -H "$J" -d '{"market":"STRIPE-PRE","price":"60"}'
   curl -s $B/api/markets/STRIPE-PRE | jq '.market | {mark, source, preipo}'
   ```
9. **Who paid.** The feed has your bankruptcy with its shortfall, the shorts' ADL haircuts that covered it (from
   profit first), their forced closes, and the `ipo` event with the total. Your ledger shows `adlCovered`; the
   leaderboard's haircuts column is the insurance fund that doesn't exist.
   ```bash
   curl -s "$B/api/feed?market=STRIPE-PRE" | jq -r '.[] | select(.kind != "listing") | "\(.kind)\t\(.amount)\t\(.text)"' | head
   curl -s $B/api/account -H "$U" | jq '.ledger'
   curl -s $B/api/leaderboard | jq -r '.[] | "\(.id)\t\(.haircuts)"'
   ```

A run of this script on 2026-10-31: 5 accounts sniped $2,705.67 net, the coin opened at $0.000009652 with a $758.38
reserve; the pump liquidated the maker's short one clock step later; the IPO bankrupted the 3× long with a $105.66
shortfall, charged to the maker as a haircut from profit.

## Defaults (ours: Mirror doesn't publish them)

Each market reports these in `settings`, with `ours: true` where the number is ours.

| | Value |
|---|---|
| Leverage | Starts at 3× (Mirror's published start), graduates through 5 tiers to 100× on volume and depth (thresholds ours) |
| Creator-coin perp oracle | 10-minute TWAP of spot |
| Spot fee | 1%, also charged on snipes |
| Snipe window | 60 s |
| ADL | pro-rata on profit first, then principal |
| Funding | base 0.05%/h at launch, falling with each tier; premium (book mid − mark) / mark / 8, capped at ±4%/h (the last trade if a side of the book is empty) |
| Pre-IPO mark | median(best bid, best ask, last trade); shares for the implied valuation: 1,000,000,000 |

## Decisions made for the MVP

| Decision | Why |
|---|---|
| The engine is reused unchanged except for launches; the exchange wraps it | The research guarantees (invariants, proofs, fuzz) carry over to the live venue; launches are in both engines so the differential test covers them |
| Backend in Rust, same JSON as the TS server | The TS tests prove parity: the API tests run against both servers |
| Auto-margin per fill, isolated per market; flat positions sweep back to the wallet | Mirror is isolated by default. Users never manage buckets by hand, but can add or remove margin |
| No margin reserved for resting orders; a fill that can't be afforded cancels the maker | Simplest correct behaviour: the engine re-checks every fill anyway |
| 5% buffer when margin hits the max-loss cap | At the cap, IM = MM, so the first funding payment would liquidate a fully collateralized binary position |
| Liquidation and ADL stay "close at mark against the opposing side" | That's the engine's model. A real venue would go to the book first (DECISIONS: biggest realism gap) |
| A launch opens at one price for every bid; the excess over the curve's cost is held as a reserve | The open price formula is Mirror's; holding B − (x1 − x0) keeps every dollar accounted for |
| The TWAP restarts at the open price over a full window | A pump right after an open must not move a 10-minute TWAP in seconds |
| Pre-IPO marks are engine ticks from the book | Liquidation and ADL then run on book moves exactly as on oracle ticks |
| Hyperliquid `szDecimals` lots; five-significant-figure ticks | Gives exact integer lots and lot prices for BTC and for $0.000005 tokens alike |
| Downtime is a pause: the clock origin shifts on restore | Otherwise a restart would charge hours of funding (at the stale premium) in one step and wipe accounts |
| Bearer API keys, not signed requests | Mirror signs every request with a trading key; for paper money a bearer key is enough |
| Bots are ordinary accounts | So their haircuts and liquidations are real data, not special cases |

## Known limitations

- Paper money only: no custody, chain, signatures, KYC or rate limits. API keys sit in localStorage.
- Liquidation closes at mark against the other side, not through the book. There are no partial liquidations,
  liquidation fees or perp fees. The only fee is the 1% spot curve fee (and on snipes).
- The launch reserve is held, not distributed: nothing pays it out to the creator or back to snipers.
- A pre-IPO mark is only as good as its book. The median resists one quote, but a thin book can be walked, and every
  move is an engine tick that can liquidate. The bot maker is the only liquidity a fresh exchange has.
- Funding's premium uses the book mid, sent to the engine every 2 s. Until the book is re-quoted after a gap (at once
  for the bot maker after an admin gap or IPO, within seconds otherwise), the old quotes still drive it; with a side
  of the book empty it falls back to the last trade, which can be stale (finding J).
- Polymarket mirrors have no taper, because Polymarket's end dates aren't reliable resolution times. Admin binaries can taper.
- One process, in memory, snapshotted every 15 s; a crash loses at most 15 s. Each engine transition clones the state,
  which is fine at this size and would need rethinking at real scale.
- Snapshots are not shared between the servers: the Rust server reads and writes its own format in `rs/data`, the TS
  server its own in `reference/server/data`.
