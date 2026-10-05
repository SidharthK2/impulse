# Mirror: what the docs say, what they don't

I retrieved these on 2026-10-03 with the invite cookie flow (visit the invite URL Cesar shared, then reuse the cookie jar):
`/launch`, `/docs/what-is-mirror`, `/docs/how-microperps-work`. These notes come from reading those pages
directly, not from the project brief. On 2026-10-05 I also read `/docs/attention-markets`, `/docs/private-trading`, `/docs/agentic-trading` (a stub),
`/docs/tokenomics` and `/docs/help` (the FAQ).

## Stated in the docs (claims, not verified behaviour)

- **No exchange backstop.** ADL is the *sole* means of settling bad debt: no insurance fund, no HLP-style vault.
  The pitch is that this enables permissionless listing ("first-to-list for everything").
- **"Mathematically-guaranteed solvency".** "Solvency checks before every single trade and every single price tick,
  and running ADL atomically within the transaction itself if anyone has gone negative."
- **One core.** The matching and risk engines are one single-threaded core. They claim >300k tx/s per thread.
- **Isolated margin by default** lets markets shard across threads. Cross/portfolio margin is "a flag flip" later,
  and the docs warn that it can spread socialized losses into other markets.
- **Leverage** starts at 3× and rises with "volume and depth" up to 100×. The criteria aren't disclosed.
- **Funding:** a new market starts at the "maximum base rate" to attract short liquidity. Inactive markets keep
  paying "the funding rate determined at the last tick".
- **Oracles:** third parties can deploy markets by *supplying the oracle* and setting fees, in exchange for 90% of fees.
  Prediction markets get "a mirrored MicroPerp" on Polymarket/Kalshi. The docs **imply** the venue price is the oracle
  but don't say so.
- **Robustness claims:** "function on arbitrarily illiquid price feeds (and even on no price feed at all)", and handle
  equities over nights and weekends because "MicroPerps are robust to gaps in the price feed".

## Architecture details (from the other pages)

- **Hybrid book plus curve.** "Mirror is a fully-fledged order-book exchange, but it also supports the ability to layer a
  continuous curve on top of the order-book." An order fills against whichever of the curve or the best resting order is better.
- **Engine in Rust**, with integer fixed-point: the order request structs use `StandardAtoms` sizes and `RateNanos` (1e-9) fee rates.
- **Attention tokens:** 1B fixed supply on an xy=k virtual-reserve curve (floor market cap $5k; price is quadratic in USDC demand).
  There's a 60s batch "sniping" auction that clears at one uniform price, equal to the post-batch marginal price. At platform
  launch it's sniping-only for 24h, then markets open one at a time in a "drip".
- **Attention perps:** "All Attention Tokens start with a spot market and a MicroPerp market that uses that spot price for its oracle
  price calculation." So the oracle is **Mirror's own curve and book**. How the price is smoothed, if at all, isn't stated.
- **Stealth Mode:** order placements are hidden from the "public transaction log" and the public book, and executions are anonymized.
- **Fees:** referrers get 14% / 4% / 2% of fees across three degrees, and referees get 10% off. Builder fees go up to 50% on taker
  fills. The fee schedule itself isn't published; one example uses a hypothetical 2.5%.
- **Org and token:** "not a company", bootstrapped by founder Nader Al-Naji (Basis, DeSo). $MIRROR pre-sale at $0.0015 base
  ($300M circulating market cap) with a bonus decaying to an effective $0.001, cap of about $118.7M, refundable before launch.

## Not in the docs (we had to choose)

| Gap | Our choice |
|---|---|
| ADL counterparty selection | pro-rata by opposing position size |
| ADL price | bankruptcy price (mark + shortfall haircut) |
| Liquidation before E<0 (MM level, penalty, partial?) | full close at mark when E < MM, no penalty |
| Margin formula on a [0,1]-bounded asset | notional-based, capped at max loss |
| Mark price (oracle vs. last trade vs. blend) | oracle only |
| What "no price feed" means for margin | not supported: trading needs a first tick |
| Withdrawal of unrealized PnL | realized cash only, above IM |
| Prediction-market resolution | final tick to 0/1 + settle all |
| Funding formula | omitted |

## What their solvency claim does *not* say

"Solvent after every state transition" means every account's equity is ≥ 0 and the claims sum to the vault.
It doesn't mean winners get paid in full. On a gap, the winners pay for it, through forced closes and haircuts.
The claim also doesn't address oracle manipulation. If a third party supplies the oracle, it can ADL the
other side of its own position.
