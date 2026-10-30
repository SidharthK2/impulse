// Unit tests of the TS server's lot conversions and order book. The Rust server has the same tests in
// rs/server/src/units.rs and book.rs (`cargo test`).

import { describe, expect, it } from "vitest";
import { parseFixed as usd } from "../../src/fixed.js";
import { Book, type Order } from "../src/book.js";
import { autoTick, coinsFromLots, fmtScaled, lotPrice, lotsFromCoins, nanoFromFeed, parseScaled } from "../src/units.js";

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
