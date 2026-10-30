# Impulse: what MicroPerps do when prices gap, and who pays

*Brief for Cesar · October 2026 · repo: `SidharthK2/impulse` (private)*

> **Note (2026-10-26):** this brief is as sent on 2026-10-06. Since then: a live paper-trading MVP exists
> ([MVP.md](../../docs/MVP.md)), so "simulation only" and "53 tests" are out of date (74 tests now); profile owners get 50% of
> attention-token fees; Mirror isn't live and its shipped app has no perp code yet. Current facts:
> [MIRROR-NOTES.md](./MIRROR-NOTES.md). The findings and numbers below still stand.

## TL;DR

- **Mirror's core claim holds, but it's the easy part.** "No bad debt, ever" through ADL on every transaction is
  pure bookkeeping, and our engine guarantees it too, checked after every event across 300 random histories.
  Solvency was never the hard problem. **Distribution is**: when a position goes negative, the winners on the other
  side pay, through forced closes and haircuts.
- **On gaps, winners get paid partially.** In our prediction-market gap the shorts got 49% of their theoretical
  profit. At resolution a binary *always* gaps, so winners are capped at what the losers posted (owed $282, paid $116.70).
- **Mirror's launch product is exploitable as described.** Attention-market perps are priced off the token's own
  bonding curve. A ~$5k spot pump took **100% of the shorts' $3,000** for about $100 in fees. Smoothing the oracle
  doesn't fix it; only arbitrage liquidity selling into the pump does, and new tokens don't have any.
- **Some design choices clearly beat others:** capped pro-rata ADL on positive PnL over size pro-rata, a
  pre-resolution taper for anything that resolves, and leverage tied to depth that can also fall, not ratcheting
  up on volume.
- **There's no free lunch.** When profits can't cover a shortfall, someone's principal pays under any rule. A taper
  removes resolution ADL only by forcing the losing side to fully collateralize or leave early.

## What MicroPerps are (Mirror's claims)

Sources are Mirror's invite-gated docs, which I read directly on 3 and 5 October 2026. Mirror isn't live; the
token pre-sale is open. Everything below is *their* claim, not verified behaviour.

| Claim | Detail |
|---|---|
| ADL is the only backstop | No insurance fund and no house vault, so they can list anything permissionlessly |
| Solvent after every transition | Solvency checks on every trade and price tick; ADL runs inside the same transaction |
| One core | Matching and risk in one single-threaded Rust engine; ">300k tx/s per thread" |
| Isolated margin | Markets shard across threads; cross margin is "a flag flip" later |
| Leverage 3× → 100× | Rises with "volume and depth"; criteria not published |
| Funding | Starts at a "maximum base rate"; inactive markets keep paying the last rate |
| Attention markets (launch) | Every social profile gets a token on an xy=k curve plus a perp whose oracle is that spot price |
| Prediction markets | A mirrored perp on every Polymarket and Kalshi market |

**Not published:** the ADL rule, the liquidation mechanics, how the mark price works for young markets, the
funding formula, the graduation criteria, how resolution is handled, oracle smoothing, fees, and custody.

## What we built

A deterministic reference engine in TypeScript (integer nano-USD, no floats) that replays event scripts and
shows every account's ledger after every event:

- **Any asset:** unbounded perps (memecoins, equities), 0–1 binaries, and custom bounds. Any number of isolated
  markets.
- **Atomic risk:** liquidation at mark when below maintenance margin, ADL with no insurance fund when negative.
  Two ADL rules are selectable per market.
- **Mirror's attention curve:** xy=k with Mirror's published reserves (it reproduces their price table exactly),
  and a perp oracle that's either instant or a TWAP.
- **Graduation, funding and taper,** with our own parameters (Mirror publishes none).
- **Verification:** 53 tests. A seeded fuzz runs 300 multi-market histories through every mechanic. Every invariant
  is checked after every event: exposure balanced, money conserved, no negative equity, no unfunded withdrawals.

It's a simulation. No services, no order book, no contracts, no real money.

## Findings

Each finding has a replayable scenario (`pnpm demo`, `pnpm attack`, `pnpm compare`).

### 1. Solvency is cheap; the question is who pays (A, B, C)

| Scenario | Event | Who bore it |
|---|---|---|
| A | Binary gaps 0.60 → 0.05; two 2.5× longs end $285 negative | Shorts got **49%** of theoretical profit: $285 in haircuts plus $55 lost to forced early closes |
| B | A 3× short at 0.06 resolves YES | The long was owed **$282** and got **$116.70** |
| C | A wick to 0.95, then the market resolves NO | Shorts who were *right* lost everything; longs who were *wrong* profited (+$42, +$76) |

ADL costs winners twice: a haircut, and a forced reduction that takes away their remaining upside. And with ADL
at mark, **one transient oracle print permanently decides PnL** (C).

### 2. No collateral level is safe for shorts on unbounded assets (D)

A 4× memecoin pump bankrupted a short at **0.5× leverage** ($200 of collateral against $100 notional). Any
ADL-only venue listing memecoin perps will socialize squeezes onto the longs.

### 3. Isolation holds (E)

A blow-up in one market leaves every other market byte-for-byte unchanged (asserted in tests). Mirror's sharding
argument is sound.

### 4. Curve-priced perps can be pumped for fees (F, `pnpm attack`)

Three shorts with $1,000 each at ~2.85×; the attacker is long and pumps spot:

| Oracle | Arbitrage retrace | Pump | Shorts lost | Attacker PnL |
|---|---:|---:|---:|---:|
| Instant spot | — | $5,000 | **$3,000 (all)** | **+$2,900** |
| TWAP 10m / 60m | 0% | $5,000 | ~$1,500 | +$1,406 |
| TWAP 10m | 50% | $5,000 | ~$1,500 | +$720 |
| TWAP 10m | 90% | any | $3–$1,539 | −$280 to −$9,518 |

On xy=k a buy-then-sell round trip returns your USDC minus fees, so pushing the oracle costs almost nothing. A
TWAP only makes the attacker wait. What stops the attack is someone selling into the pump. Big pumps still
liquidate the shorts even when unprofitable, which is griefing. A second channel: with a stale price during a pump,
funding flows from the shorts to the attacker.

### 5. Capped-PnL ADL is fairer, but no rule protects everyone (B, G, `pnpm compare`)

| Scenario | Account | Size pro-rata | Capped pro-rata on PnL |
|---|---|---:|---:|
| B | frank (right, barely profitable) | **−$20.20** ($20.20 principal hit) | **+$23.35** (principal protected) |
| B | hank (big winner) | +$116.70 | +$73.15 |
| G | s1 (underwater since entry) | −$343.33 ($333 principal) | −$188.31 ($178 principal) |
| G | s2 (shorted the top) | +$103.33 | −$51.69 ($52 principal) |

Capped pro-rata on positive PnL (Chitra, arXiv:2512.01112, proved it's the unique fair rule) protects principal
whenever profits cover the shortfall. In G, the shortfall ($500) exceeds total profit ($270), so principal pays
under any rule. The rule only decides whose, and how much ($230 vs $333). That's Chitra's trilemma, in numbers.

### 6. Graduated leverage outlives the liquidity behind it (H)

Whales trade $1.5M, the market graduates to 10×, and the whales leave. Leverage stays at 10×. A 20% gap then
bankrupts a 9× long ($800 shortfall), and the short collects $1,000 of the $1,800 owed. At 3× the long couldn't have
opened. **Volume says nothing about the next gap.**

### 7. A taper fixes resolution ADL, at a price (I)

Requirements ramp up to full collateral against **max loss** (not notional, which is what catches the
short-at-0.06 trap) before resolution.

- Short can't keep up: liquidated at mark about 2 hours into the taper. No ADL, but the long is force-closed and
  never collects.
- Short tops up: the long is paid **in full** ($282).

Leverage on a binary can't survive until resolution. A taper makes that orderly instead of a socialized loss.
Kalshi's September 2026 CFTC filing proposes the same shape: collateral rising into settlement.

### 8. Launch funding is steep and keeps charging idle markets (J)

At our launch base rate (0.05%/h) plus a small premium, an idle long paid $72 a day and was liquidated on day 3
without anyone trading. Mirror's "inactive markets keep paying the last rate" means positions in dead markets
bleed indefinitely.

### 9. "3× leverage" is ambiguous on bounded assets

Leverage quoted on notional `size × price` understates a short's risk at low prices: a "3×" short at 0.06 is
**43×** its max loss. Any real design needs per-side margin based on max loss.

## If we built this, the design would look like

| Area | Recommendation | Evidence |
|---|---|---|
| ADL rule | Capped pro-rata on positive PnL, principal fallback disclosed up front | 5 |
| Oracles | Never an instant own-curve price; require external liquidity or a market maker before leverage is enabled | 4 |
| Resolving markets | Mandatory taper to full max-loss collateral | 1, 7 |
| Leverage | Tied to measured book depth, able to go down as well as up; per-side margin on max loss | 6, 9 |
| Unbounded shorts | Low caps, or explicit disclosure that squeezes are socialized | 2 |
| Funding | Cap idle-market accrual; base the premium on a live book, not a stale last trade | 8, 4 |

## Open questions for Mirror

1. What's the ADL rule, and is principal protected?
2. Is the perp oracle instant spot or smoothed, and over what window?
3. What happens to a Polymarket perp at resolution? Is there a halt, a taper, or a flatten?
4. What are the maintenance margin and liquidation mechanics, and does liquidation go to the book first?
5. What are the graduation criteria, and can leverage go back down?
6. Who backstops a third-party oracle deployer trading against its own oracle?

## Limitations

- **Simulation only:** no order book, no fees on perp trades, full liquidations only, no cross margin. Liquidations
  close against the opposing side at mark, where a real venue would go to the book.
- **Parameters are ours:** graduation thresholds, funding rates and taper shape (constants in `src/engine.ts`). The
  depth proxy is open interest plus curve liquidity, and the funding price is the last trade.
- **Scenarios are synthetic.** The natural next step is replaying real Polymarket and DEX price histories.
- Solvency doesn't establish fair pricing or resistance to manipulation. Findings 1, 4 and 8 are about exactly that.

## Supporting docs

- [ACCOUNTING.md](../../docs/ACCOUNTING.md): the model, the proofs, every invariant
- [MIRROR-NOTES.md](./MIRROR-NOTES.md): what Mirror's docs say and don't say
- [FACT-CHECK.md](./FACT-CHECK.md): source check of the research memo (Ventuals has shut down, 3× not 5×, the
  superseded Chitra figure)
- [RESEARCH-NOTES.md](./RESEARCH-NOTES.md): notes on the memo and the literature
