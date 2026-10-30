// Matching, margin, risk and persistence through the HTTP API, run against every target in venue.ts (the TS
// server and the Rust server). Each test gets its own market and accounts, so the targets can be shared.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFixed } from "../../src/fixed.js";
import { type User, type Venue, targets, uid } from "./venue.js";

describe.each(targets())("exchange ($name)", ({ start }) => {
  let v: Venue;
  beforeAll(async () => {
    v = await start();
  });
  afterAll(() => v?.close());

  /** A manual-oracle perp at $100 (0.01-coin lots) and three accounts with $1,000 each. */
  async function setup() {
    const s = uid();
    const X = `X${s}`;
    await v.ok(v.admin("POST", "/api/test/market", { id: X, kind: "perp", price: "100", szDecimals: 2 }));
    const [alice, bob, carol] = await Promise.all(["al", "bo", "ca"].map((p) => v.user(`${p}${s}`, "1000")));
    return { X, s, alice: alice!, bob: bob!, carol: carol! };
  }

  const ok = (r: Promise<{ status: number; data: any }>) => v.ok(r); // eslint-disable-line @typescript-eslint/no-explicit-any
  const wallet = async (u: User) => (await v.account(u)).wallet as string;
  const position = async (u: User, market: string) => ((await v.account(u)).positions as { market: string }[]).find((p) => p.market === market) as Record<string, string> | undefined;
  const size = async (u: User, market: string) => (await position(u, market))?.size ?? "0";
  const collateral = async (u: User, market: string) => ((await ok(v.call("GET", `/api/markets/${encodeURIComponent(market)}/positions`))) as { account: string; collateral: string }[]).find((p) => p.account === u.id)?.collateral;
  const book = async (market: string) => (await ok(v.call("GET", `/api/markets/${encodeURIComponent(market)}`))).book;
  const fails = async (r: Promise<{ status: number; data: { error?: string } }>, re: RegExp) => {
    const { status, data } = await r;
    expect(status).toBe(400);
    expect(data.error).toMatch(re);
  };
  /** Everything the venue holds equals deposits minus withdrawals (the engine asserts it; double-check here). */
  const conserved = async () => expect(await v.invariants()).toEqual([]);

  describe("matching", () => {
    it("fills a market order against resting liquidity with auto-margin", async () => {
      const { X, alice, bob } = await setup();
      const rest = await ok(v.order(bob, { market: X, side: "sell", price: "100", size: "10" }));
      expect(rest.status).toBe("resting");
      const r = await ok(v.order(alice, { market: X, side: "buy", type: "market", size: "4", leverage: 2 }));
      expect(r.status).toBe("filled");
      expect(r.fills).toHaveLength(1);
      expect(await size(alice, X)).toBe("4");
      expect(await size(bob, X)).toBe("-4");
      // alice posted $400 / 2× = $200; bob's resting order defaults to the market max (3×): $133.34
      expect(await wallet(alice)).toBe("800.00");
      expect(await collateral(bob, X)).toBe("133.333333334");
      expect((await book(X)).asks).toEqual([{ price: "100", size: "6", orders: 1 }]);
      await conserved();
    });

    it("walks the book and rests the remainder of a limit order", async () => {
      const { X, alice, bob, carol } = await setup();
      await ok(v.order(bob, { market: X, side: "sell", price: "100", size: "1" }));
      await ok(v.order(carol, { market: X, side: "sell", price: "101", size: "1" }));
      const r = await ok(v.order(alice, { market: X, side: "buy", price: "101", size: "3" }));
      expect(r.status).toBe("partial");
      expect(r.fills.map((f: { price: string }) => f.price)).toEqual(["100", "101"]);
      expect((await book(X)).bids).toEqual([{ price: "101", size: "1", orders: 1 }]);
    });

    it("rejects off-tick prices, post-only crosses and unaffordable orders", async () => {
      const { X, alice, bob } = await setup();
      await ok(v.order(bob, { market: X, side: "sell", price: "100", size: "1" }));
      await fails(v.order(alice, { market: X, side: "buy", price: "100.0001", size: "1" }), /tick/);
      await fails(v.order(alice, { market: X, side: "buy", price: "100", size: "1", tif: "alo" }), /post-only/);
      expect((await ok(v.order(alice, { market: X, side: "buy", price: "99", size: "1", tif: "alo" }))).status).toBe("resting");
      await fails(v.order(alice, { market: X, side: "buy", price: "99", size: "100", leverage: 1 }), /insufficient/);
    });

    it("cancels the resting side on a self-trade and a maker that can't afford its fill", async () => {
      const { X, alice, bob } = await setup();
      await ok(v.order(alice, { market: X, side: "sell", price: "100", size: "1" }));
      const self = await ok(v.order(alice, { market: X, side: "buy", price: "100", size: "1" }));
      expect(self.fills).toHaveLength(0);
      expect((await book(X)).asks).toEqual([]);
      expect(self.status).toBe("resting");

      await ok(v.as(alice, "POST", "/api/orders/cancel-all", {}));
      await ok(v.order(bob, { market: X, side: "sell", price: "100", size: "25", leverage: 3 })); // needs ~$834
      await ok(v.as(bob, "POST", "/api/withdraw", { amount: "900" })); // now bob can't post it
      const r = await ok(v.order(alice, { market: X, side: "buy", type: "market", size: "25" }));
      expect(r.status).toBe("cancelled");
      expect(r.fills).toHaveLength(0);
      expect((await v.account(bob)).orders).toHaveLength(0); // the maker that couldn't post margin lost its order
      expect(await wallet(bob)).toBe("100.00"); // and its failed allocation never committed
    });

    it("closes with reduce-only and returns collateral to the wallet", async () => {
      const { X, alice, bob, carol } = await setup();
      await ok(v.order(bob, { market: X, side: "sell", price: "100", size: "5" }));
      await ok(v.order(alice, { market: X, side: "buy", type: "market", size: "2" }));
      await fails(v.order(alice, { market: X, side: "buy", type: "market", size: "1", reduceOnly: true }), /reduce/);
      await ok(v.order(carol, { market: X, side: "buy", price: "100", size: "5" }));
      const r = await ok(v.order(alice, { market: X, side: "sell", type: "market", size: "9", reduceOnly: true }));
      expect(r.fills.reduce((sum: number, f: { size: string }) => sum + Number(f.size), 0)).toBe(2); // capped at the position
      expect(await size(alice, X)).toBe("0");
      expect(await collateral(alice, X)).toBeUndefined(); // flat, and the bucket is empty
      expect(await wallet(alice)).toBe("1000.00");
      await conserved();
    });
  });

  describe("risk through the venue", () => {
    it("a gap bankrupts the long, charges the shorts and records who paid", async () => {
      const { X, alice, bob, carol } = await setup();
      await ok(v.order(bob, { market: X, side: "sell", price: "100", size: "10" }));
      await ok(v.order(carol, { market: X, side: "sell", price: "100", size: "10" }));
      await ok(v.order(alice, { market: X, side: "buy", type: "market", size: "20", leverage: 3 })); // $2,000 at 3×: $666.67
      await ok(v.order(alice, { market: X, side: "buy", price: "90", size: "1" })); // resting order, cancelled on bankruptcy

      const { effects } = await ok(v.admin("POST", "/api/admin/price", { market: X, price: "50", holdSeconds: 0 }));
      expect(effects).toContain("bankrupt");
      expect(effects).toContain("haircut");
      expect(await size(alice, X)).toBe("0");
      expect(await size(bob, X)).toBe("0");
      expect((await v.account(alice)).orders).toHaveLength(0);

      // alice loses her $666.67 bucket; the $333.33 shortfall comes out of the shorts' $1,000 profit
      const feed = (await ok(v.call("GET", `/api/feed?market=${X}`))) as { kind: string; amount: string | null }[];
      expect(feed.map((r) => r.kind)).toEqual(expect.arrayContaining(["bankrupt", "haircut", "adl", "gap"]));
      expect(feed.find((r) => r.kind === "bankrupt")!.amount).toBe("333.333333333");
      const acct = await v.account(bob);
      expect(acct.risk.map((r: { kind: string }) => r.kind)).toEqual(expect.arrayContaining(["haircut", "adl"]));
      // Everyone is flat, so all collateral is back in wallets and conservation is exact.
      const total = (await Promise.all([alice, bob, carol].map(wallet))).reduce((sum, w) => sum + parseFixed(w), 0n);
      expect(total).toBe(parseFixed("3000"));
      await conserved();
    });

    it("holds the feed during an admin override, then lets it back in", async () => {
      const { X } = await setup();
      await ok(v.admin("POST", "/api/admin/price", { market: X, price: "120", holdSeconds: 30 }));
      expect((await ok(v.admin("POST", "/api/test/tick", { market: X, price: "100" }))).effects).toBeNull();
      expect((await ok(v.call("GET", `/api/markets/${X}`))).market.mark).toBe("120");
      await ok(v.admin("POST", "/api/test/advance", { ms: 31_000 }));
      await ok(v.admin("POST", "/api/test/tick", { market: X, price: "100" }));
      expect((await ok(v.call("GET", `/api/markets/${X}`))).market.mark).toBe("100");
    });

    it("the clock accrues funding and an attention curve moves its own mark", async () => {
      const { X, s, alice, bob, carol } = await setup();
      const P = `@p${s}`;
      const m = await ok(v.admin("POST", "/api/test/market", { id: P, kind: "attention", source: { kind: "curve" } }));
      expect(m.mark).toBe("0.000005");
      await ok(v.as(carol, "POST", "/api/spot/buy", { market: P, usdc: "500" }));
      const after = await ok(v.call("GET", `/api/markets/${encodeURIComponent(P)}`));
      expect(Number(after.market.mark)).toBeGreaterThan(0.000005);
      expect(after.trades[0].kind).toBe("spot");

      await ok(v.order(bob, { market: X, side: "sell", price: "100", size: "5" }));
      await ok(v.order(alice, { market: X, side: "buy", type: "market", size: "5" }));
      await ok(v.admin("POST", "/api/test/advance", { ms: 3_600_000 }));
      expect(Number((await position(alice, X))!.funding)).toBeLessThan(0); // longs pay the launch base rate
      expect(Number((await position(bob, X))!.funding)).toBeGreaterThan(0);
      await conserved();
    });

    it("resolves a binary and settles every position", async () => {
      const { s, alice, bob } = await setup();
      const B = `B${s}`;
      await ok(v.admin("POST", "/api/test/market", { id: B, kind: "binary", price: "0.4" }));
      await ok(v.order(bob, { market: B, side: "sell", price: "0.4", size: "100" }));
      await ok(v.order(alice, { market: B, side: "buy", type: "market", size: "100", leverage: 1 }));
      expect(await collateral(alice, B)).toBe("42.00"); // 1× on a long = its full max loss, plus a 5% buffer
      await ok(v.admin("POST", "/api/admin/resolve", { market: B, price: "0" }));
      const after = await ok(v.call("GET", `/api/markets/${B}`));
      expect(after.market.status).toBe("resolved");
      expect(await wallet(alice)).toBe("960.00"); // bought at 0.40, settled at 0
      expect(await wallet(bob)).toBe("1040.00");
      expect(after.book.asks).toEqual([]);
      await conserved();
    });
  });

  describe("snapshot", () => {
    it("round-trips the whole exchange", async () => {
      const { X, alice, bob, carol } = await setup();
      await ok(v.order(bob, { market: X, side: "sell", price: "101", size: "3" }));
      await ok(v.order(carol, { market: X, side: "sell", price: "100", size: "3" }));
      await ok(v.order(alice, { market: X, side: "buy", type: "market", size: "1" }));
      const bookBefore = await book(X);
      const acctBefore = await v.account(alice);
      expect((await ok(v.admin("POST", "/api/test/reload", { downMs: 0 }))).identical).toBe(true);
      expect(await book(X)).toEqual(bookBefore);
      expect(await v.account(alice)).toEqual(acctBefore); // and the API key still works
      // downtime is a pause: engine time resumes where it stopped
      const t0 = (await ok(v.call("GET", "/api/health"))).engineTime;
      expect((await ok(v.admin("POST", "/api/test/reload", { downMs: 3_600_000 }))).effects).toEqual([]);
      await ok(v.admin("POST", "/api/test/advance", { ms: 5_000 }));
      expect((await ok(v.call("GET", "/api/health"))).engineTime).toBe(t0 + 5);
      // and it still trades
      await ok(v.order(alice, { market: X, side: "buy", type: "market", size: "2" }));
      expect(await size(alice, X)).toBe("3");
    });
  });
});
