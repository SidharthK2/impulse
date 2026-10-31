// Pre-IPO markets: the mark is the market's own book until an admin IPO gaps it to a public price.

use super::*;

impl Exchange {
    /// A pre-IPO mark from the market's own book: the median of best bid, best ask and last trade; the last trade
    /// if a side of the book is empty; the seed price before the first trade. Lot price.
    pub fn book_mark(&self, market: &str) -> Option<i128> {
        let meta = self.markets.get(market)?;
        let seed = lot_price(meta.sz_decimals, meta.preipo.as_ref()?.seed);
        let last = self.state.markets.get(market)?.last_trade.unwrap_or(seed);
        let book = self.books.get(market)?;
        Some(match (book.best(Side::Buy), book.best(Side::Sell)) {
            (Some(bid), Some(ask)) => {
                let mut v = [bid.price, ask.price, last];
                v.sort_unstable();
                v[1]
            }
            _ => last,
        })
    }

    /// Move a book-priced market's mark to its book (liquidation and ADL run in that transaction). Liquidations
    /// cancel orders, which can move the book again, so repeat until it settles.
    pub(super) fn reprice(&mut self, market: &str) -> XResult<Vec<Effect>> {
        let mut effects = vec![];
        for _ in 0..4 {
            if self
                .markets
                .get(market)
                .is_none_or(|m| m.source != Source::Book)
                || self.state.markets[market].status != Status::Open
            {
                break;
            }
            let Some(lot) = self.book_mark(market) else {
                break;
            };
            if Some(lot.max(1)) == self.state.markets[market].mark {
                break;
            }
            effects.extend(self.commit(&[Event::Tick {
                market: market.into(),
                price: dec(lot.max(1)).into(),
            }])?);
            self.candle(market, lot.max(1), 0, None);
        }
        Ok(effects)
    }

    /// Admin IPO: the market leaves its book for an admin-set public price. The mark gaps to it, and liquidation
    /// and ADL run in that transaction.
    pub fn ipo(&mut self, market: &str, price: Dec) -> XResult<Vec<Effect>> {
        let meta = self.market(market)?;
        if meta.preipo.is_none() {
            return Err(ExError::bad(format!("{market} is not a pre-IPO market")));
        }
        if meta.source != Source::Book {
            return Err(ExError::bad(format!("{market} has already had its IPO")));
        }
        let sz = meta.sz_decimals;
        let coin = price.nano();
        if coin <= 0 {
            return Err(ExError::bad("price must be positive"));
        }
        let before = self.mark_str(market);
        let lot = lot_price(sz, coin).max(1);
        let effects = if Some(lot) == self.state.markets[market].mark {
            vec![]
        } else {
            self.commit(&[Event::Tick {
                market: market.into(),
                price: dec(lot).into(),
            }])?
        };
        self.candle(market, lot, 0, None);
        let now = self.now();
        let m = self.market_mut(market)?;
        m.source = Source::Manual;
        if let Some(p) = m.preipo.as_mut() {
            p.ipo_at = Some(now);
            p.ipo_price = Some(coin);
        }
        let mut hit: Vec<String> = vec![];
        let mut busted = BTreeSet::new(); // positions, not effects: a partial book liquidation can precede the backstop
        let mut shortfall = 0;
        for e in &effects {
            match e {
                Effect::Liquidation { account, .. } | Effect::BookLiquidation { account, .. } => {
                    busted.insert(account.clone());
                    hit.push(account.clone());
                }
                Effect::Bankrupt {
                    account,
                    shortfall: s,
                    ..
                } => {
                    busted.insert(account.clone());
                    shortfall += s;
                    hit.push(account.clone());
                }
                Effect::Haircut { account, .. } => hit.push(account.clone()),
                _ => {}
            }
        }
        let busts = busted.len();
        let mut seen = BTreeSet::new();
        hit.retain(|a| seen.insert(a.clone()));
        let paid = if shortfall > 0 {
            format!(
                "; ${} shortfall charged to the other side",
                cents(shortfall)
            )
        } else {
            String::new()
        };
        let text = format!(
            "{market} IPO at {}: mark gapped {before} → {}, {busts} position{} liquidated or bankrupt{paid}",
            fmt(coin, 0),
            self.mark_str(market),
            if busts == 1 { "" } else { "s" }
        );
        self.record(
            market,
            RiskKind::Ipo,
            hit,
            text,
            (shortfall > 0).then_some(shortfall),
        );
        Ok(effects)
    }
}
