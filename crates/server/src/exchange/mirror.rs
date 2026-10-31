// Mirrored liquidity: the bot maker posts a venue's real order book (Hyperliquid's top levels) into ours, and the
// mark moves to that book's mid in the same step. Users then trade against real depth and real spreads with paper
// money, and still match each other: the mirrored levels are ordinary maker orders in our book.
//
// Each mirror replaces the maker's orders in that market. The new levels go in as limit orders that can take
// liquidity, so when the real market moves through a user's resting order, that order fills at its own price, as it
// would have on the venue. A user's fill against a mirrored level doesn't consume the venue's liquidity: the next
// mirror posts the venue's book again as it is.
//
// The feed polls the venue (feeds.rs) and submits each poll as one `depth` command, so the core stays a function
// of its journal. While a market is held by an admin price override, or the bots are off, its mirror only moves
// the mark (and the hold ignores even that); the maker's ladder (bots.rs) quotes whenever the mirror is stale.

use super::*;

/// One price level as the venue shows it: coin price and size in coins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Level(pub Dec, pub Dec);

/// A venue's order book for one market, best levels first.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DepthBook {
    pub market: String,
    pub bids: Vec<Level>,
    pub asks: Vec<Level>,
}

/// How long a mirror stands in for the maker's ladder after it was posted.
pub const MIRROR_FRESH_MS: i64 = 15_000;

/// Levels per side the feed sends (and the core posts at most).
pub const MIRROR_LEVELS: usize = 10;

impl Exchange {
    /// Is this market's liquidity the venue's mirrored book right now (rather than the maker's ladder)?
    pub fn mirroring(&self, market: &str) -> bool {
        self.markets.get(market).is_some_and(|m| {
            m.mirrored_at
                .is_some_and(|t| self.now() - t < MIRROR_FRESH_MS)
                && m.held_until.is_none_or(|until| self.now() >= until)
        })
    }

    /// Post a venue's book through the bot maker (when the bots are on and no admin hold is active), then move the
    /// mark to the book's mid. Liquidation and ADL run in the mark's transition, as for any feed tick.
    pub fn mirror(&mut self, book: &DepthBook) -> XResult<()> {
        let now = self.now();
        let meta = self.market(&book.market)?;
        if !matches!(meta.source, Source::Hyperliquid { .. }) {
            return Err(ExError::bad(format!(
                "{} doesn't mirror a venue's book",
                book.market
            )));
        }
        let (Some(bid), Some(ask)) = (book.bids.first(), book.asks.first()) else {
            return Err(ExError::bad(format!("{}: one-sided book", book.market)));
        };
        if bid.0.nano() <= 0 || bid.0 >= ask.0 {
            return Err(ExError::bad(format!("{}: crossed book", book.market)));
        }
        let mid = (bid.0.nano() + ask.0.nano()) / 2;
        let held = meta.held_until.is_some_and(|until| now < until);
        let m = &self.state.markets[&book.market];
        let quotable = m.status == Status::Open && m.mark.is_some();
        if quotable && !held && self.bots_enabled && self.accounts.contains_key(crate::bots::MM) {
            self.post_mirror(book);
        }
        self.tick(&book.market, mid, false)?;
        Ok(())
    }

    /// Replace the maker's orders in the market with the venue's levels (snapped to our tick, bids down and asks
    /// up, so the book never crosses), best level of each side first. A level the maker can't post is skipped.
    fn post_mirror(&mut self, book: &DepthBook) {
        let id = book.market.as_str();
        let (sz, tick) = {
            let meta = &self.markets[id];
            (meta.sz_decimals, meta.tick)
        };
        let lot_coins = pow10(9 - sz.min(9)); // nano-coins per lot
        let snap = |levels: &[Level], up: bool| -> Vec<(i128, i128)> {
            let mut out: Vec<(i128, i128)> = vec![];
            for Level(px, size) in levels.iter().take(MIRROR_LEVELS) {
                let (px, size) = (px.nano(), size.nano());
                let floor = px.div_euclid(tick) * tick;
                let price = if up && floor != px {
                    floor + tick
                } else {
                    floor
                };
                let lots = size / lot_coins;
                if price <= 0 || lots <= 0 {
                    continue;
                }
                match out.last_mut() {
                    Some(last) if last.0 == price => last.1 += lots,
                    _ => out.push((price, lots)),
                }
            }
            out
        };
        let bids = snap(&book.bids, false);
        let asks = snap(&book.asks, true);
        let lev = leverage_now(&self.state.markets[id]).0;

        self.drop_orders(crate::bots::MM, Some(id));
        // Enough wallet for every level's margin at the maker's leverage, in whole millions of paper dollars.
        let margin: i128 = bids
            .iter()
            .chain(&asks)
            .map(|&(price, lots)| ceil_div(lots * lot_price(sz, price), lev))
            .sum();
        // On top of what its orders elsewhere hold back (exchange::reserved).
        let floor = self.reserved(crate::bots::MM) + margin + 500_000 * impulse_engine::fixed::ONE;
        let wallet = self.wallet(crate::bots::MM);
        if wallet < floor {
            let million = 1_000_000 * impulse_engine::fixed::ONE;
            let top_up = ceil_div(floor - wallet, million) * million;
            let _ = self.deposit(crate::bots::MM, Dec::from_nano(top_up));
        }
        for i in 0..bids.len().max(asks.len()) {
            for (side, level) in [(Side::Buy, bids.get(i)), (Side::Sell, asks.get(i))] {
                let Some(&(price, lots)) = level else {
                    continue;
                };
                let input = OrderInput {
                    leverage: Some(lev as f64),
                    tif: Some(Tif::Gtc),
                    ..OrderInput::limit(id, side, Dec::from_nano(price), coins_dec(sz, lots))
                };
                let _ = self.place_order(crate::bots::MM, &input);
            }
        }
        if let Some(m) = self.markets.get_mut(id) {
            m.mirrored_at = Some(self.now);
        }
        self.version += 1;
    }
}
