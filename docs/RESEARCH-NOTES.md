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

## Not checked

The arXiv references (several are dated after mid-2026), the Hyperliquid 10 Oct 2025 numbers ($2.1B / 12 min,
$45–52M vs $653M haircut estimates), the Ventuals oracle and funding parameters, trade[XYZ] specs, Lattica's
calibration figures, Soar's valuation study, and the Kalshi margin filing. The memo's own typos ("siix",
"didnt not") suggest it's a fast draft. Read the primary sources before citing any number to Cesar.

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
- The memo recommends pro-rata on positive PnL. That's fairer than our size rule, but it loses the simple per-tick
  non-negativity proof. An account can be in profit since entry and still have little equity, so it needs a waterfall.
  It's worth adding as a second policy and comparing on the same scenarios.
- Something the memo doesn't cover, which scenario C shows: with ADL at mark, **a single wick permanently
  decides PnL**. The side that was right lost, and the side that was wrong profited. This matters more than the
  fee identity if the oracle is a thin Polymarket book.

## Candidate next steps for the PoC

1. Second ADL policy: pro-rata on positive PnL, with an equity-capped waterfall. Compare A/B/C side by side.
2. Pre-resolution leverage compression or a hard-flat time (the memo's Axient idea), to see how much ADL disappears.
3. Per-side margin on max loss instead of notional, so "3×" means the same thing for longs and shorts.
4. Oracle guards (bands, TWAP marks, staleness) and a wick-attack scenario, with attacker PnL against cost.
5. Funding, so the "perp trades off-oracle" question can be measured instead of argued.
