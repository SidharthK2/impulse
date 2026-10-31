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

## Additions (2026-10-31, branch `db`): history beyond the in-memory caps

The exchange keeps the latest 2,000 risk events and 5,000 fills in memory; the database keeps all of them. Both
endpoints are unchanged without the new parameters.

```
GET /api/feed?market=&before=<id>&limit=<n>         → RiskEvent[]   newest first, id < before; limit 1–1000 (default 200)
GET /api/markets/:id/trades?before=<id>&limit=<n>   → Fill[]        newest first, id < before; limit 1–1000 (default 200)
GET /api/markets/:id/trades                         → Fill[]        the latest 60, as in GET /api/markets/:id
```

Either parameter switches the feed to the full history. Fills from the history have the same fields as
`trades` in `GET /api/markets/:id`.

```
GET /api/admin/stats   (admin)   → {seq, n, p50_us, p99_us, max_us, mean_us}
```

The journal's last sequence number, and the time each journaled command has taken since the server started
(applying it and committing it to the journal), for watching throughput.

## Additions (2026-10-31, branch `realism`)

```
POST /api/triggers  {market, side, kind: "stop" | "takeProfit", triggerPrice, size, price?, reduceOnly?, leverage?}
                    → TriggerView   (user) reduceOnly defaults to true; 400 if the mark has already reached it, or if
                    reduce-only with no position it would reduce. DELETE /api/orders/:id cancels one.
TriggerView    {id, market, side, kind, triggerPrice, size, price: string | null, reduceOnly, leverage, time}
AccountView    triggers: TriggerView[]            // waiting stop-loss and take-profit orders
RiskEvent      kind adds "trigger"                // a trigger fired (what it did) or was dropped (no position left)
AccountView    reserved: string                   // held back from the wallet by open orders
               available: string                  // wallet − reserved: what orders, withdrawals and margin can use
PositionView   fees: string                       // trading fees paid from this position's margin
Fill           fee?: string                       // in an account's own fills (perp): what that account paid
MarketView     settings adds "Trading fees", and "Liquidity" on markets that mirror Hyperliquid's book
POST /api/test/market   adds takerFeePpm?, makerFeePpm?, liquidationFeePpm?   (test hook; default 450, 150, 5000)
RiskEvent      kind "liquidation" also covers liquidations through the book ("… liquidated through the book: …"),
               amount = the penalty
effects lists  (admin price, IPO, …) can include "bookLiquidation" and "fees"
```

## Request bodies (2026-10-31)

Bodies are typed: each endpoint deserializes its JSON into a request struct, instead of reading fields with
JavaScript's loose rules (a leftover of the TypeScript server).

- Decimals (amounts, prices, sizes) are strings or JSON numbers: `"12.5"` or `12.5`; at most 9 decimals.
  `"all"` where the endpoint allows it (withdraw, spot buy and sell, snipe).
- Other numbers (leverage, slippage, holdSeconds, minutes) are JSON numbers or numeric strings. `null` or `""` means
  absent.
- Booleans (`reduceOnly`, `enabled`) are JSON booleans. `1`, `"yes"` and the like are refused (they used to count
  as true).
- Enums are their exact names: `side` buy | sell, `type` limit | market, `tif` gtc | ioc | alo.
- A missing required field is `400 {"error": "<field> is required"}`; a wrong type or bad value is
  `400 {"error": "invalid request: …"}` in serde's words; a malformed decimal is a 400 before anything changes (it
  used to reach the engine for some endpoints and come back as a 500). Invalid JSON is still
  `400 "body must be JSON"`, an empty body still reads as `{}`.

What the web app sends is unchanged and accepted.
