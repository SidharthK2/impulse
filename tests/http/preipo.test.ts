// Pre-IPO markets through the API: the mark is the market's own book until the admin IPO gaps it to a public
// price. Rust server only (the TS server has no pre-IPO markets).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type User, type Venue, rustTargets, uid } from "./venue.js";

describe.each(rustTargets())("pre-IPO ($name)", ({ start }) => {
  let v: Venue;
  beforeAll(async () => {
    v = await start();
  });
  afterAll(() => v?.close());

  const market = async (id: string) => (await v.ok(v.call("GET", `/api/markets/${id}`))).market;
  const mark = async (id: string) => (await market(id)).mark as string;
  const order = (u: User, body: Record<string, unknown>) => v.ok(v.order(u, body));

  it("seeds STRIPE-PRE at $91.50 on its own order book", async () => {
    const m = await market("STRIPE-PRE");
    expect(m.kind).toBe("preipo");
    expect(m.source).toEqual({ kind: "book", label: "own order book" });
    expect(m.preipo).toEqual({ seedPrice: "91.5", impliedValuation: "91500000000.00", status: "private", ipoAt: null, ipoPrice: null });
    expect(m.mark).toBe("91.5");
  });

  it("marks to median(best bid, best ask, last trade), the last trade with a side empty, else the seed", async () => {
    const s = uid();
    const P = `PRE${s}`;
    const created = await v.ok(v.admin("POST", "/api/admin/preipo", { id: P, name: "Test Co (pre-IPO)", price: "50" }));
    expect(created.mark).toBe("50");
    const [alice, bob, carol] = await Promise.all(["al", "bo", "ca"].map((p) => v.user(`${p}${s}`)));

    await order(alice!, { market: P, side: "buy", price: "48", size: "10" });
    expect(await mark(P)).toBe("50"); // one side, no trade yet: the seed
    await order(bob!, { market: P, side: "sell", price: "53", size: "5" });
    expect(await mark(P)).toBe("50"); // median(48, 53, seed 50)
    const fill = await order(carol!, { market: P, side: "buy", price: "53", size: "5" });
    expect(fill.status).toBe("filled");
    expect(await mark(P)).toBe("53"); // the ask is gone: last trade
    await order(bob!, { market: P, side: "sell", price: "60", size: "1" });
    expect(await mark(P)).toBe("53"); // median(48, 60, 53)
    const bid = await order(alice!, { market: P, side: "buy", price: "55", size: "1" });
    expect(await mark(P)).toBe("55"); // median(55, 60, 53)
    await v.ok(v.as(alice!, "DELETE", `/api/orders/${bid.order.id}`));
    expect(await mark(P)).toBe("53"); // the cancel moved it back
    expect(await v.invariants()).toEqual([]);
  });

  it("an IPO gaps the mark to the public price and charges the shortfall to the other side", async () => {
    const s = uid();
    const P = `IPO${s}`;
    await v.ok(v.admin("POST", "/api/admin/preipo", { id: P, name: "Gap Co (pre-IPO)", price: "100", description: "test" }));
    const [alice, bob, carol] = await Promise.all(["al", "bo", "ca"].map((p) => v.user(`${p}${s}`)));
    await order(alice!, { market: P, side: "buy", price: "100", size: "20", leverage: 3 }); // $2,000 long at 3×: $666.67
    await order(bob!, { market: P, side: "sell", price: "100", size: "10" });
    await order(carol!, { market: P, side: "sell", price: "100", size: "10" });
    expect(await mark(P)).toBe("100");

    expect((await v.admin("POST", "/api/admin/price", { market: P, price: "80" })).status).toBe(400); // book-priced until the IPO
    const { effects } = await v.ok(v.admin("POST", "/api/admin/ipo", { market: P, price: "50" }));
    expect(effects).toEqual(expect.arrayContaining(["bankrupt", "haircut"]));
    const m = await market(P);
    expect(m.mark).toBe("50");
    expect(m.source).toEqual({ kind: "manual", label: "admin-set public price" });
    expect(m.preipo).toMatchObject({ status: "public", ipoPrice: "50", impliedValuation: "50000000000.00" });
    expect(m.preipo.ipoAt).toEqual(expect.any(Number));

    // alice loses her $666.67; the $333.33 shortfall comes out of bob's and carol's profit, and the feed says so
    const feed = (await v.ok(v.call("GET", `/api/feed?market=${P}`))) as { kind: string; accounts: string[]; amount: string | null; price: string | null }[];
    const ipo = feed.find((r) => r.kind === "ipo")!;
    expect(ipo).toMatchObject({ amount: "333.333333333", price: "50" });
    expect(ipo.accounts.sort()).toEqual([alice!.id, bob!.id, carol!.id].sort());
    const haircuts = feed.filter((r) => r.kind === "haircut");
    expect(haircuts.map((r) => r.accounts[0]).sort()).toEqual([bob!.id, carol!.id].sort());
    expect(haircuts.every((r) => r.price === "50")).toBe(true);
    expect((await v.account(bob!)).ledger.adlPaid).toBe("166.666666667");
    expect(await v.invariants()).toEqual([]);

    expect((await v.admin("POST", "/api/admin/ipo", { market: P, price: "60" })).status).toBe(400); // once only
    await v.ok(v.admin("POST", "/api/admin/price", { market: P, price: "55", holdSeconds: 0 })); // an ordinary admin-priced perp now
    expect(await mark(P)).toBe("55");
  });
});
