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
| 2026-10-09 | Next phase: intermediate projects that are both research and product inputs (`INTERMEDIATES.md`) | User asked for useful intermediaries toward the final product |

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

## Deliberately not done (yet)

- **Order book and matching, liquidation through the book, perp fees:** the biggest realism gap.
- **Minimax-leverage ADL** (Campbell et al., arXiv 2603.15963): planned, see INTERMEDIATES #4.
- **Real-data replay:** planned, see INTERMEDIATES #1 and #2.
- **Cross margin, partial liquidation, liquidation penalties, oracle sanity bands:** out of v1 scope.
