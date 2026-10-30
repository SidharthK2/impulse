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

Needs cargo, and pnpm for the web app.

```bash
OFFLINE=1 make start   # http://localhost:8787 — builds the web app, then runs the Rust server (release)
make start             # same, with live Hyperliquid and Polymarket prices
make dev               # Rust server (debug) on :8787 + Vite on http://localhost:5173
```

Admin page token: `impulse-admin`. The 5-minute demo, the API, settings and env vars are in
[docs/MVP.md](docs/MVP.md).

## Layout

| Path | What it is |
|---|---|
| `rs/engine` | Risk engine: margin, liquidation, ADL, funding, graduation, bonding curves, launches, invariants |
| `rs/server` | Exchange server: order books, matching, HTTP + websocket API, feeds, house bots; a command journal, snapshots and history tables in SQLite (`DATA_DIR/impulse.db`) |
| `web/` | Trading UI: React, TanStack Router/Query/Form/Pacer, zustand, custom canvas chart. Its own pnpm project, the only Node code in the app |
| `docs/` | [MVP.md](docs/MVP.md) (run, demo, API), [API-CONTRACT.md](docs/API-CONTRACT.md), [ACCOUNTING.md](docs/ACCOUNTING.md) (the engine's model and invariants), [DECISIONS.md](docs/DECISIONS.md) |
| `tests/` | Test data for the Rust tests: `scenarios/` (event streams) and `golden/` (the TypeScript reference engine's frozen results). The tests themselves are in `rs/engine/tests` and `rs/server/tests` |
| `archive/` | Not used by the app: the TypeScript reference engine and server, their Vitest suite and Node tooling, the golden-file generator, and the research phase (findings, Mirror sources, simulations). See [archive/README.md](archive/README.md). |

## Check it

```bash
make test        # cargo test: engine, golden-file parity, server unit tests, HTTP and websocket tests
make typecheck   # the web app
```
