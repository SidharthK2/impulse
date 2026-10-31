# Decision log

Newest last. Each entry: the decision, why, and what it rules out.

## Scope and process

| Date | Decision | Why |
|---|---|---|
| 2026-10-03 | Build an exploratory PoC of Mirror-style MicroPerps for Cesar | Cesar suggested investigating Mirror and building a PoC. This is exploratory, not a commitment |
| 2026-10-03 | Treat all external inputs (Mirror docs, the project brief, outside research) as **claims to verify**, not facts | User instruction: "dyor and come to your own conclusions" |
| 2026-10-05 | Private GitHub repo `SidharthK2/impulse`; push as work lands; **never add co-author trailers** | User instruction |
| 2026-10-05 | **Scope is generic MicroPerps for any asset**, not prediction-market-only | User: nobody on the project cares about prediction markets alone, and "hardest case" isn't a reason to narrow scope |
| 2026-10-05 | **Simulation only.** No services, API, contracts or real money | Answer the design questions before building infrastructure for a design that might change |
| 2026-10-05 | v1 = everything short of a write-up: graduation, funding, taper. **Then** the brief | User |
| 2026-10-06 | The brief and all docs live as **markdown in the repo**, not published artifacts | User |
| 2026-10-09 | **Write everything down in `docs/`** (research, decisions, progress) | User |
| 2026-10-09 | Next phase: intermediate projects that are both research and product inputs (`INTERMEDIATES.md`, now in impulse-research) | User asked for useful intermediaries toward the final product |
| 2026-10-25 | **Build an MVP: a paper-trading exchange** (order books, live oracles, bots, web UI) on the unchanged engine | User asked for an MVP with a frontend. It supersedes "simulation only" for the `mvp` branch; still no real money, custody or contracts |
| 2026-10-25 | MVP lives in `server/` + `web/` (pnpm workspace) on branch `mvp`; local commits, no push | User |
| 2026-10-25 | Oracles: Hyperliquid mids + Polymarket midpoints + own curves, with admin overrides; simulated prices offline | User chose live feeds; admin gaps make the research findings demoable |

## Engine and tooling

| Date | Decision | Why / alternative rejected |
|---|---|---|
| 2026-10-03 | TypeScript, pnpm, vitest, tsx, TS 5.9 | Matches the sibling `aquifer` repo. TS 7 was rejected as too new |
| 2026-10-03 | **Integer bigint arithmetic** everywhere | No float money. Exact conservation is testable |
| 2026-10-03 | **Cost basis** per position instead of average entry price | Averaging leaks rounding between accounts; cost basis keeps it inside one account |
| 2026-10-03 | Every event is an **atomic transition on a clone** with invariants asserted after it | Mirrors Mirror's "solvent after every state transition". A failed assertion is an engine bug and throws; bad input is a rejection |
| 2026-10-03 | Trades must clear margin **at the oracle mark**, so trades can't create insolvency; only ticks can | Off-mark trade prices can't sneak in bad debt |
| 2026-10-03 | Liquidation (E ≥ 0) and ADL (E < 0) both close **at mark against the opposing side pro-rata by size** | No order book in v1. ADL adds a haircut transfer (= bankruptcy-price close) |
| 2026-10-03 | Withdraw **realized cash only**, above initial margin | Conservative: every withdrawn dollar comes from a closed, bilateral settlement |
| 2026-10-03 | Margin on notional, **capped at max loss** where a bound exists | Fully collateralized positions can never be liquidated. Known flaw: "3×" is lopsided for shorts at low prices (finding 9) |
| 2026-10-05 | Units changed from micro-USD to **nano-USD (1e-9)** | Memecoin prices like $0.000005 need it. Mirror's engine uses nanos (`RateNanos`) |
| 2026-10-05 | **Isolated markets as shards**: per-market config, positions and vault; accounts move money through wallet ↔ allocate/release | Matches Mirror's isolation and sharding claim, and makes it testable (scenario E) |
| 2026-10-05 | Market types are config presets (`binary`, `perp`, `attention`, custom bounds) | Generic engine. Prediction markets are one type |
| 2026-10-05 | Attention markets: xy=k curve with Mirror's published reserves ($5k / 1B); perp oracle instant or TWAP | Reproduces Mirror's price table exactly |
| 2026-10-05 | Pump-attack "defenders" are modelled as arbitrage that **retraces a fraction of the pump, then buys back the exact tokens** | The first model (sell X% of holdings) crashed the price below its start and distorted results |
| 2026-10-05 | ADL rule is per market: **`size`** (default) or **`pnl`** = capped pro-rata on positive PnL with a principal fallback | Chitra (arXiv 2512.01112 v3) shows capped pro-rata is the unique fair rule. Size is kept for comparison |
| 2026-10-05 | Haircutable profit = `min(E, max(0, E − allocated))` | The fuzz test found profit exceeding equity after profit releases |
| 2026-10-05 | Graduation tiers (5/10/20/50/100×) on cumulative volume **and** a depth proxy (OI + curve liquidity); tiers only rise | Mirror: "volume and depth", criteria undisclosed. **These parameters are ours** |
| 2026-10-05 | Funding = tier base rate (0.05%/h at launch → 0.00125%/h) + clamp(premium/8, ±4%/h), held between events | Mirror: "maximum base rate" at launch; inactive markets keep paying. **Parameters are ours.** The last trade stands in for the book price |
| 2026-10-05 | Taper ramps requirements toward **full max loss**, not notional | Notional-based leverage misses the short-at-low-price trap |
| 2026-10-05 | Risk loop processes **one side per round** (bankrupt side first) | A taper can distress both sides at once |

## MVP exchange

| Date | Decision | Why / alternative rejected |
|---|---|---|
| 2026-10-25 | Exchange wraps the engine; each match is one `allocate + trade` transaction | Keeps every engine invariant and proof live. Rejected: a separate margin system in the exchange |
| 2026-10-25 | Auto-margin per fill at the order's leverage; flat positions sweep back to the wallet | Isolated like Mirror, without manual bucket management. Users can still add or remove margin |
| 2026-10-25 | No margin reserved for resting orders; an unaffordable maker is cancelled at match time | Simplest correct rule, because the engine re-checks every fill |
| 2026-10-25 | Lots = 10^-szDecimals coins (Hyperliquid's sizes); 5-significant-figure ticks | Exact integer lots and lot prices from BTC down to $0.000005 tokens |
| 2026-10-25 | 5% margin buffer when the max-loss cap binds | At the cap IM = MM, so funding liquidated fully collateralized binaries |
| 2026-10-26 | Downtime is a pause (shift the clock origin on restore) | Rejected: charging the outage's funding at once, which wipes accounts at the stale premium |
| 2026-10-25 | House bots are ordinary accounts | Their liquidations and haircuts are real data |
| 2026-10-25 | Bearer API keys instead of Mirror-style signed requests | Paper money; signing is a later step |
| 2026-10-25 | Default ADL rule `pnl` for MVP markets | Brief recommendation (finding 5) |
| 2026-10-31 | **Deliberate change:** the funding premium's perp price is the order book's mid when both sides are quoted, else the last trade, else the mark (premium 0). The exchange sends the mid to the engine as a `book` event on every 2 s clock step, ahead of the `advance`, and the bot maker re-quotes a market right after an admin gap or IPO | After a gap (crash, IPO) the last trade is stale, so the premium sat at its ±4%/h cap until someone traded (finding J), which reads as a bug. The book is re-quoted around the new mark within seconds. Supersedes "the last trade stands in for the book price" (2026-10-05). Both engines; the differential histories include `book` events |

## Storage and the Rust-only backend (branch `db`)

| Date | Decision | Why / alternative rejected |
|---|---|---|
| 2026-10-31 | The TypeScript backend is retired to `archive/` (moved to the impulse-research repo the same day), its results frozen as golden files (`tests/golden/`: every scenario, 300 random histories, 300 fuzz histories) | The Rust engine's parity stays proven with no TypeScript at runtime: `crates/engine/tests/golden.rs` replays the stored event lists. Rejected: reimplementing the TS generators in Rust, which would test the Rust engine against itself |
| 2026-10-31 | Journal the inputs (commands), not the outputs (state changes or events) | A deterministic core turns the same commands into the same exchange, so the journal is small and replay is the recovery path and the audit trail at once. Requires every clock read and random draw at intake (`intake.rs`), carried in the command |
| 2026-10-31 | `synchronous=FULL` with WAL, one commit per command, before the reply | An acknowledged order must survive a crash. Measured 0.69 ms per command at the median, 1.9 ms at p99 (apply + commit, bots on, M-series Mac). Rejected: `NORMAL` (can lose the last commits on power loss) and group commit (more throughput than paper trading needs, and replies would wait for a batch) |
| 2026-10-31 | Fail-stop: a failed journal write, or a panic inside a command, stops the process | The alternative is serving state the journal doesn't have; a restart recovers the last committed state, which is exactly what was acknowledged |
| 2026-10-31 | A snapshot right after every recovery (and every 1,000 commands or 60 s, and at shutdown; keep 5) | A replay then never runs old commands through newer code for long; snapshots are an optimization, so a failed one is logged, not fatal |
| 2026-10-31 | Bots and the random walk are clients that submit commands; feed polls are one `Ticks` command each | The core stays a function of its inputs, and a whole poll is one journal row instead of one per market |
| 2026-10-31 | Read tables (fills, risk events, candles, accounts) in the command's transaction, as exact decimal strings | History beyond the in-memory caps, always consistent with the journal; SQLite is never read on the trading path |

## Code structure (2026-10-31)

| Date | Decision | Why / alternative rejected |
|---|---|---|
| 2026-10-31 | Commands are structs with a typed reply (`Apply::Reply`); the journal enum is generated from them | The compiler checks what each caller gets back; the serialized form is unchanged, so journals still replay |
| 2026-10-31 | Amounts, prices and sizes are parsed once at intake (`money.rs`: `Dec`, `Amount`, `Tokens`) | The core works with numbers; a malformed amount is refused before it can be journaled |
| 2026-10-31 | Typed request bodies instead of emulating JavaScript's `Number()` and truthiness | The emulation only mattered for parity with the retired TS server; malformed input now gets 400s with field names (see API-CONTRACT) |
| 2026-10-31 | `VERIFY_STEPS=1` (every test server): a command that leaves `version` alone must leave the state hash alone | Version bumps are manual; a missed one would silently drop a change from the journal. Rejected: hashing in production (a hash per command) |

## Realism (2026-10-31, branch `realism`)

| Date | Decision | Why / alternative rejected |
|---|---|---|
| 2026-10-31 | **Mirror Hyperliquid's book** into ours: every 2 s, its top 10 levels per side become the bot maker's orders, and the mark moves to that book's mid in the same `depth` command | The ladder gave BTC about $47k a side, with a 5 bp spread; real depth and spreads are what make fills and slippage realistic. The levels are ordinary orders, so users still match each other, and resting orders fill when the real market trades through them. Rejected: filling users against a virtual copy of the venue's book outside ours (two sources of liquidity to merge in matching, liquidation and the views) |
| 2026-10-31 | Poll `l2Book` over HTTP every 2 s, 10 levels a side, rather than a websocket subscription | Every book the core sees has to be journaled. A websocket pushes a book per block per coin, so it would be coalesced to about this rate anyway; polling needs no new dependency. The cost: quotes can be up to about 2 s old, so someone watching Hyperliquid live can pick off a moved level on paper |
| 2026-10-31 | The mirror stands aside during admin holds (the ladder quotes the forced price) and after 15 s without a book | An admin gap must still be demoable, and a dead feed mustn't leave a market without liquidity |
| 2026-10-31 | **Perp trading fees in the engine**: per-market taker and maker rates (ppm), charged when a `trade` names its taker, from collateral into the fee pot, capped at the equity left after the fill. Hyperliquid's base tier (0.045% / 0.015%) on every market | Fees change margin and solvency, so they belong where the invariants are checked. Trades without a taker charge nothing, so the golden histories still replay exactly. Rejected: charging fees from the wallet in the exchange (isolated margin would no longer hold everything a position can lose) |
| 2026-10-31 | One-time `upgrade` commands for exchanges an older build made (the first: `fees`, which gives existing markets the default fees), journaled at startup | The change happens through the journal, so replays stay deterministic. Rejected: deserializing old snapshots with fees on (the snapshot round trip would no longer be exact) |

## Deliberately not done (yet)

- **Liquidation through the book, perp fees:** the biggest realism gap. (The order book and matching came with the
  MVP exchange, 2026-10-25; liquidation and ADL still close at mark against the other side.)
- **Minimax-leverage ADL** (Campbell et al., arXiv 2603.15963): planned, see INTERMEDIATES #4.
- **Real-data replay:** planned, see INTERMEDIATES #1 and #2.
- **Cross margin, partial liquidation, liquidation penalties, oracle sanity bands:** out of v1 scope.
