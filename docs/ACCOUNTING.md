# Impulse accounting model

This is **our** design. It's a guess at how a Mirror-style MicroPerp could work on one
prediction-market outcome. It is not a reproduction of Mirror's engine: Mirror publishes
no algorithm, only claims (see [MIRROR-NOTES.md](./MIRROR-NOTES.md)).

## Units (all integer, `bigint`)

| Quantity | Unit | Example |
|---|---|---|
| money (cash, equity, PnL, margin) | micro-USD (1e-6 USD, same as USDC) | `$12.50` = `12_500_000n` |
| price `m`, trade price `X` | micro-USD per contract, in `[0, 1_000_000]` | `0.60` = `600_000n` |
| size `q` | whole contracts, signed (+long / −short) | `-200n` |

One contract pays `$1 × price`. So a size multiplied by a price is already exact
micro-USD: there's no floating point and no hidden rounding in PnL.

## State

One market (isolated margin), one vault, many accounts.

```
Account i:  cash C_i   size q_i   costBasis B_i      (B_i = Σ signed fill size × fill price)
Market:     mark m     status open | resolved
Vault:      V = Σ deposits − Σ withdrawals            (the tokens the venue actually holds)
```

Derived quantities:

```
uPnL_i   = q_i·m − B_i
equity_i = E_i = C_i + q_i·m − B_i
entry_i  = B_i / q_i                                   (display only)
```

We track cost basis instead of average entry price. Averaging entry prices introduces
rounding that leaks value between accounts, and cost basis doesn't.

## How matched positions are created and closed

Every fill is bilateral. A buyer and a seller trade `s` contracts at price `X`:

```
buyer:  q += s, B += s·X         seller: q −= s, B −= s·X
```

When a fill reduces an existing position by `r`, we realize PnL proportionally:
`basisRemoved = B·r/|q|` (truncated), `B −= basisRemoved`, and `C += ±r·X − basisRemoved`.
Truncation only moves value between the realized and unrealized columns of the **same**
account. Total equity is identical to the un-split formula, so conservation stays exact.

Since every fill adds `+s` to one account and `−s` to another, **Σq_i = 0 always**:
open longs equal open shorts. Forced closes (liquidation, ADL, settlement) are also
bilateral fills, so they preserve this too.

## Which price does what

| Purpose | Price |
|---|---|
| PnL, equity, margin checks | **oracle mark `m`** (the prediction venue's price, delivered as `tick` events) |
| Voluntary trade | trade price `X` (any value in [0,1]); the post-trade margin check still uses `m` |
| Liquidation (E ≥ 0) | closed at `m`, so counterparties keep their full PnL |
| ADL (E < 0) | closed at `m`, then the shortfall is transferred from counterparties (economically the same as closing at the bankruptcy price) |
| Resolution | everything settles at exactly 0 or 1 |

A trade can't happen before the first tick, because there's no mark yet.

## Margin

`maxLoss` is the most a position can lose before the price hits a bound: `q·m` for a long
(price → 0) and `|q|·(1−m)` for a short (price → 1).

```
IM_i = min(maxLoss_i, ceil(|q_i|·m / initialLeverage))        default initialLeverage = 3
MM_i = min(maxLoss_i, ceil(|q_i|·m / maintenanceLeverage))    default maintenanceLeverage = 6
```

Leverage is quoted against notional `|q|·m`, as on ordinary perps. The `maxLoss` cap means
a fully collateralized position can never be liquidated or ADL'd. Requirements round
**up**, which is against the trader.

Trade acceptance: after the fill, each party must have `E ≥ IM`. A party whose fill only
reduces its position must have `E ≥ MM`. So **trades can never create insolvency**. Only
oracle ticks can.

## Tick processing (one atomic transition)

```
1. m ← new price
2. loop:
     distressed = accounts with q≠0 and E < MM
     if none: break
     all distressed must be on one side (proved below; asserted)
     Qtot  = Σ |q_i| over distressed                    (contracts to close)
     Dtot  = Σ max(0, −E_i) over distressed             (total shortfall)
     opp   = accounts on the other side, weights |q_j|
     r_j   = allocate(Qtot, |q_j|)                      (largest-remainder, ties by id)
     h_j   = allocate(Dtot, |q_j|)
     close every distressed account fully at m vs. the opposing side (r_j each)
     transfer h_j from each absorber j to the bankrupt pool; each bankrupt i gets −E_i
3. assert invariants
```

Every transition runs on a clone, so a failed assertion leaves the committed state unchanged.

### Liquidation vs ADL

* **Liquidation** applies when `0 ≤ E < MM`. The account is closed at mark and keeps its
  remaining equity. Counterparties are force-reduced at mark and lose nothing. In a real
  venue the position would go to the order book. This PoC has no book, so the opposing
  side takes it at mark. That's a forced position reduction with zero value cost.
* **ADL** applies when `E < 0`. Same close, plus the shortfall `−E` moves from opposing
  accounts to the bankrupt account, bringing it to exactly 0. Counterparties take **both** a
  size reduction **and** a payout haircut.

Why we need both: the bankrupt account's collateral is gone, so its position must close.
To keep Σq = 0 the opposing exposure must shrink by the same amount, which is the size
reduction. Its unpaid loss must come from somewhere, and with no insurance fund the only
source is the accounts that were owed it, which is the haircut.

### Who absorbs, and by what rule: pro-rata by size

Each opposing account absorbs `Dtot·|q_j|/S_opp` (S_opp = total opposing size) and is force-closed
`Qtot·|q_j|/S_opp` contracts.

**Claim: within one tick, size pro-rata never pushes an absorber below zero.**
Take a downward tick of Δ = m_old − m_new. Before the tick every account had `E ≥ MM ≥ 0`.
Every short gains exactly `|q_j|·Δ`, so `E_j,after ≥ |q_j|·Δ`. A long's shortfall is at most its loss `q_i·Δ`, so
`Dtot ≤ Δ·Σ_distressed q_i ≤ Δ·S_opp`. So `h_j ≤ Dtot·|q_j|/S_opp ≤ |q_j|·Δ ≤ E_j`.
Integer rounding can add at most 1 micro-unit, and `E_j` is an integer that's ≥ the exact
fraction, so `E_j ≥ ceil(fraction)`. The upward case is symmetric. Later rounds of the
loop have `Dtot = 0`: haircuts leave absorbers at ≥ 0, and closes at mark don't change
equity. We still assert this in code, and a seeded fuzz test checks it.

The claim depends on the pre-tick state being solvent. Atomic per-tick processing is what
gives us that, and it's the core of Mirror's argument too.

**Tradeoffs of size pro-rata.** Its strengths: it's simple, easy to audit, provably
non-negative, and it doesn't depend on hidden rankings. Its weakness is that it ignores
entry price and leverage. A short who entered at 0.06 (small profit) loses the same per
contract as one who entered at 0.60 (huge profit). The common alternative is
profit×leverage ranking (Binance/Hyperliquid-style). It targets the biggest winners but
needs a waterfall and is harder to reason about.

## Resolution at 0 or 1

`resolve` is a tick to exactly 0 or 1 (with full liquidation/ADL), followed by settling
every position at that price against the others (value-neutral because Σq=0). After that,
q = B = 0 for every account, `E_i = C_i ≥ 0`, Σ C_i = V, and the market only accepts
deposits and withdrawals. At m = 0 the long `maxLoss` is 0, and at m = 1 the short `maxLoss`
is 0. Margin requirements disappear at the bounds, and so does any further risk.

## Withdrawals

```
withdrawable_i = max(0, min(C_i, E_i − IM_i))
```

You can withdraw **realized cash only**, and only if what stays covers initial margin.
Unrealized profit becomes withdrawable once you close the position. Withdrawing
unrealized profit at mark would arguably still be funded, since V = ΣE. We chose to be
conservative so that every withdrawn dollar is backed by a closed, bilateral settlement.

## Invariants (asserted after every transition)

A violation means an engine bug, not bad input. `apply` throws, and the caller's state is untouched because every
transition runs on a clone. Bad input (e.g. an over-withdrawal) is a normal *rejection* with a reason.

1. **Balanced exposure:** Σ q_i = 0.
2. **Collateral conservation:** V = Σdeposits − Σwithdrawals = Σ (C_i − B_i). With
   Σq=0 this equals Σ E_i at **any** mark.
3. **Non-negative equity:** E_i ≥ 0 for all i.
4. **Maintained margin:** E_i ≥ MM_i for every account with a position.
5. **No unfunded claims:** withdrawable_i ≤ E_i, and Σ withdrawable ≤ V.
6. **Per-account ledger:** C_i = deposited − withdrawn + realized + adlTransfer.
7. **Resolved market:** every q_i = 0 and B_i = 0.

### Why clamping negative balances to zero is not solvency

If a bankrupt account's equity −D is simply clamped to 0, then Σ E_i = V + D. Every winning
account still shows its full PnL, so the claims exceed the vault by D. The first winner
to withdraw gets paid, and the last one finds the vault short. `test/engine.test.ts` shows
this numerically. Solvency means **re-allocating** D to specific accounts, not hiding it.

## Deliberately omitted (v1)

Funding (Mirror describes a funding rate; we have none, so positions cost nothing to hold),
fees, partial liquidation, liquidation penalties, order book/matching, cross margin,
leverage graduation (3×→100× is just a config number here), and oracle sanity checks.
