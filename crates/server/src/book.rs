// Central limit order book for one market: price-time priority, prices in nano-USD per lot, sizes in lots.
// The book only holds resting orders. Matching, margin and settlement live in the exchange, which turns every
// match into an engine trade.

use impulse_engine::ser::big;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Buy,
    Sell,
}

impl Side {
    pub fn opposite(self) -> Side {
        match self {
            Side::Buy => Side::Sell,
            Side::Sell => Side::Buy,
        }
    }
    pub fn dir(self) -> i128 {
        match self {
            Side::Buy => 1,
            Side::Sell => -1,
        }
    }
}

/// good-til-cancel, immediate-or-cancel, add-liquidity-only (post-only)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tif {
    Gtc,
    Ioc,
    Alo,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub id: u64, // monotonic, so it doubles as time priority
    pub account: String,
    pub market: String,
    pub side: Side,
    #[serde(with = "big")]
    pub price: i128, // limit, nano-USD per lot
    #[serde(with = "big")]
    pub size: i128, // remaining lots
    #[serde(with = "big")]
    pub filled: i128,
    #[serde(with = "big")]
    pub leverage: i128,
    pub reduce_only: bool,
    pub tif: Tif,
    pub time: i64, // wall-clock ms
}

pub struct Level {
    pub price: i128,
    pub size: i128,
    pub orders: usize,
}

#[derive(Default, Clone, Debug, Serialize, Deserialize)]
pub struct Book {
    pub bids: Vec<Order>, // best (highest) first
    pub asks: Vec<Order>, // best (lowest) first
}

impl Book {
    pub fn side(&self, s: Side) -> &Vec<Order> {
        match s {
            Side::Buy => &self.bids,
            Side::Sell => &self.asks,
        }
    }

    fn side_mut(&mut self, s: Side) -> &mut Vec<Order> {
        match s {
            Side::Buy => &mut self.bids,
            Side::Sell => &mut self.asks,
        }
    }

    /// Insert behind every order at the same or a better price.
    pub fn add(&mut self, o: Order) {
        let side = o.side;
        let arr = self.side_mut(side);
        let i = arr
            .iter()
            .position(|x| {
                if side == Side::Buy {
                    x.price < o.price
                } else {
                    x.price > o.price
                }
            })
            .unwrap_or(arr.len());
        arr.insert(i, o);
    }

    pub fn remove(&mut self, id: u64) -> Option<Order> {
        for arr in [&mut self.bids, &mut self.asks] {
            if let Some(i) = arr.iter().position(|x| x.id == id) {
                return Some(arr.remove(i));
            }
        }
        None
    }

    pub fn get_mut(&mut self, id: u64) -> Option<&mut Order> {
        self.bids
            .iter_mut()
            .chain(self.asks.iter_mut())
            .find(|o| o.id == id)
    }

    pub fn best(&self, s: Side) -> Option<&Order> {
        self.side(s).first()
    }

    /// Would an order on `side` at `price` take liquidity?
    pub fn crosses(&self, side: Side, price: i128) -> bool {
        match self.best(side.opposite()) {
            Some(top) => {
                if side == Side::Buy {
                    top.price <= price
                } else {
                    top.price >= price
                }
            }
            None => false,
        }
    }

    pub fn levels(&self, s: Side, depth: usize) -> Vec<Level> {
        let mut out: Vec<Level> = vec![];
        for o in self.side(s) {
            if let Some(last) = out.last_mut() {
                if last.price == o.price {
                    last.size += o.size;
                    last.orders += 1;
                    continue;
                }
            }
            if out.len() == depth {
                break;
            }
            out.push(Level {
                price: o.price,
                size: o.size,
                orders: 1,
            });
        }
        out
    }

    pub fn orders(&self) -> impl Iterator<Item = &Order> {
        self.bids.iter().chain(self.asks.iter())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(id: u64, side: Side, price: i128) -> Order {
        Order {
            id,
            account: "a".into(),
            market: "X".into(),
            side,
            price,
            size: 1,
            filled: 0,
            leverage: 1,
            reduce_only: false,
            tif: Tif::Gtc,
            time: 0,
        }
    }

    #[test]
    fn keeps_price_time_priority_and_aggregates_levels() {
        let mut b = Book::default();
        for (id, side, price) in [
            (1, Side::Buy, 10),
            (2, Side::Buy, 12),
            (3, Side::Buy, 10),
            (4, Side::Sell, 15),
            (5, Side::Sell, 14),
        ] {
            b.add(o(id, side, price));
        }
        assert_eq!(b.bids.iter().map(|x| x.id).collect::<Vec<_>>(), [2, 1, 3]);
        assert_eq!(b.asks.iter().map(|x| x.id).collect::<Vec<_>>(), [5, 4]);
        let levels: Vec<_> = b
            .levels(Side::Buy, 5)
            .into_iter()
            .map(|l| (l.price, l.size, l.orders))
            .collect();
        assert_eq!(levels, [(12, 1, 1), (10, 2, 2)]);
        assert!(b.crosses(Side::Buy, 14));
        assert!(!b.crosses(Side::Buy, 13));
        assert_eq!(b.remove(1).map(|x| x.id), Some(1));
        assert!(b.remove(1).is_none());
    }
}
