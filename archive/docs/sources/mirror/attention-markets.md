# Mirror docs: attention-markets

> Text extract of secret.mirror.exchange/docs/attention-markets (invite-gated), fetched 2026-10-26 via an invite link, HTML parsed to text (scripts and navigation chrome included as rendered text).
> Archived for private research reference; Mirror's claims, not verified behaviour. This copy renders the math formulas the 2026-10-03/05/09 copies dropped.

Attention Markets · Mirror
Docs
Create Wallet
DocsTelegram
What is Mirror?How MicroPerps WorkAttention MarketsPrivate TradingAgentic TradingReferrers & Builder RevenueTokenomicsFAQ
Docs navigation
What is Mirror?How MicroPerps WorkAttention MarketsPrivate TradingAgentic TradingReferrers & Builder RevenueTokenomicsFAQ
Docs/Attention MarketsMarkdownCopy as Markdown
## What Are Attention Markets?Copy as Markdown
See something going viral? Enter the link into Mirror and immediately start trading it, with leverage.
At launch, to illustrate the power of MicroPerps, we introduce a new asset category we call “Attention Markets” that allows you to directly long and short attention on the internet, with leverage. Mirror achieves this by automatically assigning every social profile and every piece of content a tradeable fair-launched market the moment it exists. You can think of it as a reflection of the social internet onto the monetary one.
An “Attention Token,” as we call them on Mirror, is uniquely identifiable by its network (e.g. at launch we support X, Instagram, YouTube, GitHub, Twitch, OnlyFans, and DeSo) and its user id (e.g. username, or an actual id where applicable). When you enter a link into the search box, these pieces of information are automatically extracted and used to route you directly to the corresponding market's trade page.
## How Attention Tokens Open for Trading
Attention Tokens are initialized and trade-able from the instant they are searched. All it takes is for someone to enter the link to a social entity into the search bar in order for a token to exist and for someone to be able to trade it.
All Attention Tokens start with a spot market and a MicroPerp market that uses that spot price for its oracle price calculation. For now, we focus mainly on the initialization of the spot market.
Each Attention Token has a fixed maximum supply of 1 billion that is sold in such a way that the price goes up as more people buy, and the price goes down as more people sell. Before a token is open for normal trading, however, it starts in a “sniping phase” where users can submit bids for a token before it actually opens. We describe this sniping phase first, then move on to explaining the nature of trading thereafter.
## The Sniping Phase
The first sixty seconds after an Attention Token is searched are what we call the “sniping phase.” In the sniping phase, you can submit a bid, aka “snipe,” for a token that simply specifies how much in USDC you would like to buy of that token. Just one simple number, that's all. Then, once it's time to “open” a token, all of the snipes are aggregated together and executed according to the token's “bonding curve” formula (more on that in a moment) and everyone receives fully-unlocked tokens that they can sell in normal trading. Everyone who submits a bid in the sniping phase receives the exact same average price at the open. We can call this Popen​ (more on how it's computed in a moment).
Why include a sniping phase? Why not just launch tokens immediately according to the bonding curve? If we were to open tokens immediately, without a sniping phase, this would result in a click-race where a single entity would wind up controlling the lion's share of a token's supply by pure chance (or due to a latency advantage). By having a sixty-second sniping phase, we not only level the playing field between bots and ordinary humans, but we also ensure that the initial supply of “hot” tokens is generally split among many initial participants. Sixty seconds is more than enough time for a human to evaluate a token and execute a trade (albeit you have to be quick!). But even if only bots are participating, it still ensures a split on the basis of capital (auction) rather than a winner-take-all on the basis of latency (click-race).
The end result is orders of magnitude less extraction, and thus vastly improved longevity for tokens, compared to traditional memecoin-style launchpads like pump.fun. This is especially important because tokens with higher social status or meme potential are inherently more valuable, and thus likely to be hotly-contested.
Note: The sniping phase serves the same purpose as the pre-sale of the $MIRROR token sale, namely batching early demand so a launch doesn't devolve into a latency race. But the mechanics are entirely different. $MIRROR is sold at a fixed base price with a decaying bonus, while Attention Token snipes are aggregated and cleared against the token's bonding curve at a single uniform price (essentially mimicking a Dutch auction). We discuss Popen​ for Attention Tokens in the next section, and a full derivation of their Popen​ formula is included in the appendix at the bottom of this page for those interested.
## Sniping Phase Details
This widget allows you to forecast how many tokens you'll get and at what price, given a certain amount of demand during the sniping phase. If you would prefer to work in a spreadsheet, check out this sheet (hit “Make a Copy” to edit).
Try it
## Sniping Bid
Set total directly · your share is clamped to total
Open Market Cap
$125.0K$125.0K
$125.0K$125.0K FDV
Total Snipe Tokens (unlocked)
800M800M
80%80% of Total
Your Snipe Tokens (unlocked)
00
0%0% of Total
Total Snipe Bid USD
$100K
Your Snipe Bid USD
$0 / $100K
Open Price
$0.000125$0.000125
P_open
Roughly, Popen​ doubles every time the amount of USDC bid doubles. For example, if the sniping phase aggregated $20,000 in USDC bids then Popen​ would be roughly 2x what it would be if it had only aggregated $10,000.
Below is a table showing Popen​ given varying amounts of USDC demand. Note the price roughly doubles every time the demand doubles.
Total Sniping Phase USDC DemandOpen Price (P_open)Open Market CapMultiple of Previous Price
$0$0.0000050$5,000—
$10,000$0.0000200$20,000—
$20,000$0.0000328$32,8081.640x
$100,000$0.0001250$125,000—
$200,000$0.0002342$234,2211.874x
$1,000,000$0.0010733$1,073,255—
$2,000,000$0.0021025$2,102,5311.959x
The Popen​ price determined from the sniping phase is then used as the floor price for normal trading, as we'll discuss in the Trading Spot Attention Tokens section.
Tokens purchased in the sniping phase are fully unlocked, and there is no advantage to buying tokens in the sniping phase vs ordinary trading except for the fact that your snipes hit the bonding curve earlier (and thus at a better price).
## The Initial Platform Launch
When the Mirror platform as a whole launches, we will be in a unique situation where we are going from zero tokens listed to the entire internet being immediately trade-able. If we were to naively allow all tokens to be traded within sixty seconds of being searched, we would be faced with a manic frenzy of bot activity as people raced to snipe tens of thousands of the more “obviously valuable” tokens. Such a rush would not only give humans zero chance of competing, it could also result in liquidity being too fragmented on day one to create the critical mass the platform needs to be sustainable (and fun!).
To put humans on a level playing field with bots, and to concentrate liquidity in the early days, all Attention Tokens searched in the first 24 hours of launch will be “sniping-only.” This means that the sniping phase will last indefinitely rather than sixty seconds.
Then, after 24 hours have passed, and people have put in their thoughtful bids for the most valuable tokens, the top tokens by total snipe amount will begin to be opened for actual trading one by one. This will be done by a random snipe-weighted sample of the top 1,000 tokens happening at regular intervals.
We have not yet decided exactly how fast we will begin to open tokens, and we'd like the community's input on what would be the best way to open all tokens. But below we provide a tentative schedule:
First 24 hours: No tokens open, sniping-only.
Tokens can be searched and snipes can be placed, but no tokens are open for actual trading yet.
Next 7 days: One token opens every 24h.
We conduct a snipe-weighted sample of the top 1,000 tokens and open one token every 24h.
This will result in liquidity concentrating on opening tokens.
Next 7 days: One token opens every hour (snipe-weighted sampling).
Next 7 days: One token opens every 30m (snipe-weighted sampling).
Next 7 days: One token opens every 5m (snipe-weighted sampling).
After: All tokens are open for trading. Newly-searched tokens open sixty seconds after the first time they are searched.
After this initial “drip” period, we enter the steady-state where all tokens are open and new tokens open within sixty seconds of being searched. This mechanic should ensure that the trading world has enough time and resources to properly digest the initial “IPO of the social internet.”
## Trading Spot Attention Tokens (After They Open)
After Attention Tokens complete their initial sniping phase they are open for ordinary trading.
Each Attention Token has a fixed maximum supply of 1 billion that is sold in such a way that the price goes up as more people buy, and the price goes down as more people sell. More precisely, the price quadruples every time the USDC demand for a token doubles, i.e. the price is quadratic in the USDC demand. The exact formula for the price as a function of how much USDC has been used to buy is below.
price(usdc_demand)=5,000×1,000,000,000(5,000+usdc_demand)2​
Below we show some example prices and market caps, showing the price-quadrupling property we mentioned:
Total USDC DemandCurve Price (In USD)Market CapMultiple of Previous Price
$0$0.0000050$5,000—
$10,000$0.0000450$45,000—
$20,000$0.0001250$125,0002.778x
$100,000$0.0022050$2,205,000—
$200,000$0.0084050$8,405,0003.812x
$1,000,000$0.2020050$202,005,000—
$2,000,000$0.8040050$804,005,0003.980x
This widget also allows you to forecast what the price will be for a given amount of demand with more granular detail. If you prefer to use a spreadsheet, check out this sheet (hit “Make a Copy” to edit).
Try it
## Spot Buy
Stacks on the sniping-phase open price · your share is clamped to total
Starts at Open Price $0.00013 · from Sniping Phase
Spot Market Cap
$3.1M$3.1M
$3.1M$3.1M FDV
Total Spot Tokens (unlocked)
160M160M
16%16% of Total
Your Spot Tokens (unlocked)
00
0%0% of Total
Total Spot Buy USD
$100K
Your Spot Buy USD
$0 / $100K
Fill Mode
Orders get different prices depending on when they're filled. Earlier orders get better execution.
First Buy (Lucky)Last Buy (Unlucky)Average
For those interested in the nitty-gritty details, we note that the formula for an Attention Token's spot price corresponds to a standard x⋅y=k bonding curve with initial x=5,000 and initial y=1 billion. We walk through exactly how this curve works in the appendix at the bottom of this page. If you are not familiar with x⋅y=k bonding curves, all you really need to know is that the price quadruples every time the amount of money in the curve doubles (i.e. the price is quadratic in usdc_demand, as the formula shows). You can see this from the table of prices shown above.
Notably, Mirror is a fully-fledged order-book exchange, but it also supports the ability to layer a continuous curve on top of the order-book, giving the best of both a central limit order-book like Hyperliquid and a liquidity-pool-based approach like Uniswap. When you place an order, you will either hit the curve liquidity or the nearest resting order, whichever offers the better price. Achieving this hybrid model efficiently, without compromising on our 300k+ tps throughput, was an important achievement for the platform.
## Referrals and Builder Revenue
## Referring Other Users
When you refer another user, whether in the pre-sale phase or in the post-launch phase, you get 14% of their trading fees post-launch, and they get 10% off of their trading fees. It’s a win-win.
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
## Appendix
## The xy=k Bonding Curve
A bonding curve is a function that determines a token's price algorithmically based on how much of that token has been bought. Generally, the more buy demand the higher the price, and vice versa. The x⋅y=k curve, used by Uniswap, is arguably the most widely-used variant. Two virtual reserves are tracked: x (USDC, in our case) and y (the Attention Token). Then an invariant x⋅y=k is chosen, a constant that never changes as trades happen. This is done seemingly arbitrarily but ends up ensuring that we always have price=x/y before and after any trade. If you are curious, you can actually start from wanting price=x/y, which is desirable because it asymptotes to infinity and zero on both sides, and then see how the invariant falls out of the necessary differential equations. A lot of explanations of bonding curves (like this legendary one) pull x⋅y=k out of thin air, but this is not ideal. x⋅y=k was a specific means for achieving price=x/y.
At any instant the marginal price of one token is x/y, i.e. the rate at which a very small trade would clear. When a buyer deposits Δx USDC, the reserve grows to x′=x+Δx and, to keep k constant, the token reserve must shrink to y′=k/x′. The buyer receives y−y′ tokens. Because each subsequent purchase further reduces y and raises x, the marginal price strictly increases with cumulative buy demand, which means buyers pay more the later they arrive.
Every Attention Token initializes with x0​=5,000 USDC and y0​=1,000,000,000 tokens, so k=5×1012. The implied opening price with zero demand is x0​/y0​=$0.000005. This is the floor that all subsequent prices build on, and it corresponds to a starting market cap of $0.000005×1,000,000,000=$5,000.
## Deriving P_open
In normal trading, buyers move along the curve one trade at a time and pay more the later they arrive. If we opened every token immediately without a sniping phase, we would incentivize a click race in the first seconds, and give a meaningful advantage to bots with latency advantages. The sniping phase fixes this by batching every snipe submitted before the open and clearing them all together, anchored to a single price, Popen​.
The question is: what should Popen​ be?
We pick Popen​ such that the price awarded to the batch equals the marginal price of the curve after the batch has cleared. In simple terms: the curve advances to some new state (x1​,y1​), and the price implied by that new state is exactly the price every sniper pays. No one pays less than the price the curve opens at.
If we instead naively executed the entire aggregated snipe against the bonding curve as a single market order, the first dollar in would clear at the floor while the last dollar in would clear at a much higher marginal price, and the batch as a whole would settle at an average well below the curve's new marginal price. This would create an immediate and highly-undesirable arbitrage: at the open, anyone could dump their freshly-minted tokens back into the curve for more USDC than they put in. In fact, there would be a race to do so. By anchoring the batch at Popen​ we eliminate this because the price the curve opens at (price=x1​/y1​) is the same price everyone in the batch paid.
In order to solve for Popen​, we need to enumerate the constraints pinning x1​ and y1​ and solve. Let B be the total USDC committed across all snipes.
The bonding-curve invariant holds across the batch: x0​⋅y0​=x1​⋅y1​.
Batch price equals final marginal price: the batch as a whole receives B/Popen​ tokens, and requiring that to equal the tokens the curve actually sold (y0​−y1​) gives y0​−y1​B​=y1​x1​​.
Cross-multiplying the second equation:
B⋅y1​=(y0​−y1​)⋅x1​
Substitute y1​=x0​⋅y0​/x1​ from the first equation, multiply through by x1​, and the y0​ cancels out:
B⋅x0​⋅y0​=(y0​−x1​x0​⋅y0​​)⋅x12​
B⋅x0​⋅y0​=y0​⋅x12​−x0​⋅y0​⋅x1​
x12​−x0​⋅x1​−B⋅x0​=0
This is a quadratic in x1​. Taking the positive root:
x1​=2x0​+x02​+4⋅B⋅x0​​​=2x0​+x0​⋅(x0​+4B)​​
From x1​ everything else follows:
y1​=x1​x0​⋅y0​​
Popen​=y1​x1​​=x0​⋅y0​x12​​
Tokens distributed=y0​−y1​
Each sniper's allocation = Bi​/Popen​ tokens, where Bi​ is their individual snipe. Everyone gets the exact same price.
And below we have two sanity-checks:
B=0: x1​=x0​, so Popen​=x0​/y0​=$0.000005, the floor.
B≫x0​: x1​≈B⋅x0​​, so Popen​≈x0​⋅y0​B⋅x0​​=y0​B​, which is linear in B. This is why the Popen​ table shows the price roughly doubling every time the aggregate snipe doubles: once you are past the initial regime, the relationship between snipe demand and open price is essentially linear.
In a click-race launch, the late buyer pays more than the early buyer, and the very last buyer typically pays a price far above what the very first buyer paid. Here, in contrast, every sniper pays the same price, and the curve opens at exactly that price. No participant's cost basis is below the open, so no one can dump their tokens at the open for more than they paid. From the perspective of any post-open buyer the curve simply opens at Popen​ with nobody having gotten a price below this in the past.
## The Post-Open Formula
After the open, the curve operates the way a standard x⋅y=k curve normally does: each buy advances the reserves and raises the marginal price. If the post-open starting state is (x1​,y1​) and a buyer puts in Δx USDC, the new marginal price is:
price(Δx)=x0​⋅y0​(x1​+Δx)2​
In the floor case where the sniping phase raised zero USDC, x1​=x0​=5,000, this reduces to the formula shown in the Trading Spot Attention Tokens section above:
price(usdc_demand)=5,000×1,000,000,000(5,000+usdc_demand)2​
Because price scales with the square of cumulative USDC demand, doubling the demand quadruples the price.
PreviousHow MicroPerps WorkNextPrivate Trading
Have more questions?
@mirror_exchanget.me/mirror_dot_exchange
On this page
How Attention Tokens Open for TradingThe Sniping PhaseSniping Phase DetailsThe Initial Platform LaunchTrading Spot Attention TokensReferrals and Builder RevenueReferring Other UsersGetting Paid to Build AppsAppendixThe xy=k Bonding CurveDeriving P_openThe Post-Open Formula
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
