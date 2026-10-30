# API CONTRACT

Everything that exists today stays as is (see docs/MVP.md). Money and prices are decimal strings in USD;
times are ms since epoch. Additions:

```
MarketView
  kind: "perp" | "binary" | "attention" | "preipo"
  source.kind adds "book" (label "own order book")
  snipe: null | {
    opensAt: number, total: string, snipers: number, projectedOpenPrice: string,
    top: { account: string, usdc: string }[],                 // largest 10
    recent: { account: string, usdc: string, time: number }[]  // latest 10
  }
  launch: null | { openPrice: string, openedAt: number, sniped: string, tokensSold: string, reserve: string }
  preipo: null | { seedPrice: string, impliedValuation: string,   // mark × 1,000,000,000
                   status: "private" | "public", ipoAt: number | null, ipoPrice: string | null }
  settings: { label: string, value: string, ours: boolean }[]   // oracle window, fee, start leverage, etc.

AccountView
  snipes: { market: string, usdc: string, time: number }[]     // bids still waiting for an open

RiskEvent
  kind adds "open" | "ipo"
  price: string | null      // mark at the event, for chart markers

Endpoints
  POST /api/snipe            {market, usdc}                    → {ok: true}   user; only before opensAt
  POST /api/attention        unchanged input; the returned market has snipe != null
  POST /api/admin/preipo     {id, name, price, description?}  → MarketView
  POST /api/admin/ipo        {market, price}                   → {effects: string[]}
  POST /api/admin/demo-coin  {handle?}                         → MarketView   (random handle if omitted)
  POST /api/admin/pump       {market, usdc}                    → {effects: string[]}
       attention: a house account buys (usdc > 0) or sells (usdc < 0) spot on the curve
       other kinds: 400, use /api/admin/price
```

Websocket: no new channels. The `markets` channel carries the new MarketView fields, `account` carries
snipes, and `feed` carries the new RiskEvent kinds and price.
