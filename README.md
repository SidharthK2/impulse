# Impulse

A small reference engine for **MicroPerps: leveraged perps on any asset with ADL as the only backstop**. It's
modeled on the design Mirror describes (see [docs/MIRROR-NOTES.md](docs/MIRROR-NOTES.md)). It supports any
number of isolated markets (unbounded perps like memecoins and equities, binary outcomes, custom bounds),
nano-USD integer arithmetic, deterministic replay, and a CLI.

The question it answers: **when a price gaps, what happens to leveraged positions, and who pays?**

**Start with the brief: [docs/BRIEF.md](docs/BRIEF.md)** (findings, design recommendations, open questions).

**New: a live paper-trading exchange built on the engine ([docs/MVP.md](docs/MVP.md)).** It has order books, Hyperliquid and
Polymarket oracles, attention curves, house bots, and a trading UI where you can watch gaps, liquidations and ADL happen.

```bash
pnpm install && pnpm start         # http://localhost:8787 (admin token: impulse-admin)
```

| Doc | What's in it |
|---|---|
| [BRIEF.md](docs/BRIEF.md) | Findings for Cesar |
| [POSITIONING.md](docs/POSITIONING.md) | For Cesar: MicroPerps vs pump.fun and other perp DEXs, and where a moat could be |
| [MVP.md](docs/MVP.md) | The paper-trading exchange: how to run it, architecture, API, demo script |
| [JOURNAL.md](docs/JOURNAL.md) | Progress log, newest last, and current state |
| [DECISIONS.md](docs/DECISIONS.md) | Every scope and design decision, and why |
| [INTERMEDIATES.md](docs/INTERMEDIATES.md) | Next projects: research that also sets product parameters |
| [ACCOUNTING.md](docs/ACCOUNTING.md) | The engine's model, proofs and invariants |
| [MIRROR-NOTES.md](docs/MIRROR-NOTES.md) | What we know for sure about Mirror (fact / claim / unknown), and what its docs say and don't say |
| [FACT-CHECK.md](docs/FACT-CHECK.md), [RESEARCH-NOTES.md](docs/RESEARCH-NOTES.md) | Source check and notes on the outside research memo |
| [research/](docs/research/) | Data sources, tools landscape, literature survey (2026-10-09); how Mirror is built (2026-10-23) |
| [sources/mirror/](docs/sources/mirror/) | Archived text of Mirror's invite-gated docs |

```bash
pnpm install
pnpm demo                          # ten scenarios, full ledger after every event
pnpm attack                        # pump-attack sweep on a curve-priced perp (<1s)
pnpm compare                       # every scenario under both ADL rules, side by side
pnpm replay scenarios/x.json       # any scenario; add --json for machine-readable output
pnpm test                          # 74 tests: engine (incl. a 300-history multi-market seeded fuzz), exchange, API
pnpm start                         # the MVP exchange: web app + API on :8787
pnpm dev                           # MVP in development: API :8787 + Vite :5173
```

## Mechanism (one paragraph)

Markets are isolated shards: each has its own config, positions and collateral vault, and accounts move
money from a wallet into per-market buckets. Each position holds collateral, a signed size, and a cost basis,
and is marked to its market's oracle price. Every event (market, deposit, allocate, trade, tick, resolve,
release, withdraw) runs as an atomic transition on a copy of the state, and per-market plus global invariants
are checked before it commits. Trades can't create insolvency, because
both parties must clear initial margin *at mark*. Ticks can. After each tick, every account below maintenance
margin is closed at mark against the opposing side, pro-rata by size. An account with equity ≥ 0 keeps what
it has left (**liquidation**). An account with equity < 0 has its shortfall charged to the opposing accounts,
again pro-rata by size (**ADL**). There's no insurance fund. Within a single tick this rule provably never
pushes an absorber below zero. Resolvable markets settle with a final tick (0 or 1 for binaries).
The full model, the proofs, and the choices behind them are in [docs/ACCOUNTING.md](docs/ACCOUNTING.md).

## The demo: who bore the loss

A–C are binary outcome markets, D is an unbounded memecoin perp, E runs two markets side by side, and F is a
Mirror-style attention market whose perp is priced off its own bonding curve.
A–D end with every account withdrawing in full and the vault reaching **exactly $0.00**:
no stranded dollars and no unpaid claims. "Theoretical" means holding every voluntary trade to resolution with
no ADL.

### A. Gap 0.60 → 0.05, then resolves NO (`scenarios/gap-down-resolve-0.json`)

| account | position at gap | theoretical PnL | actual PnL | ADL ± |
|---|---|---:|---:|---:|
| alice | +600 long, ~2.5× | −308.00 | −100.00 (deposit) | +178.00 covered |
| bob | +500 long, ~2.5× | −252.00 | −120.00 (deposit net of a $30 withdrawal) | +107.00 covered |
| frank | +200 long, ~1× | −110.00 | −110.00 | — (survives) |
| carol | −700 short | +360.00 | +176.94 | −153.46 |
| dave | −400 short | +200.00 | +95.36 | −87.69 |
| erin | −200 short | +110.00 | +57.70 | −43.85 |

On the gap, alice and bob are $285 short. The shorts were right, and they got 49% of their theoretical
profit. The missing $340 is the **$285 haircut plus $55 of exposure lost to the forced close**: 1,100 short contracts
were closed at 0.05, and each would have earned another 0.05 at resolution. ADL costs winners both a haircut and a size reduction.

### B. Same gap, then a 3× short at 0.06 resolves YES (`gap-down-resolve-1.json`)

gina shorts 300 @ 0.06 with $6.50 (3× on notional $18). Resolution to 1 costs her $282, so she's $275.50 short.
hank bought those 300 contracts and was owed **$282**. He received **$116.70**. frank had held his long since
0.55 and was *right* on resolution (theoretical +90), yet he finishes at **−20.20**. Pro-rata by size charged
him $110.20, more than his entire profit since entry.

### C. Gap up 0.45 → 0.95, back to 0.70, resolves NO (`gap-up-resolve-0.json`)

nia and omar go bankrupt, pia is liquidated with $2.50 left, and quinn (near fully collateralized) survives.
Then the market resolves **0**. The shorts were right about the outcome, and three of them lost everything
they posted. The longs were wrong, and both ended **in profit** (+41.69 and +75.81), because the 0.95 print
force-closed them at a high price. **One transient oracle print fixed everyone's PnL for good.**

### D. Memecoin squeeze, PEPE 0.00001 → 0.00004 (`memecoin-squeeze.json`)

A 30% pump liquidates the two 3× shorts, who keep $20 and $10. The 4× gap then bankrupts dan, who was at
**0.5× leverage** ($200 of collateral against $100 notional). On an unbounded asset a short has no maximum
loss, so no collateral ratio is safe. The longs absorb his $100 shortfall ($75 and $25) and are force-closed.

### E. Isolation (`isolation-two-markets.json`)

alice holds BTCX and ELECTION positions with separate collateral. ELECTION gaps 0.50 → 0.02 and bankrupts her
there. Her BTCX position, its collateral and her counterparty are **byte-for-byte unchanged** (asserted in the
tests). This is the property Mirror's sharding claim rests on.

### F. Pump attack on a curve-priced perp (`attention-pump.json`, `pnpm attack`)

Mirror's attention markets give every token an xy=k spot curve, and the perp "uses that spot price for its oracle
price calculation". Our curve reproduces Mirror's published price table exactly. On a pure xy=k curve, buying and
then selling straight back returns your USDC minus fees, so pushing the oracle costs almost nothing.

In the scenario, mallory is long against two ~2.85× shorts, spends $5,000 on spot, and both shorts go bankrupt
**inside that same transaction**. mallory sells straight back, deposits $7,000 and withdraws $8,900.50: the
shorts' entire $2,000, minus $99.50 in fees.

The sweep (3 shorts × $1,000, start price about $0.000125) varies the oracle, the fee, and how much of the pump
arbitrageurs sell back ("retrace") while the attacker waits:

| Oracle | Retrace | Pump | Shorts lost | Attacker PnL |
|---|---:|---:|---:|---:|
| instant spot | — | $5,000 | **$3,000 (all)** | **+$2,900** |
| TWAP 10m or 60m | 0% | $5,000 | $1,502 | +$1,402 |
| TWAP 10m | 50% | $5,000 | $1,502 | +$710 |
| TWAP 10m | 50% | $20,000 | $1,910 | −$4,070 |
| TWAP 10m | 90% | any | $0–$1,528 | −$283 to −$9,528 |

(1% fee shown; 0.3% is similar.)

* **An instant oracle is free money:** a pump of under 2× the victims' collateral takes all of it, for fees.
* **TWAP alone only delays the attack.** The attacker holds through the window, and 10m vs 60m makes no
  difference. Smoothing does turn the gap into a ramp, so shorts are liquidated rather than bankrupted and keep
  about half.
* **What stops it is arbitrage liquidity, not oracle math.** At a 90% retrace every attack loses money. But a new
  attention token, the case MicroPerps exist for, is exactly where nobody is there to sell into the pump.
* Big pumps still liquidate the shorts even when they lose money. That's griefing, and the attacker's loss goes
  to the arbitrageurs.

### G. Which ADL rule is fair? (`principal-fallback.json`, `pnpm compare`)

Each market picks its ADL rule. Forced closes are always size pro-rata, since that keeps exposure balanced; the
rule decides who pays the shortfall:

* **`size`**: pro-rata by position size. Simple, and provably never pushes anyone negative within a tick, but it
  ignores whether the absorber actually made money.
* **`pnl`**: capped pro-rata on **positive PnL**, so principal is protected (Chitra, arXiv:2512.01112, shows
  this is the unique fair rule). If total profit can't cover the shortfall, the rest comes out of principal
  pro-rata by remaining equity, and every such hit is reported.

| Scenario | Account | `size` rule | `pnl` rule |
|---|---|---:|---:|
| B | frank (right, barely profitable) | **−$20.20** ($20.20 principal hit) | **+$23.35** (no principal hit) |
| B | hank (big winner) | +$116.70 | +$73.15 |
| G | s1 (short since 0.05, underwater until the gap) | −$343.33 ($333.33 principal) | −$188.31 ($178.31 principal) |
| G | s2 (shorted the top) | +$103.33 | −$51.69 ($51.69 principal) |

Scenario G is the trilemma in practice: a $500 shortfall against only $270 of total profit. **Some principal
pays under any rule.** The PnL rule only decides whose, and how much less ($230 vs $333).

### H. Leverage graduation is permanent, depth isn't (`graduation-blowup.json`)

Mirror raises leverage from 3× toward 100× as "volume and depth" grow, and doesn't publish the criteria. Ours
use five tiers (5×, 10×, 20×, 50×, 100×), each unlocked by cumulative volume plus a depth proxy (open interest,
plus curve liquidity), and tiers only go up. Two whales trade $1.5M with $500k of open interest, so HYPE
graduates to 10×, and then they leave. carl opens 9× long against dina, and a **20% gap bankrupts him** ($800
shortfall). dina was owed $1,800 and gets $1,000. At the 3× launch limit he couldn't have opened that position.
**Volume says nothing about the next gap**, and leverage that only ratchets up outlives the liquidity that
justified it.

### I. Pre-resolution taper (`resolution-taper.json`)

Resolvable markets can schedule a resolution time and a taper window. Over the window, margin requirements ramp
up to **full collateral against max loss**. That's measured against max loss rather than notional, which is
what catches scenario B's short-side trap: a 3× short at 0.06 posts $6 but can lose $282.

| Market | What happens | Result |
|---|---|---|
| NOTOPUP | gina can't keep up and is liquidated at mark about 2 hours into the taper | No ADL. hank is force-closed at 0.06 and **never collects** his YES payout |
| TOPUP | gus tops up to $306.50 of collateral | hal is **paid in full** at resolution: $282, no haircut |

A taper removes resolution ADL, but it **turns haircuts into lost exposure** unless the losing side fully
collateralizes. Leverage on a binary can't survive until resolution, and a taper just makes that explicit and orderly.

### J. Funding at launch (`funding-drain.json`)

Hourly funding is `base rate + clamp(premium / 8, ±4%/h)`, with premium = (last trade − oracle) / oracle. The base
rate is paid by longs to shorts: 0.05%/h at launch (Mirror's "maximum base rate", our number), falling with each
graduation tier to 0.00125%/h. The rate is fixed at the last event, so inactive markets keep paying it, per
Mirror. alice buys at 1.02 against an oracle of 1.00: 0.30%/h, $72 a day. With nobody trading, funding alone
liquidates her on day 3. Funding transfers are exact and run inside the same risk round, so a payer can be
liquidated or ADL'd by funding.

**A side effect worth knowing:** with no order book, "last trade" stands in for the perp price. If the oracle moves
and nobody trades, the stale last trade creates a premium in the *opposite* direction. In the pump attack, that
makes the shorts pay funding to the attacker while the pump lasts. A real illiquid book is just as stale, so
it's a plausible second extraction channel.

## What this shows

1. **"Solvent after every transition" holds, and it's cheap.** It's just bookkeeping: every account has
   equity ≥ 0 and Σ equity = vault at all times. The fuzz test checks this over 300 random histories,
   including gaps to 0 and 1.
2. **Solvency is not payment.** When the losing side's posted collateral is gone, the winning side's claim
   shrinks to fit it. The opposing traders become the insurance fund, and they never priced that in.
3. **Resolution is a guaranteed gap.** A position with less than full collateral on the losing side of a
   binary resolution *always* goes bankrupt (our margin cap makes this exact). So on every market, the
   winners' payout at resolution is capped by the losers' collateral. Leverage scaling with volume
   (Mirror's 3×→100×) doesn't change this.
4. **The mark is the attack surface.** In C, a wick that later reverted destroyed the side that was right
   and enriched the side that was wrong. With a thin venue as the oracle, that's an attack you can pay for.
5. **On unbounded assets, shorts have no safe collateral level** (scenario D). Any ADL-only venue listing
   memecoins with leverage will socialize squeezes onto the longs.
6. **A perp priced off its own curve can be pumped for fees** (scenario F). Smoothing helps only when someone
   sells into the pump, and young markets have nobody.
7. **No ADL rule protects everyone.** The PnL rule is fairer and protects principal whenever profits cover the
   shortfall. When they don't (scenario G), principal pays regardless.
8. **Graduated leverage outlives the liquidity behind it** (H). Volume-based tiers don't shrink the next gap.
9. **A taper fixes resolution ADL by forcing the losing side to fully collateralize or leave early** (I). The
   winners then either get paid in full or lose their exposure. There's no free leverage into resolution.
10. **Launch funding is steep and keeps charging inactive markets** (J). A stale price feeds a reverse premium.
11. **"3× leverage" is ambiguous on a [0,1] asset.** It's measured against notional `|q|·p`, but a short's
   worst case is `|q|·(1−p)`. gina's "3×" was 43× her max loss. Any real design needs per-side margin.

## Limitations (deliberate, v1)

- **Funding, graduation and taper parameters are ours.** Mirror publishes none. They're constants at the top of
  `src/engine.ts` (`GRADUATION`, `FUNDING_BASE_PPB`, `FUNDING_PREMIUM_CAP_PPB`). With no order book, depth is
  proxied by open interest plus curve liquidity, and the perp price for funding is the last trade.
- **No order book.** Trades are bilateral fills fed from the scenario. Liquidation closes against the opposing
  side at mark, where a real venue would sell into a book.
- **Full liquidation, no penalty, no partial closes.**
- **Two ADL rules** (size, capped PnL). Queue/ranking rules (Binance and Hyperliquid style) aren't modeled.
  Chitra shows they overshoot, so they'd only lose this comparison.
- **Oracles:** an external feed, or the market's own xy=k curve (instant or TWAP). There are no sanity bands or
  staleness rules. Mirror layers its curve on an order book; we model only the curve, so resting book liquidity,
  which would act like our "retrace" arbitrageurs, isn't simulated. The spot fee (default 1%) is our assumption,
  since Mirror's isn't published.
- **Withdrawals: realized cash only, above initial margin.** This is conservative by choice; see ACCOUNTING.md.
- Not covered: perp trading fees, partial liquidation, cross margin, tokens, contracts. (The order book, live
  oracles and frontend now exist in the MVP: [docs/MVP.md](docs/MVP.md).)

## Open questions (solvency doesn't answer these)

- Is the perp price fair if winners expect haircuts? What funding rule restores it?
- How do you make oracle manipulation unprofitable when the oracle is a thin prediction-market book?
- Should leverage compress, or positions flatten, before resolution? (The Axient-style hard-flat in the memo.)
- Which ADL rule is least unfair? Size, PnL, and profit×leverage ranking all trade off differently.

## Layout

```
src/engine.ts     markets, wallets, events, margin, liquidation/ADL loop, invariants, replay
src/alloc.ts      largest-remainder apportionment (exact integer pro-rata)
src/fixed.ts      nano-USD fixed-point helpers
src/attack.ts     pump-attack harness and parameter sweep
src/compare.ts    replays scenarios under each ADL rule
src/report.ts     ledger rendering, state hash
src/cli.ts        scenario runner
scenarios/        A–J above (JSON event lists)
server/           MVP exchange: order books, feeds, bots, HTTP + websocket API (wraps src/engine.ts)
web/              MVP trading UI (React + Vite + lightweight-charts)
docs/             see the docs index above
```
