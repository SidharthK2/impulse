# Impulse MVP: a paper-trading MicroPerps exchange

*Built 2026-10-25/26 on the `mvp` branch. It takes the risk engine from simulation to a live venue with play money.*

The research engine (`src/engine.ts`) answers *what happens when a price gaps, and who pays?* on scripted scenarios.
The MVP puts that same engine behind a real exchange: order books, live oracles, accounts, bots and a trading UI.
Gaps, liquidations and ADL happen live, and you can watch who pays.

## Run it

```bash
pnpm install
pnpm start          # builds the web app, then serves app + API on http://localhost:8787
pnpm dev            # development: API on :8787 (tsx watch) + Vite on http://localhost:5173 (proxied)
pnpm test           # engine, exchange and API tests (74)
pnpm typecheck      # engine, server and web
```

| Env var | Default | |
|---|---|---|
| `PORT` | `8787` | API + static app |
| `DATA_DIR` | `server/data` | snapshot location (gitignored) |
| `ADMIN_TOKEN` | `impulse-admin` | header `x-admin-token` for the admin page/API |
| `OFFLINE` | unset | `1` = no network: every market gets a simulated price |
| `BOTS` | on | `0` = no house market maker or noise traders |

To start fresh, point `DATA_DIR` at a new directory. Nothing deletes old snapshots.

## What's in it

| Piece | Where | What it does |
|---|---|---|
| Risk engine | `src/engine.ts` (unchanged) | Positions, margin, liquidation, ADL, funding, graduation, taper, curves, invariants |
| Exchange | `server/src/exchange.ts` | Order books, matching, auto-margin, accounts, history; every change is an engine transition |
| Order book | `server/src/book.ts` | Price-time priority CLOB per market |
| Units | `server/src/units.ts` | Coins ↔ integer lots (Hyperliquid `szDecimals`), coin price ↔ lot price, ticks |
| Feeds | `server/src/feeds.ts` | Hyperliquid mids, Polymarket midpoints + resolution, offline random walk, chart backfill |
| Bots | `server/src/bots.ts` | `maker` ladders every market; `ape`, `degen`, `whale`, `scalper` trade randomly with leverage |
| API | `server/src/api.ts` | JSON over HTTP, websocket hub, static app |
| Views | `server/src/views.ts` | Exact decimal-string JSON for markets, books, accounts, leaderboard |
| Persistence | `server/src/persist.ts` | Whole-exchange JSON snapshot every 15 s and on shutdown (atomic rename) |
| Web | `web/src/` | React + lightweight-charts trading UI |

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
   graduations, settlements) into the risk feed. It also cancels the resting orders of anyone liquidated, and
   returns the collateral of any flat position to its wallet.

Oracle ticks, curve trades and the clock (`advance` every 2 s: funding, TWAP refresh, taper) are engine
transitions too. So "solvent after every transition" holds for the live venue exactly as it does in replay.

## Markets at launch

| Market | Oracle | Notes |
|---|---|---|
| BTC, ETH, SOL, HYPE | Hyperliquid mid | |
| kPEPE, FARTCOIN | Hyperliquid mid | memecoins |
| AAPL | Hyperliquid HIP-3 (`xyz:AAPL`) | an equity perp |
| 4 × `PM-<id>` | Polymarket midpoint (first outcome) | Picked by 24h volume: ends ≥ 3 days out, price 0.08–0.92. Auto-settles when Polymarket resolves |
| `@moonboy` | own xy=k curve, 10-min TWAP | attention market |
| `@anon_dev` | own xy=k curve, **instant** | the pump-attack configuration (finding F) |

Anyone can list an attention market. The admin can mirror any Polymarket market or Hyperliquid perp, or list
manual binaries (optionally with a scheduled resolution and taper) and random-walk perps.

## API

`Authorization: Bearer <apiKey>` for trading (the key is issued at sign-up), and `x-admin-token` for admin.

| Method | Path | |
|---|---|---|
| GET | `/api/markets`, `/api/markets/:id`, `/api/markets/:id/candles`, `/api/markets/:id/positions` | public |
| GET | `/api/feed?market=`, `/api/leaderboard`, `/api/config`, `/api/health` | public |
| POST | `/api/accounts` `{name}` | → `{id, apiKey}`, with a $10k paper deposit |
| GET | `/api/account` | wallet, positions (liq/bankruptcy price, ADL ledger), orders, fills, risk history |
| POST | `/api/faucet` | $10k, once a minute, up to a $100k wallet |
| POST | `/api/orders` `{market, side, type, size, price?, leverage?, reduceOnly?, tif?, slippage?}` | sizes in coins, prices per coin |
| DELETE | `/api/orders/:id` · POST `/api/orders/cancel-all` `{market?}` | |
| POST | `/api/positions/close` `{market}` · `/api/margin` `{market, amount}` (± USD) | |
| POST | `/api/spot/buy` `{market, usdc}` · `/api/spot/sell` `{market, tokens\|"all"}` | attention curves |
| POST | `/api/attention` `{handle, oracleWindow: 0\|60\|600\|3600, adl}` | permissionless listing |
| POST | `/api/admin/price` `{market, price, holdSeconds}` · `/api/admin/release` `{market}` | force a gap, hold the feed |
| POST | `/api/admin/resolve`, `/api/admin/market`, `/api/admin/polymarket` `{ref}`, `/api/admin/hyperliquid` `{coin}`, `/api/admin/deposit`, `/api/admin/bots` | |

Websocket `/ws`: send `{op:"sub", ch}` with `markets`, `feed`, `leaderboard`, `book:<id>`, `trades:<id>`,
`candles:<id>`, or `account` (after `{op:"auth", key}`). The server pushes `{ch, data}` whenever a channel's
payload changes, checked every 500 ms.

## Demo script (5 minutes)

1. `pnpm start`, open http://localhost:8787, and sign up. You get $10k.
2. Go long a Polymarket mirror at 3× and short another. Open **Who paid**.
3. On **Admin** (token `impulse-admin`), hit `−50%` on the market you're long. You're bankrupt, and the risk feed shows the
   shortfall charged to the shorts (mostly `maker`) as an ADL haircut, paid from profit under the capped-PnL rule.
4. Hold a BTC gap of −15% for 30 s and watch the price snap back when the hold ends: a wick, scenario C.
5. Open `@anon_dev` (instant oracle). Go long the perp, then spot-buy $2–5k on the curve, and watch the shorts get
   liquidated in the same transaction. Sell back. That's finding F, live.
6. Read **Leaderboard**: the bots' "ADL haircuts paid" column is the insurance fund that doesn't exist.

## Decisions made for the MVP

| Decision | Why |
|---|---|
| The engine is reused unchanged; the exchange wraps it | The research guarantees (invariants, proofs, 300-history fuzz) carry over to the live venue |
| Auto-margin per fill, isolated per market; flat positions sweep back to the wallet | Mirror is isolated by default. Users never manage buckets by hand, but can add or remove margin |
| No margin reserved for resting orders; a fill that can't be afforded cancels the maker | Simplest correct behaviour: the engine re-checks every fill anyway |
| 5% buffer when margin hits the max-loss cap | At the cap, IM = MM, so the first funding payment would liquidate a fully collateralized binary position |
| Liquidation and ADL stay "close at mark against the opposing side" | That's the engine's model. A real venue would go to the book first (DECISIONS: biggest realism gap) |
| Hyperliquid `szDecimals` lots; five-significant-figure ticks | Gives exact integer lots and lot prices for BTC and for $0.000005 tokens alike |
| Downtime is a pause: the clock origin shifts on restore | Otherwise a restart would charge hours of funding (at the stale premium) in one step and wipe accounts |
| Bearer API keys, not signed requests | Mirror signs every request with a trading key; for paper money a bearer key is enough |
| Bots are ordinary accounts | So their haircuts and liquidations are real data, not special cases |
| Default ADL rule `pnl` (capped pro-rata on profit) | The brief's recommendation (finding 5) |

## Known limitations

- Paper money only: no custody, chain, signatures, KYC or rate limits. API keys sit in localStorage.
- Liquidation closes at mark against the other side, not through the book. There are no partial liquidations,
  liquidation fees or perp fees. The only fee is the 1% spot curve fee.
- Funding's premium uses the **last trade** as the perp price, so after a gap a stale print drives funding until
  someone trades (finding J). The UI flags it.
- Polymarket mirrors have no taper, because Polymarket's end dates aren't reliable resolution times. Admin binaries can taper.
- One process, in memory, snapshotted every 15 s; a crash loses at most 15 s. That's comfortable at MVP scale (one
  laptop, a handful of users). Each engine transition clones the state, which is fine at this size and would need
  rethinking at real scale.
- Graduation, funding and taper parameters are still ours (Mirror publishes none).
