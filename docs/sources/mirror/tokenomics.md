# Mirror docs: tokenomics

> Text extract of secret.mirror.exchange/docs/tokenomics (invite-gated), retrieved 2026-10-05.
> Archived for private research reference; Mirror's claims, not verified behaviour. Math rendered as text may be incomplete.

$MIRROR TokenomicsCopy as Markdown
Mirror is not a company, and it does not have equity or pre-existing investors. It is a project that has been fully bootstrapped by its founder.
If you're reading this right now, you have the exact same access to this project as the most sophisticated financial players in the world.
## Buying $MIRROR
Initially the only way to obtain $MIRROR is to buy it with USDC or USDT. You can either buy tokens during the pre-sale phase or after launch from a bonding curve (more on bonding curves in a moment).
## The Pre-Sale Phase
The launch has two distinct phases: the pre-sale phase and the post-launch phase.
In the pre-sale phase, tokens are sold at a fixed base price of $0.0015, which equates to a circulating market cap of $300M. All purchases can be refunded anytime before launch and all tokens are fully unlocked at launch.
In addition, every pre-launch buy locks in a bonus that grants extra $MIRROR and lowers the effective price you pay down to as low as $0.001 per token (which corresponds to a $200M circulating market cap). The bonus is a simple mechanism to incentivize earlier participation and it starts at 50% at the beginning of the sale and decays linearly to 0% as tokens are sold, up to a maximum raise amount of ~$118.7M. All bonus tokens are also fully unlocked at launch but canceling/refunding a buy before launch results in the loss of your bonus.
Examples:
Beginning of the sale: If a buyer purchased $100,000 worth of tokens at the beginning of the sale, they would receive a base amount of tokens at a price of $0.0015 equaling ~66.7M tokens. In addition, they would receive ~50% of their base amount in bonus tokens equal to ~33.3M tokens. This results in ~100M tokens purchased total at an effective price of $0.001 thanks to the bonus.
Note: Amounts in the examples are approximate because the bonus decays continuously as people buy. So the first buy technically gets epsilon less than a 50% bonus because the bonus on their last dollar in is slightly lower than that on their first dollar in.
End of the sale: If a buyer purchased $100,000 worth of tokens toward the end of the sale, they would still receive a base amount of tokens at a price of $0.0015, equaling ~66.7M tokens. However, their bonus would be ~0%, causing them to receive ~0 bonus tokens. This results in ~66.7M tokens purchased total at an effective price of ~$0.0015.
The bonus mechanic is equivalent to saying “the effective price you pay increases linearly from $0.001 to $0.0015 as the sale fills up.” This is because a 50% bonus corresponds to an effective price of $0.001, and a 0% bonus corresponds to an effective price of $0.0015. But the bonus framing is more fun (who doesn't love a bonus?).
Below is a table showing the effective price and bonus amount as a function of how much the pre-sale has raised, up to the ~$118.7M cap:
Total RaisedBonusMarginal Effective PriceTokens Distributed
$050.0%$0.00100000
$10,263,15842.5%$0.001052610,000,000,000
$26,644,73732.6%$0.001131625,000,000,000
$53,437,50020.0%$0.001250047,500,000,000 (half)
$69,473,68414.0%$0.001315860,000,000,000
$89,802,6327.5%$0.001394775,000,000,000
$118,750,0000.0%$0.001500095,000,000,000 (full)
This widget shows exactly how many pre-sale tokens you get depending on when you purchase. Set how much has already gone into the pre-sale (which determines your bonus), then set your buy amount. If you prefer a spreadsheet, see here (hit “Make a Copy” to edit).Try it
## Pre-Sale Buy
Your bonus depends on how much has already gone in before youBonus If You Buy Now50%50%of 50%50% maxYour Tokens10M10M6.7M6.7M base + 3.3M3.3M bonusYour Effective Price$0.0010$0.0010vs $0.0015$0.0015 baseAlready In Pre-Sale USD$ / $119MYour Pre-Sale Buy USD$ / $119M left
After your buy: pre-sale 0%0% filled · bonus drops to 50%50%
## The Post-Launch Phase
After launch, i.e. in the post-launch phase, normal trading begins on a bonding curve that starts at the exact price the pre-sale ended at. Bonding curves automatically increase price the more people buy and decrease price the more people sell, and they are a popular way to bootstrap early liquidity for a market.
If you don't understand bonding curves at all, you can use this widget to simulate what happens to the price post-launch given a certain amount of pre-sale demand and a certain amount of net buy post-launch. If you prefer a spreadsheet, see here (hit “Make a Copy” to edit).Try it
## Launch Simulator
Pre-sale raise seeds the curve at its closing price · post-launch buys stack on topPre-SaleTotal Pre-Sale Raise USD$ / $119MPre-Sale Tokens Sold9.7B9.7B10.3%10.3% of 95B95B capAvg Pre-Sale Price$0.0010257$0.0010257bonus remaining 42.7%42.7%Curve Seed513.1M513.1M tokenspaired with $539.5K$539.5K USDCopens at $0.0010513$0.0010513Post-LaunchTotal Post-Launch Buy USD$ / $10MTerminal Price$0.0019753$0.00197531.91.9x the $0.0010513$0.0010513 openTerminal Market Cap$395.1M$395.1M$4.0B$4.0B FDV
The bonding curve used post-launch is a standard “” bonding curve seeded with a portion of the pre-sale proceeds. If you're unfamiliar with bonding curves, the most important thing to understand is that they consist of two pools: one pool of tokens (the “” pool), and one pool of USDC (the “” pool) such that: 1) the price is always equal to and 2) the price roughly 4x'es every time the cumulative USDC added to doubles (i.e. the price is quadratic in the purchase amount). We provide concrete examples below so that even if you don't follow the math you can still get a sense of the liquidity available at launch.
The total number of tokens that are allocated across the pre-sale and the bonding curve is 100B (as we will discuss in the supply section). The curve is seeded solely from tokens in this 100B that are not sold in the pre-sale, using a simple and fixed rule. If we call the price the pre-sale ended at (anywhere between $0.001 and $0.0015 depending on how much of the pre-sale filled), the rule is:
In words, for every 19 tokens sold in the pre-sale we put 1 token into the pool of the bonding curve paired with of USDC in the pool of the bonding curve, which sets the opening price to exactly because of the invariant mentioned earlier.
The curve therefore always opens at a price, , exactly equal to the price the pre-sale closed at:
Below is a table showing the values of and for various pre-sale outcomes. Notice that, no matter what happens, the curve opens exactly where the pre-sale left off:
Pre-Sale Outcome (D)Raised (f)Curve Tokens (y_open)Curve USDC (x_open)Open PriceOpen Market Cap
10,000,000,000$10.3M526,315,789$554,017$0.0010526$210.5M
25,000,000,000$26.6M1,315,789,474$1,488,920$0.0011316$226.3M
47,500,000,000$53.4M2,500,000,000$3,125,000$0.0012500$250.0M
60,000,000,000$69.5M3,157,894,737$4,155,125$0.0013158$263.2M
75,000,000,000$89.8M3,947,368,421$5,505,540$0.0013947$278.9M
95,000,000,000$118.75M5,000,000,000$7,500,000$0.0015000$300.0M
If we consider a “full” pre-sale where we have the maximum value of 95 billion for pre_sale_tokens_sold, then we get , which results in the launch allocation hitting its maximum value of 100 billion (95 billion in the pre-sale, 5 billion in the bonding curve, seeded with $7.5M of the $118.75M raised). In other words, no more than 100 billion tokens can be sold in total across the pre-sale and the bonding curve.
## $MIRROR Token Supply
$MIRROR has a fixed maximum total supply of 2T tokens, and an initial circulating supply of 200B tokens (10% of the maximum total).
100B launch allocation (circulating). In total, the pre-sale can sell up to 95 billion tokens if it fills completely, which results in a maximum raise amount of $118,750,000. Across the pre-sale and the bonding curve no more than 100 billion tokens can be sold in total (e.g. if the pre-sale sells the full 95 billion tokens then the bonding curve is initialized with the remaining 5 billion tokens for a total of 100 billion tokens across pre-sale & bonding curve). We refer to the 100 billion tokens allocated across the pre-sale and bonding curve as the launch allocation. The launch allocation is considered liquid at launch, and hence part of the circulating supply.
100B market-making allocation (circulating). In addition to the launch allocation, we allocate 100 billion tokens to a market-making allocation that is considered liquid at launch, and hence part of the circulating supply. This allocation is earmarked to support market-making both on Mirror and on third-party exchanges, which is required for third-party exchange listings. Importantly, the 100 billion amount represents an upper bound on the tokens that can be used, and the strategy may only make use of a tiny fraction of this.
We consider the sum of the 100B launch allocation and the 100B market-making allocation to be the circulating supply of 200B, which is used to compute the circulating market cap in this document and in all parts of the UI.
Note that if the pre-sale does not fill completely then there may be tokens that are unused from the launch allocation after launch. In this case, the circulating supply would technically be lower than 200B. However, to keep the circulating supply from being a variable number, and to maximize liquidity available for exchange listings after launch, we consider unused tokens in the launch allocation a part of the market-making allocation after launch.
1.8T unallocated (non-circulating). The remaining 1.8 trillion $MIRROR tokens are initially unallocated, and thus not considered a part of circulating supply. This is a significant carve-out to support future initiatives including but not limited to airdrops rewarded on the basis of points-based incentives. We could have left the unallocated supply at zero and simply minted tokens as we go along. But we prefer to give a hard upper bound on the number of tokens we could ever mint, which is why we include this allocation here explicitly.
There are no other allocations than what's listed here, and there are also no other emissions or staking rewards or things like that. What you see here is all there is.
Below is a summary of the key constants:
ConstantValue
Max total supply cap2,000,000,000,000 (fixed forever)
Pre-sale distribution cap95,000,000,000 tokens (bonus tokens included)
Launch allocation (pre-sale + curve, circulating)100,000,000,000 (5%)
Market-making allocation (circulating)100,000,000,000 (5%)
Circulating supply at launch (launch + market-making)200,000,000,000 (10%)
Unallocated tokens (non-circulating)1,800,000,000,000 (90%)
Base price$0.0015
Maximum bonus50% (effective price $0.001)
Opening pricePre-sale closing price: $0.001 to $0.0015 ($200M to $300M circulating market cap)
Maximum raise$118,750,000
## $MIRROR Buybacks
On every trade, Mirror charges a trading fee that is immediately converted to USDC. This is true for all markets, including major tokens like Bitcoin, Ethereum, and Solana. For Attention Tokens, 50% of this fee is allocated to profile owners, while the other 50% is retained by the exchange. In all cases, we call whatever portion is retained by the exchange the “net fees.”
On every trade the net fees are allocated algorithmically to the buy & burn of $MIRROR tokens. Of these net fees, we allocate a small portion (10%) to algorithmically buy and burn $DESO to support the proliferation of decentralized social media.Try it
## Net fee split
Drag to set net fees collectedNet fees collected$1.0B$1.0B$1M$1B$1TAllocation$MIRROR buy & burn$900.0M$900.0M90% of net fees$DESO buy & burn$100.0M$100.0M10% of net fees
100% of net fees flow back to token-holders via buy & burn, with no private round, no VC allocation before the public sale.
As a concrete example, if the exchange were to generate $200 million in fees from Attention Tokens and $900 million in fees from other markets, then the net fees would be $1 billion, because the creators get half of the Attention Token fees, leaving the exchange with $100 million + $900 million in net fees. Then, of this $1 billion in net fees, $900M would go to buy and burn $MIRROR while $100M (10%) would go to buy and burn $DESO.
## Referrals
In the pre-sale phase, 2.5% of every buy is allocated to paying the people who helped bring that user onto the platform, at no cost to the buyer. That means a $1M buy results in $25k going directly to referrers. With a maximum raise amount of ~$118.7M, that means that referrers can earn nearly $3M for sharing the platform with others. All payouts are made directly in USDC after launch. There is no cap on how much an individual referrer can earn from this program.
Referral payments are split so that the person who referred a buyer gets 70% of the referral amount (1.75% of the buy), the second-degree referrer gets 20% of the referral amount (0.5%), and the third-degree referrer gets 10% of the referral amount (0.25%). For example, if A refers B, B refers C, C refers D, and D buys $1M in the pre-sale, then C gets $1M × 0.025 × 0.7 = $17,500, B gets $1M × 0.025 × 0.2 = $5,000, and A gets $1M × 0.025 × 0.1 = $2,500, which comes out to $25k total (2.5% of $1M).
All of this is just the beginning as well. When you refer another user you also get 14% of their trading fees post-launch and they get 10% off of their trading fees. It’s a win-win.
You also get 4% of the trading fees from second-degree referrals and 2% of fees from third-degree referrals. For example, if A refers B, B refers C, and C refers D, then A gets 14% of B’s fees, 4% of C’s fees, and 2% of D’s fees. This represents the same 70%/20%/10% split, but over 20% of trading fees rather than 2.5% of pre-sale buys.
Unlike most exchange affiliate programs, all of your earnings are paid in USDC so you don’t have to manage fees in lots of different currencies. You just get a steady stream of USDC cashflow as the people you refer (and the people they refer) start buying and/or trading. This was not trivial to implement, especially for highly-illiquid tokens, which is why most exchanges don't do it, but we prioritized it to maximize ease for referrers.
There is no limit on the referral fees that can be earned on the 2.5% of pre-sale buys. The 10% discount on trading fees for a referee is active until they’ve personally executed $25M in weighted volume (corresponds to roughly $2,500 in exchange fees paid). Referrers keep earning their exchange fee kickback for much longer, until the referee hits 1B in weighted volume (corresponds to roughly $100k in exchange fees paid, 40x longer than the discount lasts). Both caps are per-referee, not lifetime totals across your network, so every newly referred user starts with a new clock.
