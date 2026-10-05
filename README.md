# Impulse

A small reference engine for **leveraged prediction-market perps with ADL as the only backstop**. It's modeled
on the design Mirror describes for MicroPerps (see [docs/MIRROR-NOTES.md](docs/MIRROR-NOTES.md)). It covers
one isolated outcome, integer arithmetic, deterministic replay, and a CLI.

The question it answers: **when a prediction price gaps, what happens to leveraged positions, and who pays?**

```bash
pnpm install
pnpm demo                          # three scenarios, full ledger after every event
pnpm replay scenarios/x.json       # any scenario; add --json for machine-readable output
pnpm test                          # 23 tests incl. a 300-history seeded fuzz
```

## Mechanism (one paragraph)

Each account holds cash, a signed size, and a cost basis. Equity is marked to the oracle price (the prediction
venue's price). Every event (deposit, withdraw, trade, tick, resolve) runs as an atomic transition on a
copy of the state, and seven invariants are checked before it commits. Trades can't create insolvency, because
both parties must clear initial margin *at mark*. Ticks can. After each tick, every account below maintenance
margin is closed at mark against the opposing side, pro-rata by size. An account with equity ≥ 0 keeps what
it has left (**liquidation**). An account with equity < 0 has its shortfall charged to the opposing accounts,
again pro-rata by size (**ADL**). There's no insurance fund. Within a single tick this rule provably never
pushes an absorber below zero. Resolution is a final tick to 0 or 1, followed by settling everything.
The full model, the proofs, and the choices behind them are in [docs/ACCOUNTING.md](docs/ACCOUNTING.md).

## The demo: who bore the loss

All three scenarios end with every account withdrawing in full and the vault reaching **exactly $0.00**:
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
5. **"3× leverage" is ambiguous on a [0,1] asset.** It's measured against notional `|q|·p`, but a short's
   worst case is `|q|·(1−p)`. gina's "3×" was 43× her max loss. Any real design needs per-side margin.

## Limitations (deliberate, v1)

- **No funding.** Mirror describes one; here positions cost nothing to hold. Because winners know ADL caps their
  upside, the perp *should* trade away from the oracle, and only funding could tie it back.
- **No order book.** Trades are bilateral fills fed from the scenario. Liquidation closes against the opposing
  side at mark, where a real venue would sell into a book.
- **Full liquidation, no penalty, no partial closes.**
- **Size-pro-rata ADL only.** It's simple and provably non-negative per tick, but scenario B shows it charging
  accounts that are barely in profit. The obvious next policy to compare is pro-rata on positive PnL with an
  equity-capped waterfall, as Mac's memo recommends.
- **Oracle-only mark, no sanity bands or staleness rules.** No trading before the first tick (Mirror claims it
  can run with no price feed; we don't attempt that).
- **Withdrawals: realized cash only, above initial margin.** This is conservative by choice; see ACCOUNTING.md.
- Not covered: fees, cross margin, leverage graduation, tokens, contracts, frontend.

## Open questions (solvency doesn't answer these)

- Is the perp price fair if winners expect haircuts? What funding rule restores it?
- How do you make oracle manipulation unprofitable when the oracle is a thin prediction-market book?
- Should leverage compress, or positions flatten, before resolution? (The Axient-style hard-flat in the memo.)
- Which ADL rule is least unfair? Size, PnL, and profit×leverage ranking all trade off differently.

## Layout

```
src/engine.ts     state, events, margin, liquidation/ADL loop, invariants, replay
src/alloc.ts      largest-remainder apportionment (exact integer pro-rata)
src/fixed.ts      micro-USD fixed-point helpers
src/report.ts     ledger rendering, state hash
src/cli.ts        scenario runner
scenarios/        A, B, C above (JSON event lists)
docs/             ACCOUNTING.md (model + invariants), MIRROR-NOTES.md, RESEARCH-NOTES.md
```
