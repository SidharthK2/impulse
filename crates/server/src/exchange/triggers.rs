// Trigger orders: stop-loss and take-profit. They wait outside the book and watch the mark, as on Hyperliquid:
//   stop          sell when the mark falls to the trigger price or below; buy when it rises to it or above
//   take profit   sell when the mark rises to the trigger price or above; buy when it falls to it or below
// When one fires it becomes an ordinary order: a limit order at its own price if it has one (resting if it doesn't
// fill), otherwise an IOC with 10% slippage from the mark. Reduce-only (the default) means it only ever closes,
// and a reduce-only trigger whose position is gone is dropped.
//
// They fire in the same step as the mark move that reaches them, before it commits: the exchange dry-runs every
// mark-moving event (liquidation.rs), fires the triggers the new marks reach, then sends what's still to be
// liquidated through the book, then commits the event. So a stop placed above the liquidation price gets its
// chance first, at book prices around the new mark.

use super::*;

/// How far from the mark a fired market trigger may fill.
const TRIGGER_SLIPPAGE_PPM: i128 = 100_000;
/// Waiting triggers per account (the house bots place none).
const MAX_TRIGGERS: usize = 50;

/// Does a trigger fire at this mark (lot prices)?
fn reached(t: &Trigger, mark: i128) -> bool {
    match (t.kind, t.side) {
        (TriggerKind::Stop, Side::Sell) | (TriggerKind::TakeProfit, Side::Buy) => {
            mark <= t.trigger_price
        }
        (TriggerKind::Stop, Side::Buy) | (TriggerKind::TakeProfit, Side::Sell) => {
            mark >= t.trigger_price
        }
    }
}

impl Exchange {
    /// An account's waiting triggers, oldest first, optionally in one market.
    pub fn triggers_of<'a>(
        &'a self,
        account: &'a str,
        market: Option<&'a str>,
    ) -> impl Iterator<Item = &'a Trigger> + 'a {
        self.triggers
            .values()
            .filter(move |t| t.account == account && market.is_none_or(|want| want == t.market))
    }

    pub fn place_trigger(&mut self, account: &str, input: &TriggerInput) -> XResult<Trigger> {
        self.account(account)?;
        let (id, sz, tick) = {
            let meta = self.market(&input.market)?;
            (meta.id.clone(), meta.sz_decimals, meta.tick)
        };
        let m = &self.state.markets[&id];
        if m.status != Status::Open {
            return Err(ExError::bad(format!("{id} is resolved")));
        }
        let Some(mark) = m.mark else {
            return Err(ExError::bad(format!("{id} has no price yet")));
        };
        let size =
            lots_from_coins(sz, input.size).map_err(|e| ExError::bad(format!("size: {e}")))?;
        if size <= 0 {
            return Err(ExError::bad("size must be positive"));
        }
        let (lower, upper) = (m.config.lower, m.config.upper);
        let lot = |coin: Dec, what: &str| -> XResult<i128> {
            let coin = coin.nano();
            if coin <= 0 || coin % tick != 0 {
                return Err(ExError::bad(format!(
                    "{what} must be a positive multiple of the tick {}",
                    fmt(tick, 0)
                )));
            }
            let price = lot_price(sz, coin);
            if price < lower || upper.is_some_and(|u| price > u) {
                return Err(ExError::bad(format!("{what} outside the market's bounds")));
            }
            Ok(price)
        };
        let trigger_price = lot(input.trigger_price, "trigger price")?;
        let limit = match input.price {
            Some(p) => Some(lot(p, "price")?),
            None => None,
        };
        let max_lev = leverage_now(m).0;
        let leverage = match input.leverage {
            None => max_lev,
            Some(l) if l.is_finite() && l >= 1.0 && (l.floor() as i128) <= max_lev => {
                l.floor() as i128
            }
            Some(_) => {
                return Err(ExError::bad(format!(
                    "leverage must be 1–{max_lev}× in {id} right now"
                )))
            }
        };
        let cur = self.size_of(&id, account);
        if input.reduce_only && (cur == 0 || cur.signum() == input.side.dir()) {
            return Err(ExError::bad(
                "a reduce-only trigger needs a position it would reduce",
            ));
        }
        if !self.accounts[account].bot && self.triggers_of(account, None).count() >= MAX_TRIGGERS {
            return Err(ExError::bad(format!(
                "at most {MAX_TRIGGERS} trigger orders"
            )));
        }
        let t = Trigger {
            id: 0,
            account: account.into(),
            market: id,
            side: input.side,
            kind: input.kind,
            trigger_price,
            size,
            limit,
            reduce_only: input.reduce_only,
            leverage,
            time: self.now(),
        };
        if reached(&t, mark) {
            return Err(ExError::bad(format!(
                "the mark ({}) has already reached the trigger price",
                fmt(coin_price(sz, mark), 0)
            )));
        }
        let t = Trigger {
            id: self.bump_id(),
            ..t
        };
        self.triggers.insert(t.id, t.clone());
        Ok(t)
    }

    /// Cancel a waiting trigger; false if the account has none with this id.
    pub(super) fn cancel_trigger(&mut self, account: &str, id: u64) -> bool {
        if self.triggers.get(&id).is_some_and(|t| t.account == account) {
            self.triggers.remove(&id);
            self.version += 1;
            true
        } else {
            false
        }
    }

    /// Fire every trigger the marks in `after` reach (in placement order), first dropping reduce-only triggers
    /// with nothing left to reduce. True if any fired.
    pub(super) fn fire_triggers(&mut self, after: &State) -> bool {
        let stale: Vec<u64> = self
            .triggers
            .values()
            .filter(|t| {
                let cur = self.size_of(&t.market, &t.account);
                t.reduce_only && (cur == 0 || cur.signum() == t.side.dir())
            })
            .map(|t| t.id)
            .collect();
        for id in stale {
            if let Some(t) = self.triggers.remove(&id) {
                self.version += 1;
                let text = format!(
                    "{}'s {} dropped: no position left for it to reduce",
                    t.account,
                    self.trigger_name(&t)
                );
                self.record(
                    &t.market,
                    RiskKind::Trigger,
                    vec![t.account.clone()],
                    text,
                    None,
                );
            }
        }
        let due: Vec<u64> = self
            .triggers
            .values()
            .filter(|t| {
                after
                    .markets
                    .get(&t.market)
                    .and_then(|m| m.mark.filter(|_| m.status == Status::Open))
                    .is_some_and(|mark| reached(t, mark))
            })
            .map(|t| t.id)
            .collect();
        for id in &due {
            if let Some(t) = self.triggers.remove(id) {
                self.version += 1;
                let mark = after.markets[&t.market]
                    .mark
                    .expect("a reached trigger has a mark");
                self.fire(&t, mark);
            }
        }
        !due.is_empty()
    }

    /// A fired trigger's order, placed as the account would place it; the outcome goes in the risk feed.
    fn fire(&mut self, t: &Trigger, mark: i128) {
        let (sz, tick) = {
            let meta = &self.markets[&t.market];
            (meta.sz_decimals, meta.tick)
        };
        let m = &self.state.markets[&t.market];
        let (price, tif) = match t.limit {
            Some(limit) => (coin_price(sz, limit), Tif::Gtc),
            None => {
                let band = mark * TRIGGER_SLIPPAGE_PPM / PPM;
                let lot = if t.side == Side::Buy {
                    let p = mark + band;
                    m.config.upper.map_or(p, |u| p.min(u))
                } else {
                    (mark - band).max(m.config.lower).max(1)
                };
                // Snap to the tick, outward, so the slippage band is never narrower than asked.
                let coin = coin_price(sz, lot);
                let snapped = if t.side == Side::Buy {
                    coin.div_euclid(tick) * tick
                } else {
                    ceil_div(coin, tick) * tick
                };
                (snapped.max(tick), Tif::Ioc)
            }
        };
        let input = OrderInput {
            leverage: Some(t.leverage as f64),
            reduce_only: t.reduce_only,
            tif: Some(tif),
            ..OrderInput::limit(
                &t.market,
                t.side,
                Dec::from_nano(price),
                coins_dec(sz, t.size),
            )
        };
        let outcome = match self.place_order(&t.account, &input) {
            Ok(r) if !r.fills.is_empty() => {
                let lots: i128 = r.fills.iter().map(|f| f.size).sum();
                let notional: i128 = r.fills.iter().map(|f| f.size * f.price).sum();
                format!(
                    "{} {} at {}{}",
                    if t.side == Side::Buy {
                        "bought"
                    } else {
                        "sold"
                    },
                    coins_from_lots(sz, lots),
                    fmt(coin_price(sz, notional / lots), 0),
                    if r.status == OrderStatus::Resting || r.status == OrderStatus::Partial {
                        "; the rest rests"
                    } else {
                        ""
                    }
                )
            }
            Ok(r) if r.status == OrderStatus::Resting => "its limit order rests".into(),
            Ok(r) => format!(
                "nothing filled ({})",
                r.reason.unwrap_or_else(|| "no liquidity".into())
            ),
            Err(e) => format!("refused ({})", e.message()),
        };
        let text = format!(
            "{}'s {} fired at mark {}: {outcome}",
            t.account,
            self.trigger_name(t),
            fmt(coin_price(sz, mark), 0)
        );
        self.record(
            &t.market,
            RiskKind::Trigger,
            vec![t.account.clone()],
            text,
            None,
        );
    }

    /// "stop at 95 (sell 2)", for the risk feed.
    fn trigger_name(&self, t: &Trigger) -> String {
        let sz = self.markets[&t.market].sz_decimals;
        format!(
            "{} at {} ({} {})",
            match t.kind {
                TriggerKind::Stop => "stop",
                TriggerKind::TakeProfit => "take profit",
            },
            fmt(coin_price(sz, t.trigger_price), 0),
            if t.side == Side::Buy { "buy" } else { "sell" },
            coins_from_lots(sz, t.size)
        )
    }
}
