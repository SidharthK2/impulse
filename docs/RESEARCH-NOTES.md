# Notes on Mac's memo ("Levered markets with no continuous book", 4 Oct 2026)

My own read. I treat the memo as input, not fact.

## Checked myself

- **Fee identity.** `F = p(1−p)(L−1)` is the lender's expected loss on borrowed `p(L−1)` when NO happens
  with probability `1−p`. With it, ROE = `(L(1−p) − F)/(p + F)`. Factoring gives `(1−p)(L − pL + p) / p(L − pL + p)`
  = `(1−p)/p`. **Correct.** At a fair price, leverage on an instantly resolving binary is the same as buying more
  of it outright. This assumes risk-neutral fair pricing and instant resolution.
- **Terminal shortfall.** A long of `x` at `p0` with leverage `L` posts `x·p0/L` and loses `x·p0` at 0, so the
  shortfall is `x·p0(1 − 1/L)`. **Correct**, and our engine reproduces it: in scenario B gina's shortfall is
  282 − 6.50 = 275.50. For a short the analogue is `x(1−p0) − collateral`, which is far worse at low prices.
- **Mirror claims.** These match what I read in Mirror's docs on 2026-10-03: ADL every transaction, isolated
  margin, no insurance fund, 3×→100×, "works with no price feed".

## Fact-check

Done 2026-10-05; see [FACT-CHECK.md](./FACT-CHECK.md). Most of the memo's facts check out. The material errors:
Ventuals has been shut down since 15 Jun 2026 (the memo calls it "live" and "already shipping"), Ventuals leverage is 3×
not 5×, the "$653M Gauntlet" figure is superseded wording from Chitra's own paper, and the Nechepurenko papers don't
evaluate ADL venues at all.

## Where the PoC agrees with the memo

- *"Liquidation cannot be the solvency plan when the price jumps."* Yes. In our engine, resolution
  bankrupts every under-collateralized position on the losing side, every time.
- *"Whatever is left has to be socialized by a rule you can state before the event."* Our rule is stated and
  tested. Scenario B shows its unfairness: a correct, barely profitable long was charged more than its profit.
- *"Do not scale leverage with volume on an event contract."* Volume doesn't remove the terminal jump. In our
  model, no maintenance level short of full collateral survives resolution.

## Where I'd push back or add nuance

- *"Mirror's spec does not survive a resolution to 0."* The *venue* survives: ADL keeps it solvent by construction,
  and the fuzz test confirms it. What fails is the **winners' payout**, and with it the perp's fair price. That's
  a pricing and fairness failure, not insolvency. The distinction matters, because it's exactly Mirror's
  selling point.
- The fee identity assumes a lender charging a fair fee. A pure-ADL perp has no fee. The opposing traders
  carry the expected loss through truncated payouts. Rational shorts should demand a better price, so the perp
  trades away from the oracle and needs funding. The cost doesn't disappear, it moves.
- The memo recommends pro-rata on positive PnL, and Chitra (arXiv:2512.01112 v3) backs it: capped pro-rata on positive
  PnL, principal protected, is the unique monotone, scale-invariant, Sybil-resistant rule. Our size rule fails that, since
  scenario B charged frank's principal. The catch for an ADL-only venue is that positive PnL since entry can be less than
  the shortfall. Then principal must be touched, or solvency fails, which is the trilemma in practice.
- Something the memo doesn't cover, which scenario C shows: with ADL at mark, **a single wick permanently
  decides PnL**. The side that was right lost, and the side that was wrong profited. This matters more than the
  fee identity if the oracle is a thin Polymarket book.

## Follow-ups

All five follow-ups proposed here (capped-PnL ADL, a pre-resolution taper, max-loss margin, TWAP oracles and a
wick/pump attack, funding) were built on 2026-10-05; see [JOURNAL.md](./JOURNAL.md) and [BRIEF.md](./BRIEF.md).
