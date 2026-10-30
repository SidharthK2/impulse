# Impulse

A paper-trading exchange for MicroPerps: leveraged perps on anything, with no insurance fund behind them.
Play money only.

1. **Creator coins**: a bonding-curve coin for a social handle, opened by a 60-second snipe window where every
   sniper gets the same price, with a leveraged long/short perp on top.
2. **Pre-IPO perps**: no outside price. The mark is whatever the market's own order book settles on, until an admin
   IPO gaps it to a public price.
3. **ADL instead of an insurance fund**: a shortfall is taken from winners on the other side in the same
   transaction, and every event records who paid.

## Run it

```bash
pnpm install
OFFLINE=1 pnpm start   # http://localhost:8787 — builds the web app, then runs the Rust server (release)
pnpm start             # same, with live Hyperliquid and Polymarket prices
pnpm dev               # Rust server (debug) on :8787 + Vite on http://localhost:5173
```

Admin page token: `impulse-admin`. The 5-minute demo, the API, settings and env vars are in
[docs/MVP.md](docs/MVP.md).

## Layout

| Path | What it is |
|---|---|
| `rs/engine` | Risk engine: margin, liquidation, ADL, funding, graduation, bonding curves, launches, invariants |
| `rs/server` | Exchange server: order books, matching, HTTP + websocket API, feeds, house bots, snapshots |
| `web/` | Trading UI: React, TanStack Router/Query/Form/Pacer, zustand, custom canvas chart |
| `docs/` | [MVP.md](docs/MVP.md) (run, demo, API), [API-CONTRACT.md](docs/API-CONTRACT.md), [ACCOUNTING.md](docs/ACCOUNTING.md) (the engine's model and invariants), [DECISIONS.md](docs/DECISIONS.md) |
| `tests/` | The test suite: `engine/` (engine tests, Rust-vs-TypeScript differential test), `http/` (API tests against the Rust server), `scenarios/` (event streams) |
| `reference/` | The original TypeScript engine and server. Not used by the app; the tests check the Rust code against them. |
| `archive/` | The research phase: findings, Mirror sources, simulations. Not used by the app. See [archive/README.md](archive/README.md). |

## Check it

```bash
pnpm typecheck   # TypeScript: reference engine and server, tests, web
pnpm test        # builds the Rust binaries, then engine, differential and API tests
pnpm test:rust   # cargo test
```
