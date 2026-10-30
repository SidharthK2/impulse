// Central limit order book for one market: price-time priority, prices in nano-USD per lot, sizes in lots.
// The book only holds resting orders. Matching, margin and settlement live in the exchange, which turns every
// match into an engine trade.

export type Side = "buy" | "sell";
export type Tif = "gtc" | "ioc" | "alo"; // good-til-cancel, immediate-or-cancel, add-liquidity-only (post-only)

export interface Order {
  id: number; // monotonic, so it doubles as time priority
  account: string;
  market: string;
  side: Side;
  price: bigint; // limit, nano-USD per lot
  size: bigint; // remaining lots
  filled: bigint;
  leverage: bigint; // margin posted per fill = notional / leverage (capped at the market's max)
  reduceOnly: boolean;
  tif: Tif;
  time: number; // wall-clock ms
}

export interface Level {
  price: bigint;
  size: bigint;
  orders: number;
}

export class Book {
  bids: Order[] = []; // best (highest) first
  asks: Order[] = []; // best (lowest) first

  side(s: Side): Order[] {
    return s === "buy" ? this.bids : this.asks;
  }

  /** Insert behind every order at the same or a better price. */
  add(o: Order) {
    const arr = this.side(o.side);
    const worse = (x: Order) => (o.side === "buy" ? x.price < o.price : x.price > o.price);
    const i = arr.findIndex(worse);
    arr.splice(i < 0 ? arr.length : i, 0, o);
  }

  remove(o: Order): boolean {
    const arr = this.side(o.side);
    const i = arr.findIndex((x) => x.id === o.id);
    if (i < 0) return false;
    arr.splice(i, 1);
    return true;
  }

  best(s: Side): Order | undefined {
    return this.side(s)[0];
  }

  /** Would an order on `side` at `price` take liquidity? */
  crosses(side: Side, price: bigint): boolean {
    const top = this.best(side === "buy" ? "sell" : "buy");
    return top !== undefined && (side === "buy" ? top.price <= price : top.price >= price);
  }

  levels(s: Side, depth: number): Level[] {
    const out: Level[] = [];
    for (const o of this.side(s)) {
      const last = out[out.length - 1];
      if (last && last.price === o.price) {
        last.size += o.size;
        last.orders += 1;
      } else {
        if (out.length === depth) break;
        out.push({ price: o.price, size: o.size, orders: 1 });
      }
    }
    return out;
  }
}
