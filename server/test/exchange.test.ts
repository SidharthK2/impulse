import { describe, expect, it } from "vitest";
import { checkInvariants } from "../../src/engine.js";
import { parseFixed as usd } from "../../src/fixed.js";
import { Book, type Order } from "../src/book.js";
import { Exchange, type MarketSpec } from "../src/exchange.js";
import { deserialize, serialize } from "../src/persist.js";
import { autoTick, coinsFromLots, fmtScaled, lotPrice, lotsFromCoins, nanoFromFeed, parseScaled } from "../src/units.js";
import { accountView, bookView, marketView } from "../src/views.js";

function setup(spec: Partial<MarketSpec> = {}) {
  let t = 1_000_000;
  const x = new Exchange({ now: () => t, genesis: t });
  x.createMarket({ id: "X", kind: "perp", source: { kind: "manual" }, price: "100", szDecimals: 2, ...spec });
  for (const [id, amt] of [
    ["alice", "1000"],
    ["bob", "1000"],
    ["carol", "1000"],
  ] as const) {
    x.createAccount(id);
    x.deposit(id, amt);
  }
  return { x, advance: (ms: number) => (t += ms) };
}

const wallet = (x: Exchange, id: string) => x.state.accounts[id]!.wallet;
const size = (x: Exchange, id: string, m = "X") => x.state.markets[m]!.positions[id]?.size ?? 0n;
/** Everything the venue holds equals deposits minus withdrawals (the engine asserts it; double-check here). */
const conserved = (x: Exchange) => expect(checkInvariants(x.state)).toEqual([]);

describe("units", () => {
  it("round-trips scaled decimals", () => {
    expect(parseScaled("1.25", 2)).toBe(125n);
    expect(parseScaled("3", 0)).toBe(3n);
    expect(() => parseScaled("1.234", 2)).toThrow();
    expect(fmtScaled(125n, 2)).toBe("1.25");
    expect(fmtScaled(-5n, 3)).toBe("-0.005");
  });
  it("converts coins ↔ lots and prices per coin ↔ per lot", () => {
    const btc = { szDecimals: 5 };
    expect(lotsFromCoins(btc, "0.01")).toBe(1000n);
    expect(coinsFromLots(btc, 1000n)).toBe("0.01");
    expect(lotPrice(btc, usd("80000"))).toBe(usd("0.8"));
  });
  it("picks a five-significant-figure tick", () => {
    expect(autoTick(usd("80711.5"), 5)).toBe(usd("1"));
    expect(autoTick(usd("0.004397"), 0)).toBe(100n);
    expect(autoTick(usd("0.000005"), 0)).toBe(1n);
  });
  it("reads feed floats and strings", () => {
    expect(nanoFromFeed("0.7975")).toBe(797_500_000n);
    expect(nanoFromFeed(1.5)).toBe(1_500_000_000n);
  });
});

describe("book", () => {
  const o = (id: number, side: "buy" | "sell", price: bigint): Order => ({ id, account: "a", market: "X", side, price, size: 1n, filled: 0n, leverage: 1n, reduceOnly: false, tif: "gtc", time: 0 });
  it("keeps price-time priority and aggregates levels", () => {
    const b = new Book();
    b.add(o(1, "buy", 10n));
    b.add(o(2, "buy", 12n));
    b.add(o(3, "buy", 10n));
    b.add(o(4, "sell", 15n));
    b.add(o(5, "sell", 14n));
    expect(b.bids.map((x) => x.id)).toEqual([2, 1, 3]);
    expect(b.asks.map((x) => x.id)).toEqual([5, 4]);
    expect(b.levels("buy", 5)).toEqual([
      { price: 12n, size: 1n, orders: 1 },
      { price: 10n, size: 2n, orders: 2 },
    ]);
    expect(b.crosses("buy", 14n)).toBe(true);
    expect(b.crosses("buy", 13n)).toBe(false);
  });
});

describe("matching", () => {
  it("fills a market order against resting liquidity with auto-margin", () => {
    const { x } = setup();
    const rest = x.placeOrder("bob", { market: "X", side: "sell", type: "limit", price: "100", size: "10" });
    expect(rest.status).toBe("resting");
    const r = x.placeOrder("alice", { market: "X", side: "buy", type: "market", size: "4", leverage: 2 });
    expect(r.status).toBe("filled");
    expect(r.fills).toHaveLength(1);
    expect(size(x, "alice")).toBe(400n); // 4 coins in 0.01 lots
    expect(size(x, "bob")).toBe(-400n);
    // alice posted $400 / 2× = $200; bob's resting order defaults to the market max (3×): $133.34
    expect(wallet(x, "alice")).toBe(usd("800"));
    expect(x.state.markets.X!.positions.bob!.collateral).toBe(usd("133.333333334"));
    expect(bookView(x, "X").asks).toEqual([{ price: "100", size: "6", orders: 1 }]);
    conserved(x);
  });

  it("walks the book and rests the remainder of a limit order", () => {
    const { x } = setup();
    x.placeOrder("bob", { market: "X", side: "sell", type: "limit", price: "100", size: "1" });
    x.placeOrder("carol", { market: "X", side: "sell", type: "limit", price: "101", size: "1" });
    const r = x.placeOrder("alice", { market: "X", side: "buy", type: "limit", price: "101", size: "3" });
    expect(r.status).toBe("partial");
    expect(r.fills.map((f) => f.price)).toEqual([usd("1"), usd("1.01")]); // lot prices (0.01 coin lots)
    expect(bookView(x, "X").bids).toEqual([{ price: "101", size: "1", orders: 1 }]);
  });

  it("rejects off-tick prices, post-only crosses and unaffordable orders", () => {
    const { x } = setup();
    x.placeOrder("bob", { market: "X", side: "sell", type: "limit", price: "100", size: "1" });
    expect(() => x.placeOrder("alice", { market: "X", side: "buy", type: "limit", price: "100.0001", size: "1" })).toThrow(/tick/);
    expect(() => x.placeOrder("alice", { market: "X", side: "buy", type: "limit", price: "100", size: "1", tif: "alo" })).toThrow(/post-only/);
    expect(x.placeOrder("alice", { market: "X", side: "buy", type: "limit", price: "99", size: "1", tif: "alo" }).status).toBe("resting");
    expect(() => x.placeOrder("alice", { market: "X", side: "buy", type: "limit", price: "99", size: "100", leverage: 1 })).toThrow(/insufficient/);
  });

  it("cancels the resting side on a self-trade and a maker that can't afford its fill", () => {
    const { x } = setup();
    x.placeOrder("alice", { market: "X", side: "sell", type: "limit", price: "100", size: "1" });
    const self = x.placeOrder("alice", { market: "X", side: "buy", type: "limit", price: "100", size: "1" });
    expect(self.fills).toHaveLength(0);
    expect(bookView(x, "X").asks).toEqual([]);
    expect(self.status).toBe("resting");

    x.cancelAll("alice");
    x.placeOrder("bob", { market: "X", side: "sell", type: "limit", price: "100", size: "25", leverage: 3 }); // needs ~$834
    x.withdraw("bob", "900"); // now bob can't post it
    const r = x.placeOrder("alice", { market: "X", side: "buy", type: "market", size: "25" });
    expect(r.status).toBe("cancelled");
    expect(r.fills).toHaveLength(0);
    expect(x.ordersOf("bob")).toHaveLength(0); // the maker that couldn't post margin lost its order
    expect(wallet(x, "bob")).toBe(usd("100")); // and its failed allocation never committed
  });

  it("closes with reduce-only and returns collateral to the wallet", () => {
    const { x } = setup();
    x.placeOrder("bob", { market: "X", side: "sell", type: "limit", price: "100", size: "5" });
    x.placeOrder("alice", { market: "X", side: "buy", type: "market", size: "2" });
    expect(() => x.placeOrder("alice", { market: "X", side: "buy", type: "market", size: "1", reduceOnly: true })).toThrow(/reduce/);
    x.placeOrder("carol", { market: "X", side: "buy", type: "limit", price: "100", size: "5" });
    const r = x.placeOrder("alice", { market: "X", side: "sell", type: "market", size: "9", reduceOnly: true });
    expect(r.fills.reduce((s, f) => s + f.size, 0n)).toBe(200n); // capped at the position
    expect(size(x, "alice")).toBe(0n);
    expect(x.state.markets.X!.positions.alice!.collateral).toBe(0n);
    expect(wallet(x, "alice")).toBe(usd("1000"));
    conserved(x);
  });
});

describe("risk through the venue", () => {
  it("a gap bankrupts the long, charges the shorts and records who paid", () => {
    const { x } = setup();
    x.placeOrder("bob", { market: "X", side: "sell", type: "limit", price: "100", size: "10" });
    x.placeOrder("carol", { market: "X", side: "sell", type: "limit", price: "100", size: "10" });
    x.placeOrder("alice", { market: "X", side: "buy", type: "market", size: "20", leverage: 3 }); // $2,000 at 3×: $666.67
    x.placeOrder("alice", { market: "X", side: "buy", type: "limit", price: "90", size: "1" }); // resting order, cancelled on bankruptcy

    const effects = x.adminPrice("X", "50", 0);
    const kinds = effects.map((e) => e.kind);
    expect(kinds).toContain("bankrupt");
    expect(kinds).toContain("haircut");
    expect(size(x, "alice")).toBe(0n);
    expect(size(x, "bob")).toBe(0n);
    expect(x.ordersOf("alice")).toHaveLength(0);

    // alice loses her $666.67 bucket; the $333.33 shortfall comes out of the shorts' $1,000 profit
    const feed = x.risk.map((r) => r.kind);
    expect(feed).toEqual(expect.arrayContaining(["bankrupt", "haircut", "adl", "gap"]));
    const bankrupt = x.risk.find((r) => r.kind === "bankrupt")!;
    expect(bankrupt.amount).toBe("333.333333333");
    const acct = accountView(x, "bob");
    expect(acct.risk.map((r) => r.kind)).toEqual(expect.arrayContaining(["haircut", "adl"]));
    // Everyone is flat, so all collateral is back in wallets and conservation is exact.
    const total = ["alice", "bob", "carol"].reduce((s, id) => s + wallet(x, id), 0n);
    expect(total).toBe(usd("3000"));
    conserved(x);
  });

  it("holds the feed during an admin override, then lets it back in", () => {
    const { x, advance } = setup();
    x.adminPrice("X", "120", 30);
    expect(x.tick("X", usd("100"))).toBeNull();
    expect(marketView(x, "X").mark).toBe("120");
    advance(31_000);
    x.tick("X", usd("100"));
    expect(marketView(x, "X").mark).toBe("100");
  });

  it("the clock accrues funding and an attention curve moves its own mark", () => {
    const { x, advance } = setup();
    x.createMarket({ id: "@pump", kind: "attention", source: { kind: "curve" } });
    expect(marketView(x, "@pump").mark).toBe("0.000005");
    x.spotBuy("carol", "@pump", "500");
    expect(Number(marketView(x, "@pump").mark)).toBeGreaterThan(0.000005);
    expect(x.fills.at(-1)!.kind).toBe("spot");

    x.placeOrder("bob", { market: "X", side: "sell", type: "limit", price: "100", size: "5" });
    x.placeOrder("alice", { market: "X", side: "buy", type: "market", size: "5" });
    advance(3_600_000);
    x.clock();
    expect(x.state.markets.X!.positions.alice!.funding).toBeLessThan(0n); // longs pay the launch base rate
    expect(x.state.markets.X!.positions.bob!.funding).toBeGreaterThan(0n);
    conserved(x);
  });

  it("resolves a binary and settles every position", () => {
    const { x } = setup();
    x.createMarket({ id: "B", kind: "binary", source: { kind: "manual" }, price: "0.4" });
    x.placeOrder("bob", { market: "B", side: "sell", type: "limit", price: "0.4", size: "100" });
    x.placeOrder("alice", { market: "B", side: "buy", type: "market", size: "100", leverage: 1 });
    expect(x.state.markets.B!.positions.alice!.collateral).toBe(usd("42")); // 1× on a long = its full max loss, plus a 5% buffer
    x.resolve("B", "0");
    expect(marketView(x, "B").status).toBe("resolved");
    expect(wallet(x, "alice")).toBe(usd("960")); // bought at 0.40, settled at 0
    expect(wallet(x, "bob")).toBe(usd("1040"));
    expect(bookView(x, "B").asks).toEqual([]);
    conserved(x);
  });
});

describe("snapshot", () => {
  it("round-trips the whole exchange", () => {
    const { x } = setup();
    x.placeOrder("bob", { market: "X", side: "sell", type: "limit", price: "101", size: "3" });
    x.placeOrder("carol", { market: "X", side: "sell", type: "limit", price: "100", size: "3" });
    x.placeOrder("alice", { market: "X", side: "buy", type: "market", size: "1" });
    const y = Exchange.fromSnapshot(deserialize(serialize(x.toSnapshot())), { now: x.now });
    expect(serialize(y.toSnapshot())).toBe(serialize(x.toSnapshot()));
    expect(bookView(y, "X")).toEqual(bookView(x, "X"));
    expect(accountView(y, "alice")).toEqual(accountView(x, "alice"));
    expect(y.accountByKey(x.accounts.alice!.apiKey)?.id).toBe("alice");
    // downtime is a pause: engine time resumes where it stopped
    let later = x.now() + 3_600_000;
    const z = Exchange.fromSnapshot(deserialize(serialize(x.toSnapshot())), { now: () => later });
    z.resumeAfter(3_600_000);
    expect(z.clock()).toEqual([]);
    later += 5_000;
    z.clock();
    expect(z.state.time).toBe(x.state.time + 5n);
    // and it still trades
    y.placeOrder("alice", { market: "X", side: "buy", type: "market", size: "2" });
    expect(size(y, "alice")).toBe(300n);
  });
});
