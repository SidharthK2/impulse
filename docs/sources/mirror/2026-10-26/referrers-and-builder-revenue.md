# Mirror docs: referrers-and-builder-revenue

> Text extract of secret.mirror.exchange/docs/referrers-and-builder-revenue (invite-gated), fetched 2026-10-26 via an invite link, HTML parsed to text (scripts and navigation chrome included as rendered text).
> Archived for private research reference; Mirror's claims, not verified behaviour. This copy renders the math formulas the 2026-10-03/05/09 copies dropped.

Referrers & Builder Revenue · Mirror
Docs
Create Wallet
DocsTelegram
What is Mirror?How MicroPerps WorkAttention MarketsPrivate TradingAgentic TradingReferrers & Builder RevenueTokenomicsFAQ
Docs navigation
What is Mirror?How MicroPerps WorkAttention MarketsPrivate TradingAgentic TradingReferrers & Builder RevenueTokenomicsFAQ
Docs/Referrers & Builder RevenueMarkdownCopy as Markdown
## Referrers & Builder RevenueCopy as Markdown
## Referring Other Users
## Pre-Sale Referrals
In the pre-sale phase, 2.5% of every buy is allocated to paying the people who helped bring that user onto the platform, at no cost to the buyer. That means a $1M buy results in $25k going directly to referrers. With a maximum raise amount of ~$118.7M, that means that referrers can earn nearly $3M for sharing the platform with others. All payouts are made directly in USDC after launch. There is no cap on how much an individual referrer can earn from this program.
Referral payments are split so that the person who referred a buyer gets 70% of the referral amount (1.75% of the buy), the second-degree referrer gets 20% of the referral amount (0.5%), and the third-degree referrer gets 10% of the referral amount (0.25%). For example, if A refers B, B refers C, C refers D, and D buys $1M in the pre-sale, then C gets $1M × 0.025 × 0.7 = $17,500, B gets $1M × 0.025 × 0.2 = $5,000, and A gets $1M × 0.025 × 0.1 = $2,500, which comes out to $25k total (2.5% of $1M).
Referral payouts are made directly in USDC when Mirror launches, which is when all pre-sale buys execute.
## Post-Launch Referrals
When you refer another user, whether in the pre-sale phase or in the post-launch phase, you also get 14% of their trading fees post-launch, and they get 10% off of their trading fees. It’s a win-win.
You also get 4% of the trading fees from second-degree referrals and 2% of fees from third-degree referrals. For example, if A refers B, B refers C, and C refers D, then A gets 14% of B’s fees, 4% of C’s fees, and 2% of D’s fees. This represents the same 70%/20%/10% split, but over 20% of trading fees rather than 2.5% of pre-sale buys.
Referral fees can also be paid on snipes for Attention Markets. Up to 2.5% of every snipe is paid out as a referral fee, following the same first, second, and third-degree referral graph (1.75% to first-degree referrer, 0.5% to second-degree, and 0.25% to third-degree). The more money that goes into the snipe phase of a token, the closer the total referral percentage gets to the maximum value of 2.5%. For snipes, referral earnings are paid out after the token opens.
Unlike most exchange affiliate programs, all of your earnings are paid in USDC so you don’t have to manage fees in lots of different currencies. You just get a steady stream of USDC cashflow as the people you refer (and the people they refer) start buying and/or trading. This was not trivial to implement, especially for highly-illiquid tokens, which is why most exchanges don't do it, but we prioritized it to maximize ease for referrers.
The 10% discount on trading fees for a referee is active until they’ve personally executed $25M in weighted volume (corresponds to roughly $2,500 in exchange fees paid). Referrers keep earning their exchange fee kickback for much longer, until the referee hits 1B in weighted volume (corresponds to roughly $100k in exchange fees paid, 40x longer than the discount lasts). Both caps are per-referee, not lifetime totals across your network, so every newly referred user starts with a new clock.
## Getting Paid to Build Apps
If you want to build a third-party frontend or integrate Mirror markets into an existing wallet, we’ve not only made it extremely easy but we’ve also ensured you are compensated for it.
Every order request includes an option to set a builder_fee field with your account_id and the fee_rate you want to add on top of the exchange’s standard fees. It looks like this for a spot order request:
pub struct OrderRequest {
 pub side: Side,
 pub price: Option<Price>,
 pub base_size: Option<Size>,
 pub quote_size: Option<StandardAtoms>,
 pub time_in_force: TimeInForce,
 pub client_order_id: Option<ClientOrderId>,
 /// Optional builder fee: an additional charge on the taker routed to a
 /// builder (frontend/bot/aggregator). Applies only to taker fills.
 pub builder_fee: Option<BuilderFee>,
}
pub struct BuilderFee {
 pub account_id: AccountId,
 /// Fee rate on notional value (same basis as exchange fee).
 /// E.g. 1bp = 100_000 nanos. Must be in (0, MAX_BUILDER_FEE_RATE].
 pub fee_rate: RateNanos,
}
/// Maximum builder fee rate: 50% = 500_000_000 nanos.
pub const MAX_BUILDER_FEE_RATE: RateNanos = RateNanos(500_000_000);
For example, if the exchange’s fees for a particular user are 2.5% and you added a 1% fee via the BuilderFee.fee_rate, and if the user did a trade worth $100 notional, then the exchange would get $2.50 and you would get $1 on top.
There’s no registration or any need to make the user sign anything. Just set your account_id, set your fee_rate, and let the money start rolling in.
Unlike most exchange affiliate programs, these fees are paid in USDC so you don’t have to manage fees in lots of different currencies. You just get a steady stream of USDC cashflow as more people start using your app.
Note that builder fees only apply on taker fills, not maker fills. In addition, referral discounts and referral kickbacks do not get applied on the taker side of transactions with builder fees, while the maker side is entirely unaffected by builder fees. The maximum builder fee you can set is 50%.
## User-Managed Markets
MicroPerps enable the permissionless creation of new markets, where the oracle and metadata are managed by a third-party rather than Mirror itself. For such markets, deployers will earn 90% of trading fees. This provides third parties an incentive to provide a strong oracle, as well as an incentive to provide ample liquidity for their markets.
Perhaps the most beautiful thing about the system is that creating a market will be totally self-service and cost nothing. Mirror holds the view that it should be up to the users to decide what markets are reliable and liquid enough to trade, not the exchange, and MicroPerps make this vision achievable for the first time.
PreviousAgentic TradingNextTokenomics
Have more questions?
@mirror_exchanget.me/mirror_dot_exchange
On this page
Referring Other UsersPre-Sale ReferralsPost-Launch ReferralsGetting Paid to Build AppsUser-Managed Markets
●$MIRROR launches in
– –
Days
– –
Hrs
– –
Min
– –
Secs
countdown activates soonBuy $MIRROR
MIRROR
MIRROR
Every Market, Reflected.
What is Mirror?Attention MarketsHow MicroPerps WorkTokenomicsFAQDocsTelegram© 2026 Mirror · Every market, reflected.
