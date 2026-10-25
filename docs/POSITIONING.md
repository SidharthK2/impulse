# MicroPerps vs pump.fun and other perp DEXs: what's actually new

*For Cesar · October 2026 · follows [BRIEF.md](./BRIEF.md). Evidence is from the engine, the MVP ([MVP.md](./MVP.md)) and our research notes.*

## TL;DR

- **On spot, an attention market is pump.fun.** Same idea: a bonding curve, and anyone can launch a token for anyone.
- **What's new is a leveraged perp, long *or short*, on that token from minute one.** Pump.fun only lets you buy.
- **What makes it listable is ADL with no insurance fund.** The venue can list anything because it never eats the loss.
  Traders on the winning side do.
- **That's also the weak point.** The perp's oracle is the token's own curve, and the curve can be pumped. In our
  simulation, about $5k of spot buying took 100% of the shorts' $3k for roughly $100 in fees.
- **Pre-IPO markets need a price source, and every option is weak.** It's a deployer's feed (who can trade against
  it), the market's own book (circular), or a copy of another venue.
- **On established markets (BTC, ETH, majors) there's no moat.** It's another perp DEX, with thinner books than
  incumbents and haircuts on winners after big gaps.
- **Any moat is in distribution and listing speed, not the engine.** We reproduced the core risk model and a working
  venue in TypeScript.

## 1. Versus pump.fun

| | pump.fun | Mirror attention market |
|---|---|---|
| Who can launch | Anyone, including creators launching their own coin | Anyone, for any social handle |
| Spot | Bonding curve, then graduation to a DEX pool | xy=k curve ($5k virtual USDC, 1B tokens: Mirror's published reserves) |
| Go long | Buy the token | Buy the token, or a leveraged long perp |
| Go short | Not possible | Leveraged short perp from launch |
| Worst case for others | None: your coin going to zero only costs you | Someone's bankruptcy is charged to the winning side (ADL) |
| Perp price source | n/a | The token's own curve |

**The product difference is shorting and leverage on day one.** That's a real gap. Today, the only way to bet
against a fresh memecoin is not to buy it.

**Getting shorts to show up is the hard part.** Who shorts a coin that's minutes old into a crowd of buyers? Mirror's
answer is to start every perp at its "maximum base rate" of funding, so longs pay shorts heavily. In our MVP's
parameters that's 0.05% an hour, and an idle long paid about $72 a day (scenario J).

**The listing model works because nobody behind the venue loses.** Hyperliquid has to be careful what it lists:
long-tail blow-ups land on its house vault, HLP (POPCAT, November 2025, about $4.5–5M). Mirror has no vault. The loss
goes straight to the traders on the other side, so listing everything costs the venue nothing.

**Where it breaks: the curve is the oracle.** On pump.fun, pushing the price only moves your own coin. On Mirror,
pushing the curve moves the mark of every leveraged position in that market.
- From the pump-attack sweep (scenario F, `pnpm attack`): three shorts with $1,000 each, at about 2.85× leverage.
  A $5,000 spot pump took **all $3,000** of their collateral, for about **$100 in fees**. On xy=k, buying and then
  selling back costs only fees.
- A TWAP oracle only delays the attack. What stops it is arbitrageurs selling into the pump, and new tokens have none.
- The MVP's `@anon_dev` market (instant oracle) reproduces this live. A $6,000 pump bankrupted the only short
  in the same transaction.

## 2. Pre-IPO markets

Without an external reference price, a perp has to get its price from somewhere. There are three options, and all are weak:

| Price source | Example | Problem |
|---|---|---|
| A third party supplies the feed | Mirror lets deployers bring the oracle for 90% of fees. On Hyperliquid HIP-3, the deployer sets the oracle, leverage and halts (500k HYPE stake, about $46M, slashable) | The feed owner can trade against their own oracle and ADL the other side. That's open question 6 in the brief |
| The market's own book or curve | Mirror: "function … even on no price feed at all" | Circular: the price is whatever traders push it to, so it's sentiment, levered, on a manipulable mark |
| Copy another venue | HIP-3 `xyz:SPCX` (SpaceX), daily candles since May 2026 | Then it's a copy competing on liquidity, not a new market. Ventuals, the pre-IPO venue on HIP-3, shut down in June 2026 |

Before a company lists, there's no price to anchor to. Secondary-market marks are sparse and private. Any pre-IPO
perp is a bet on sentiment with leverage, and whoever controls the mark controls who gets liquidated.

## 3. Established markets

For BTC, ETH and the majors, MicroPerps are just another perp DEX, and a structurally weaker one:

- **Depth:** Hyperliquid and Binance books are far deeper, and a new venue loses on price and slippage.
- **Gaps:** with ADL as the only backstop, the winning side is haircut when someone goes negative. In our binary gap
  (scenario A), the shorts collected **49%** of their theoretical profit. Incumbents liquidate through the book with
  an insurance fund or vault behind it, so winners are normally paid in full.
- **Speed** (">300k tx/s per thread") is a weak moat. Past "fast enough", users can't tell the difference.
- **Permissionless listing is no longer unique.** HIP-3 already lets third parties list markets on Hyperliquid, with a
  large stake as the price of entry.

## 4. Where a moat could actually be

1. **First to list the long tail.** That means every handle, pump.fun token and Polymarket market, with a perp the
   moment it exists. Mirror plans "every Uniswap and pump.fun token" and leveraged prediction markets.
2. **Distribution.** The DeSo team's social-token audience, a three-tier referral scheme, and builder fees.
3. **Curve and book in one place.** A token launches and gets a perp in the same venue, with no migration.
4. **Manipulation-resistant long-tail oracles.** This is the real technical problem and nobody has solved it. Our
   manipulation-meter project (INTERMEDIATES #3) is aimed at it.

The engine, ADL as the only backstop, is the easy part to copy. We built a working version: an order book, live
Hyperliquid and Polymarket oracles, attention curves and a trading UI ([MVP.md](./MVP.md)). Its costs are well
understood and land on the winning side.

## Bottom line

MicroPerps sell **leverage and shorting on the long tail**, paid for by whoever is on the winning side of a gap. That
fills a real gap pump.fun leaves open. As described, though, it's also the most exploitable part of the design,
because the long tail is exactly where the oracle is weakest and arbitrage is thinnest.

If we build in this space, the place to compete is **oracle integrity for thin markets**: making a pump unprofitable
before leverage is switched on. The engine isn't where the edge is, and neither is listing everything faster than
Mirror.

## Sources in this repo

- Pump attack, gap haircuts, funding: [BRIEF.md](./BRIEF.md) findings 1, 4 and 8; scenarios A, F and J; `pnpm attack`
- Mirror's claims and gaps: [MIRROR-NOTES.md](./MIRROR-NOTES.md), [research/mirror-infra.md](./research/mirror-infra.md)
- HIP-3 terms, Ventuals: [FACT-CHECK.md](./FACT-CHECK.md), [research/tools-landscape.md](./research/tools-landscape.md)
- Incidents (JELLY, POPCAT): [INTERMEDIATES.md](./INTERMEDIATES.md), [research/literature.md](./research/literature.md)
- Live demo: [MVP.md](./MVP.md), market `@anon_dev`
