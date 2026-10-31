// Liquidation through the order book, ahead of the engine's backstop.
//
// Before an event that can move a mark (a feed tick, the clock, a curve trade, a launch's open) commits, the
// exchange runs it on a copy of the state to see which positions it would liquidate. Each of those positions first
// cancels its resting orders in that market and sends a reduce-only IOC order into the book: a partial liquidation,
// sized to close only what it takes for the rest of the position to meet initial margin at the new mark (all of it
// if nothing less will do). The order's limit is the position's bankruptcy price, so a liquidation through the
// book never leaves a shortfall, and it pays the market's liquidation fee instead of the taker fee. Each fill is an
// ordinary engine trade, checked like any other. Then the event itself commits, and the engine's own risk loop
// (close at mark against the other side, ADL for any shortfall) handles whatever is still distressed.
//
// A position the event would leave bankrupt (equity below zero at the new mark) skips the book: no fill at or
// better than its bankruptcy price exists at that mark, so the shortfall goes straight to ADL, as before.

use super::*;

/// Can this event move a mark, and so liquidate?
fn moves_marks(e: &Event) -> bool {
    matches!(
        e,
        Event::Tick { .. }
            | Event::Advance { .. }
            | Event::SpotBuy { .. }
            | Event::SpotSell { .. }
            | Event::Open { .. }
    )
}

impl Exchange {
    /// Liquidate through the book every position `events` would liquidate, before they commit. Returns what the
    /// engine did along the way.
    pub(super) fn liquidate_ahead(&mut self, events: &[Event]) -> XResult<Vec<Effect>> {
        if self.liquidating || !events.iter().any(moves_marks) {
            return Ok(vec![]);
        }
        let Some((after, effects)) = self.dry_run(events) else {
            return Ok(vec![]); // the events will be refused anyway
        };
        let mut seen = BTreeSet::new();
        let targets: Vec<(String, String)> = effects
            .iter()
            .filter_map(|e| match e {
                Effect::Liquidation {
                    market, account, ..
                } => Some((market.clone(), account.clone())),
                _ => None,
            })
            .filter(|t| seen.insert(t.clone()))
            .collect();
        if targets.is_empty() {
            return Ok(vec![]);
        }
        self.liquidating = true;
        let mut result = Ok(());
        for (market, account) in &targets {
            result = self.liquidate_through_book(market, account, &after.markets[market]);
            if result.is_err() {
                break;
            }
        }
        self.liquidating = false;
        let effects = std::mem::take(&mut self.liquidation_effects);
        result.map(|_| effects)
    }

    /// The state and effects `events` would produce, or None if one would be refused.
    fn dry_run(&self, events: &[Event]) -> Option<(State, Vec<Effect>)> {
        let mut state: Option<State> = None;
        let mut effects = vec![];
        for e in events {
            let (s, fx) = apply(state.as_ref().unwrap_or(&self.state), e).ok()?;
            state = Some(s);
            effects.extend(fx);
        }
        state.map(|s| (s, effects))
    }

    /// One position's liquidation order: cancel its orders here, then a reduce-only IOC for `liquidation_size`
    /// lots, limited to its bankruptcy price. `after` is the market as the pending events leave it.
    fn liquidate_through_book(
        &mut self,
        market: &str,
        account: &str,
        after: &Market,
    ) -> XResult<()> {
        let Some(p) = self.position(market, account).cloned() else {
            return Ok(());
        };
        if p.size == 0 || !self.books.contains_key(market) || after.mark.is_none() {
            return Ok(());
        }
        let size = liquidation_size(&p, after);
        let m = &self.state.markets[market];
        let (lower, upper) = (m.config.lower.max(1), m.config.upper);
        let limit = if p.size > 0 {
            ceil_div(p.basis - p.collateral, p.size).max(lower)
        } else {
            let price = (p.collateral - p.basis).div_euclid(-p.size);
            upper.map_or(price, |u| price.min(u))
        };
        if limit <= 0 || upper.is_some_and(|u| limit > u) {
            return Ok(()); // no price in the market's bounds keeps it solvent: the backstop takes it
        }
        self.drop_orders(account, Some(market));
        let mut order = Order {
            id: self.bump_id(),
            account: account.into(),
            market: market.into(),
            side: if p.size > 0 { Side::Sell } else { Side::Buy },
            price: limit,
            size,
            filled: 0,
            leverage: 1,
            reduce_only: true,
            tif: Tif::Ioc,
            time: self.now(),
        };
        self.match_order(&mut order, true)?;
        Ok(())
    }
}

/// How many lots of `p` to close so that the rest meets initial margin at `m`'s mark after the liquidation fee on
/// what's closed: the fewest that do, or the whole position if no partial close will.
fn liquidation_size(p: &Position, m: &Market) -> i128 {
    let mark = m.mark.expect("mark");
    let q = p.size.abs();
    let e = equity(p, Some(mark));
    let keeps = |rest: i128| {
        let penalty = ceil_div((q - rest) * mark * m.config.liquidation_fee_ppm, PPM);
        let kept = Position {
            size: rest * p.size.signum(),
            ..Default::default()
        };
        e - penalty >= initial_margin(m, &kept)
    };
    // The largest position left that still meets initial margin (fewer lots kept, less margin needed).
    let (mut lo, mut hi) = (0, q - 1);
    if !keeps(0) {
        return q;
    }
    while lo < hi {
        let mid = (lo + hi + 1) / 2;
        if keeps(mid) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    q - lo
}
