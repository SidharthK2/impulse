// Funding after an oracle gap, through the API: the premium reads the order book's mid, so once the book is
// re-quoted around the new mark, funding stays near the base rate instead of riding a stale last trade to its
// cap. Rust server only (the TS server doesn't send book mids to the engine).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type User, type Venue, rustTargets, uid } from "./venue.js";

const BASE = 0.0005; // 0.05%/h at tier 0
const NEAR = 0.0002; // premium allowance: a mid within a 0.2% spread of the mark gives at most 0.025%/h

describe.each(rustTargets())("funding after a gap ($name)", ({ start }) => {
  let v: Venue;
  beforeAll(async () => {
    v = await start();
  });
  afterAll(() => v?.close());

  const funding = async (id: string) => (await v.ok(v.call("GET", `/api/markets/${id}`))).market.funding.ratePerHour as number;
  /** Two-sided quotes 0.1% either side of `mid`. */
  const quote = async (maker: User, market: string, mid: number) => {
    await v.ok(v.as(maker, "POST", "/api/orders/cancel-all", { market }));
    await v.ok(v.order(maker, { market, side: "buy", price: (mid * 0.999).toFixed(3), size: "10" }));
    await v.ok(v.order(maker, { market, side: "sell", price: (mid * 1.001).toFixed(3), size: "10" }));
  };

  async function traded(market: string, s: string) {
    const maker = await v.user(`mk${s}`, "100000");
    const taker = await v.user(`tk${s}`, "100000");
    await quote(maker, market, 100);
    await v.ok(v.order(taker, { market, side: "buy", type: "market", size: "1", leverage: 1 })); // last trade 100.1
    await v.ok(v.admin("POST", "/api/test/advance", { ms: 2000 }));
    expect(Math.abs((await funding(market)) - BASE)).toBeLessThan(NEAR); // before the gap: mid 100, mark 100
    return maker;
  }

  it("stays near the base rate after a 50% crash once the book is re-quoted", async () => {
    const s = uid();
    const X = `F${s}`;
    await v.ok(v.admin("POST", "/api/test/market", { id: X, kind: "perp", price: "100", szDecimals: 2 }));
    const maker = await traded(X, s);
    await v.ok(v.admin("POST", "/api/admin/price", { market: X, price: "50", holdSeconds: 0 }));
    await quote(maker, X, 50);
    await v.ok(v.admin("POST", "/api/test/advance", { ms: 2000 }));
    const rate = await funding(X);
    expect(Math.abs(rate - BASE)).toBeLessThan(NEAR); // the last trade (100.1) would have pinned it at 4.05%/h
    expect(await v.invariants()).toEqual([]);
  });

  it("stays near the base rate after an IPO gap once the book is re-quoted", async () => {
    const s = uid();
    const P = `G${s}`;
    await v.ok(v.admin("POST", "/api/admin/preipo", { id: P, name: "Funding Co (pre-IPO)", price: "100" }));
    const maker = await traded(P, s);
    await v.ok(v.admin("POST", "/api/admin/ipo", { market: P, price: "50" }));
    await quote(maker, P, 50);
    await v.ok(v.admin("POST", "/api/test/advance", { ms: 2000 }));
    expect(Math.abs((await funding(P)) - BASE)).toBeLessThan(NEAR);
    expect(await v.invariants()).toEqual([]);
  });
});
