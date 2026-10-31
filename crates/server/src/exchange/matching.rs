// Orders: validation, price-time matching against the book, auto-margin per fill, and cancels.

use super::*;

impl Exchange {
    /// Resting orders in time priority, optionally in one market.
    pub fn orders_of<'a>(
        &'a self,
        account: &'a str,
        market: Option<&'a str>,
    ) -> impl Iterator<Item = &'a Order> + 'a {
        self.orders
            .iter()
            .filter(move |(_, r)| {
                r.account == account && market.is_none_or(|want| want == r.market)
            })
            .filter_map(move |(id, r)| self.books.get(&r.market)?.orders().find(|o| o.id == *id))
    }

    pub fn place_order(&mut self, account: &str, input: &OrderInput) -> XResult<OrderResult> {
        self.account(account)?;
        // Only these three of the market's metadata are needed, and self is borrowed mutably below.
        let (id, sz_decimals, tick) = {
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
        if m.launch.as_ref().is_some_and(|l| !l.open) {
            return Err(ExError::bad(format!(
                "{id} is in its snipe window: trading starts at the open"
            )));
        }
        let mut size = lots_from_coins(sz_decimals, input.size)
            .map_err(|e| ExError::bad(format!("size: {e}")))?;
        if size <= 0 {
            return Err(ExError::bad("size must be positive"));
        }

        let max_lev = leverage_now(m).0;
        let leverage = match input.leverage {
            None => max_lev,
            Some(l) if l.is_finite() => l.floor() as i128,
            Some(_) => 0,
        };
        if leverage < 1 || leverage > max_lev {
            return Err(ExError::bad(format!(
                "leverage must be 1–{max_lev}× in {id} right now"
            )));
        }

        let (lower, upper) = (m.config.lower, m.config.upper);
        let (price, tif) = match input.kind {
            OrderType::Market => {
                let slip =
                    (input.slippage.unwrap_or(0.05).clamp(0.001, 0.5) * 10_000.0).round() as i128;
                let band = (mark * slip / 10_000).max((tick / pow10(sz_decimals)) * 5);
                let mut price = if input.side == Side::Buy {
                    mark + band
                } else {
                    mark - band
                };
                if let Some(u) = upper {
                    price = price.min(u);
                }
                (
                    price.max(lower.max(if upper.is_none() { 1 } else { lower })),
                    Tif::Ioc,
                )
            }
            OrderType::Limit => {
                let Some(coin) = input.price.map(Dec::nano) else {
                    return Err(ExError::bad("limit orders need a price"));
                };
                if coin <= 0 {
                    return Err(ExError::bad("price must be positive"));
                }
                if coin % tick != 0 {
                    return Err(ExError::bad(format!(
                        "price must be a multiple of the tick {}",
                        fmt(tick, 0)
                    )));
                }
                let price = lot_price(sz_decimals, coin);
                if price < lower || upper.is_some_and(|u| price > u) {
                    return Err(ExError::bad("price outside the market's bounds"));
                }
                (price, input.tif.unwrap_or(Tif::Gtc))
            }
        };

        let dir = input.side.dir();
        let cur = self.size_of(&id, account);
        if input.reduce_only {
            if cur == 0 || cur.signum() == dir {
                return Err(ExError::bad(
                    "reduce-only order would not reduce a position",
                ));
            }
            size = size.min(cur.abs());
        } else {
            self.check_affordable(&id, account, dir * size, price, leverage)?;
        }
        if tif == Tif::Alo && self.books[&id].crosses(input.side, price) {
            return Err(ExError::bad("post-only order would take liquidity"));
        }
        // The house bots quote every market (the maker mirrors whole books), so the cap is for people.
        if tif != Tif::Ioc
            && !self.accounts[account].bot
            && self.orders_of(account, None).count() >= MAX_OPEN_ORDERS
        {
            return Err(ExError::bad(format!(
                "at most {MAX_OPEN_ORDERS} open orders"
            )));
        }

        let mut order = Order {
            id: self.bump_id(),
            account: account.into(),
            market: id.clone(),
            side: input.side,
            price,
            size,
            filled: 0,
            leverage,
            reduce_only: input.reduce_only,
            tif,
            time: self.now(),
        };
        let (fills, stop) = self.match_order(&mut order, false)?;
        let status = if order.size == 0 {
            OrderStatus::Filled
        } else if tif != Tif::Ioc && stop.is_none() {
            self.orders.insert(
                order.id,
                Resting {
                    market: id.clone(),
                    account: account.into(),
                },
            );
            self.books.get_mut(&id).expect("book").add(order.clone());
            if order.filled > 0 {
                OrderStatus::Partial
            } else {
                OrderStatus::Resting
            }
        } else if order.filled > 0 {
            OrderStatus::Partial
        } else {
            OrderStatus::Cancelled
        };
        self.version += 1;
        self.reprice(&id)?;
        let reason = stop.or_else(|| {
            (status == OrderStatus::Cancelled)
                .then(|| "no liquidity at or inside the limit price".into())
        });
        Ok(OrderResult {
            order,
            fills,
            status,
            reason,
        })
    }

    /// What an account's resting orders hold back from its wallet: for each, the margin it would need if it filled
    /// (at its own price and leverage, capped at the max loss where there is one) plus the maker fee. An order holds
    /// nothing for the part that would only reduce the account's position: in each market, the best-placed orders
    /// on the reducing side use up the position first. Both sides count, since both could fill.
    pub fn reserved(&self, account: &str) -> i128 {
        let markets: BTreeSet<&str> = self
            .orders
            .values()
            .filter(|r| r.account == account)
            .map(|r| r.market.as_str())
            .collect();
        markets
            .into_iter()
            .map(|id| {
                let m = &self.state.markets[id];
                let pos = self.size_of(id, account);
                let mut held = 0;
                for side in [Side::Buy, Side::Sell] {
                    let mut reducing = if pos.signum() == -side.dir() {
                        pos.abs()
                    } else {
                        0
                    };
                    for o in self.books[id]
                        .side(side)
                        .iter()
                        .filter(|o| o.account == account)
                    {
                        let cut = o.size.min(reducing);
                        reducing -= cut;
                        if !o.reduce_only && o.size > cut {
                            held += order_margin(m, side, o.size - cut, o.price, o.leverage);
                        }
                    }
                }
                held
            })
            .sum()
    }

    /// The wallet less what open orders hold back.
    pub fn available(&self, account: &str) -> i128 {
        (self.wallet(account) - self.reserved(account)).max(0)
    }

    /// Rough pre-trade check so obviously unaffordable orders don't rest. Fills re-check exactly.
    fn check_affordable(
        &self,
        market: &str,
        account: &str,
        delta: i128,
        price: i128,
        leverage: i128,
    ) -> XResult<()> {
        let m = &self.state.markets[market];
        let p = m.positions.get(account);
        let cur = p.map_or(0, |p| p.size);
        let next = cur + delta;
        if next.abs() <= cur.abs() && next.signum() != -cur.signum() {
            return Ok(()); // reduces
        }
        let mark = m.mark.expect("mark");
        let px = price.max(mark);
        let mut need = ceil_div(delta.abs() * px, leverage);
        if let Some(u) = m.config.upper {
            need = need.min(delta.abs() * u);
        }
        need += ceil_div(delta.abs() * px * m.config.taker_fee_ppm, PPM);
        let reserved = self.reserved(account);
        let wallet = self.wallet(account) - reserved;
        let free = p.map_or(0, |p| 0.max(equity(p, m.mark) - initial_margin(m, p)));
        if need > wallet + free {
            let held = if reserved > 0 {
                format!(" (${} is held for open orders)", usd(reserved))
            } else {
                String::new()
            };
            return Err(ExError::bad(format!(
                "insufficient balance: needs about ${} of margin, ${} available{held}",
                usd(need),
                usd((wallet + free).max(0))
            )));
        }
        Ok(())
    }

    /// Match `o` against the book. `liquidation`: it is a liquidation order (liquidation.rs).
    pub(super) fn match_order(
        &mut self,
        o: &mut Order,
        liquidation: bool,
    ) -> XResult<(Vec<Fill>, Option<String>)> {
        let mut fills = vec![];
        let opp = o.side.opposite();
        while o.size > 0 {
            let Some(maker) = self.books[&o.market].best(opp).cloned() else {
                break;
            };
            if if o.side == Side::Buy {
                maker.price > o.price
            } else {
                maker.price < o.price
            } {
                break;
            }
            if maker.account == o.account {
                self.remove_order(maker.id); // self-trade prevention: the resting order goes
                continue;
            }
            let mut qty = o.size.min(maker.size);
            if maker.reduce_only {
                qty = qty.min(self.reducible(&maker));
                if qty == 0 {
                    self.remove_order(maker.id);
                    continue;
                }
            }
            if o.reduce_only {
                let r = self.reducible(o);
                if r == 0 {
                    return Ok((fills, Some("position already closed".into())));
                }
                qty = qty.min(r);
            }
            match self.try_fill(o, &maker, qty, liquidation)? {
                Ok(fill) => {
                    fills.push(fill);
                    o.size -= qty;
                    o.filled += qty;
                    // The fill's own risk processing may have cancelled the maker already.
                    if let Some(m) = self
                        .books
                        .get_mut(&o.market)
                        .and_then(|b| b.get_mut(maker.id))
                    {
                        m.size -= qty;
                        m.filled += qty;
                        if m.size == 0 {
                            self.remove_order(maker.id);
                        }
                    }
                }
                Err(Blame::Maker) => {
                    self.remove_order(maker.id); // the maker can no longer afford its order
                }
                Err(Blame::Taker(reason)) => return Ok((fills, Some(reason))),
            }
        }
        Ok((fills, None))
    }

    fn reducible(&self, o: &Order) -> i128 {
        let cur = self.size_of(&o.market, &o.account);
        if cur != 0 && cur.signum() == -o.side.dir() {
            cur.abs()
        } else {
            0
        }
    }

    fn try_fill(
        &mut self,
        taker: &Order,
        maker: &Order,
        qty: i128,
        liquidation: bool,
    ) -> XResult<Result<Fill, Blame>> {
        let market = taker.market.clone();
        let price = maker.price;
        let (buyer, seller) = if taker.side == Side::Buy {
            (taker, maker)
        } else {
            (maker, taker)
        };
        let mut events = vec![];
        {
            let m = &self.state.markets[&market];
            for (o, d) in [(buyer, qty), (seller, -qty)] {
                let rate = if o.account == taker.account {
                    m.config.taker_fee_ppm
                } else {
                    m.config.maker_fee_ppm
                };
                let fee = ceil_div(qty * price * rate, PPM);
                // A liquidation closes what the position holds: it never draws on the wallet.
                let need = if liquidation && o.account == taker.account {
                    0
                } else {
                    self.margin_for(m, &o.account, d, price, o.leverage, fee)
                };
                if need > 0 {
                    events.push(ev_allocate(&o.account, &market, dec(need)));
                }
            }
        }
        events.push(Event::Trade {
            market: market.clone(),
            buyer: buyer.account.clone(),
            seller: seller.account.clone(),
            size: qty.to_string().into(),
            price: dec(price).into(),
            taker: Some(taker.account.clone()),
            liquidation,
        });
        let (taker_fee, maker_fee) = match self.commit(&events) {
            Ok(effects) => {
                let fees = effects
                    .iter()
                    .find_map(|e| match e {
                        Effect::Fees {
                            taker_fee,
                            maker_fee,
                            ..
                        } => Some((*taker_fee, *maker_fee)),
                        _ => None,
                    })
                    .unwrap_or((0, 0));
                if self.liquidating {
                    self.liquidation_effects.extend(effects);
                }
                fees
            }
            Err(ExError::Http(_, reason)) => {
                return Ok(Err(if blames(&reason, &maker.account) {
                    Blame::Maker
                } else {
                    Blame::Taker(reason)
                }));
            }
            Err(e) => return Err(e),
        };
        let fill = Fill {
            id: self.bump_id(),
            time: self.now(),
            market: market.clone(),
            kind: FillKind::Perp,
            price,
            size: qty,
            side: taker.side,
            taker: taker.account.clone(),
            maker: maker.account.clone(),
            taker_order: Some(taker.id),
            maker_order: Some(maker.id),
            taker_fee,
            maker_fee,
        };
        self.push_fill(fill.clone());
        let mark = self.state.markets[&market].mark.expect("mark");
        self.candle(&market, mark, qty * price, None);
        self.reprice(&market)?;
        Ok(Ok(fill))
    }

    /// Auto-margin for one side of a fill: top the position's equity (after the fill and its `fee`, marked at the
    /// oracle) up to the larger of the engine's initial margin and the order's chosen leverage; for a reduction,
    /// only what keeps the rest above maintenance after the fee. Capped by the wallet; if that's not enough the
    /// engine rejects the trade and the matcher blames this side.
    pub fn margin_for(
        &self,
        m: &Market,
        account: &str,
        delta: i128,
        price: i128,
        leverage: i128,
        fee: i128,
    ) -> i128 {
        let p = m.positions.get(account);
        let cur = p.map_or(0, |p| p.size);
        let next = cur + delta;
        let mark = m.mark.expect("mark");
        let eq_after = p.map_or(0, |p| equity(p, Some(mark))) + delta * (mark - price) - fee;
        let at_size = |size: i128| Position {
            size,
            ..Default::default()
        };
        if next.abs() <= cur.abs() && next.signum() != -cur.signum() {
            let need = maintenance_margin(m, &at_size(next)) - eq_after;
            return need.clamp(0, self.wallet(account).max(0));
        }
        let lev = leverage.min(leverage_now(m).0);
        let engine_im = initial_margin(m, &at_size(next));
        let mut chosen = ceil_div(next.abs() * mark, lev);
        let cap = if next > 0 {
            Some(next * (mark - m.config.lower))
        } else {
            m.config.upper.map(|u| next.abs() * (u - mark))
        };
        if let Some(c) = cap {
            chosen = chosen.min(c);
        }
        let mut target = engine_im.max(chosen);
        // At the max-loss cap, initial and maintenance margin coincide, so the first funding payment would liquidate
        // the position. Post 5% more so a fully collateralized position is actually safe.
        if let Some(c) = cap {
            if target >= c {
                target += ceil_div(c, 20);
            }
        }
        let need = target - eq_after;
        if need <= 0 {
            0
        } else {
            need.min(self.wallet(account))
        }
    }

    pub(super) fn remove_order(&mut self, id: u64) -> Option<Order> {
        let resting = self.orders.remove(&id)?;
        self.version += 1;
        self.books.get_mut(&resting.market)?.remove(id)
    }

    /// Cancel a resting order or a waiting trigger order (they share ids).
    pub fn cancel(&mut self, account: &str, order_id: &str) -> XResult<()> {
        if order_id
            .parse::<u64>()
            .is_ok_and(|id| self.cancel_trigger(account, id))
        {
            return Ok(());
        }
        let owned = order_id
            .parse::<u64>()
            .ok()
            .filter(|id| self.orders_of(account, None).any(|o| o.id == *id));
        match owned {
            Some(id) => {
                if let Some(o) = self.remove_order(id) {
                    self.reprice(&o.market)?;
                }
                Ok(())
            }
            None => Err(ExError::status(404, format!("no open order {order_id}"))),
        }
    }

    /// Cancel an account's orders (in one market or all), then reprice the book-priced markets that changed.
    pub fn cancel_all(&mut self, account: &str, market: Option<&str>) -> XResult<usize> {
        let removed = self.drop_orders(account, market);
        let mut touched: Vec<String> = removed.into_iter().map(|o| o.market).collect();
        let n = touched.len();
        touched.sort();
        touched.dedup();
        for m in touched {
            self.reprice(&m)?;
        }
        Ok(n)
    }

    /// Cancel without repricing: for risk processing, which is already inside a transaction's aftermath.
    pub(super) fn drop_orders(&mut self, account: &str, market: Option<&str>) -> Vec<Order> {
        let ids: Vec<u64> = self.orders_of(account, market).map(|o| o.id).collect();
        ids.into_iter()
            .filter_map(|id| self.remove_order(id))
            .collect()
    }
}

enum Blame {
    Maker,
    Taker(String),
}

/// The margin `lots` on `side` at `price` (lot price) would need if filled at `leverage`, capped at the max loss
/// where the market has a bound on that side, plus the maker fee.
pub(super) fn order_margin(
    m: &Market,
    side: Side,
    lots: i128,
    price: i128,
    leverage: i128,
) -> i128 {
    let mut need = ceil_div(lots * price, leverage.max(1));
    let cap = if side == Side::Buy {
        Some(lots * (price - m.config.lower))
    } else {
        m.config.upper.map(|u| lots * (u - price))
    };
    if let Some(c) = cap {
        need = need.min(c.max(0));
    }
    need + ceil_div(lots * price * m.config.maker_fee_ppm, PPM)
}
