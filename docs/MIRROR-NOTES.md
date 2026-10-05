# Mirror: what the docs say, what they don't

I retrieved these on 2026-10-03 with the invite cookie flow (visit the invite URL Cesar shared, then reuse the cookie jar):
`/launch`, `/docs/what-is-mirror`, `/docs/how-microperps-work`. These notes come from reading those pages
directly, not from the project brief. `/docs/faq` returned 404 at that path. I didn't go looking for its real slug.

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
