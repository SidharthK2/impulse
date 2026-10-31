// Listing markets and moving their prices: feed ticks, admin overrides and holds, resolution, and the clock.

use super::*;

impl Exchange {
    pub fn create_market(&mut self, spec: MarketSpec) -> XResult<&MarketMeta> {
        if !valid_market_id(&spec.id) {
            return Err(ExError::bad(
                "market id must be 1–32 letters, digits or @_.-",
            ));
        }
        if self.markets.contains_key(&spec.id) {
            return Err(ExError::status(409, format!("market {} exists", spec.id)));
        }
        let kind = spec.kind;
        let sz = if matches!(kind, Kind::Perp | Kind::Preipo) {
            spec.sz_decimals.unwrap_or(0)
        } else {
            0
        };
        let source = if kind == Kind::Preipo {
            Source::Book
        } else {
            spec.source
        };
        let start = spec.price.map(Dec::nano);
        if kind != Kind::Attention && source != Source::Manual && start.is_none() {
            return Err(ExError::bad(
                "externally priced markets need a starting price",
            ));
        }
        let tick = match (&spec.tick, kind) {
            (Some(t), _) => t.nano(),
            (None, Kind::Binary) => 1_000_000,
            (None, Kind::Attention) => 1,
            (None, _) => auto_tick(start.unwrap_or(impulse_engine::fixed::ONE), sz),
        };
        if tick <= 0 || tick % pow10(sz) != 0 {
            return Err(ExError::bad(
                "tick must be a positive whole number of nano-USD per lot",
            ));
        }
        let num = |v: f64| Some(Num(js_string(v)));
        let event = Event::Market(MarketEvent {
            id: spec.id.clone(),
            preset: Some(kind.preset().into()),
            adl: Some(spec.adl.clone().unwrap_or_else(|| "pnl".into())),
            oracle_window: spec.oracle_window.and_then(num),
            fee_bps: spec.fee_bps.and_then(num),
            resolves_at: spec
                .resolves_at_ms
                .map(|ms| Num(self.engine_time(ms).to_string())),
            taper_seconds: spec.taper_seconds.and_then(num),
            initial_leverage: spec.initial_leverage.and_then(num),
            maintenance_leverage: spec.maintenance_leverage.and_then(num),
            launch: spec.snipe_seconds.map(|_| true),
            taker_fee_ppm: num(spec.taker_fee_ppm.unwrap_or(TAKER_FEE_PPM as f64)),
            maker_fee_ppm: num(spec.maker_fee_ppm.unwrap_or(MAKER_FEE_PPM as f64)),
            ..Default::default()
        });
        let meta = MarketMeta {
            id: spec.id.clone(),
            name: spec.name.unwrap_or_else(|| spec.id.clone()),
            kind,
            base: spec.base.unwrap_or_else(|| {
                if kind == Kind::Binary {
                    "YES".into()
                } else {
                    spec.id.clone()
                }
            }),
            sz_decimals: sz,
            tick,
            source,
            description: spec.description.unwrap_or_default(),
            url: spec.url,
            created_at: self.now(),
            creator: spec.creator.clone(),
            resolves_at_ms: spec.resolves_at_ms,
            held_until: None,
            launch: spec.snipe_seconds.map(|secs| LaunchMeta {
                opens_at: self.now() + secs * 1000,
                bids: vec![],
                opened: None,
            }),
            preipo: (kind == Kind::Preipo).then(|| PreipoMeta {
                seed: start.unwrap_or(0),
                ipo_at: None,
                ipo_price: None,
            }),
            mirrored_at: None,
        };
        let mut events = vec![event];
        if let (Some(start), false) = (start, kind == Kind::Attention) {
            events.push(Event::Tick {
                market: spec.id.clone(),
                price: dec(clamp_lot(kind, lot_price(sz, start))).into(),
            });
        }
        self.exec(&events)?; // validates the config before anything else is registered
        let id = spec.id;
        let name = meta.name.clone();
        self.markets.insert(id.clone(), meta);
        self.books.insert(id.clone(), Book::default());
        if let Some(mark) = self.state.markets[&id].mark {
            self.candle(&id, mark, 0, None);
        }
        let by = spec
            .creator
            .as_ref()
            .map(|c| format!(" by {c}"))
            .unwrap_or_default();
        self.record(
            &id,
            RiskKind::Listing,
            spec.creator.into_iter().collect(),
            format!("{id} listed{by}: {name}"),
            None,
        );
        Ok(&self.markets[&id])
    }

    /// Oracle update from a feed (coin price, nano-USD). Ignored while an admin hold is active unless forced.
    /// Liquidation and ADL run inside the same transition.
    pub fn tick(
        &mut self,
        market: &str,
        coin_nano: i128,
        force: bool,
    ) -> XResult<Option<Vec<Effect>>> {
        let now = self.now();
        let meta = self.market(market)?;
        if meta.source == Source::Curve {
            return Err(ExError::bad(format!("{market} is priced by its own curve")));
        }
        if meta.source == Source::Book {
            return Err(ExError::bad(format!(
                "{market} is priced by its own order book"
            )));
        }
        let m = &self.state.markets[market];
        if m.status != Status::Open {
            return Ok(None);
        }
        if let Some(until) = meta.held_until {
            if now < until && !force {
                return Ok(None);
            }
            if now >= until {
                self.market_mut(market)?.held_until = None;
            }
        }
        let meta = &self.markets[market];
        let lot = clamp_lot(meta.kind, lot_price(meta.sz_decimals, coin_nano));
        if Some(lot) == self.state.markets[market].mark {
            self.candle(market, lot, 0, None);
            return Ok(Some(vec![]));
        }
        let effects = self.commit(&[Event::Tick {
            market: market.into(),
            price: dec(lot).into(),
        }])?;
        self.candle(market, lot, 0, None);
        Ok(Some(effects))
    }

    /// Admin price override: set the oracle now and ignore the feed for `hold_seconds`.
    pub fn admin_price(
        &mut self,
        market: &str,
        price: Dec,
        hold_seconds: f64,
    ) -> XResult<Vec<Effect>> {
        let now = self.now();
        let meta = self.market(market)?;
        if meta.source == Source::Curve {
            return Err(ExError::bad(format!(
                "{market} is priced by its own curve; move it with spot trades"
            )));
        }
        if meta.source == Source::Book {
            return Err(ExError::bad(format!(
                "{market} is priced by its own order book until its IPO: use /api/admin/ipo"
            )));
        }
        let sz = meta.sz_decimals;
        let before = self.state.markets[market].mark;
        let coin = price.nano();
        self.market_mut(market)?.held_until = if hold_seconds > 0.0 {
            Some(now + (hold_seconds * 1000.0) as i64)
        } else {
            None
        };
        let effects = self.tick(market, coin, true)?.unwrap_or_default();
        let busts = effects
            .iter()
            .filter(|e| matches!(e, Effect::Liquidation { .. } | Effect::Bankrupt { .. }))
            .count();
        let text = format!(
            "{market} oracle forced {} → {}{}: {busts} position{} liquidated or bankrupt",
            before.map_or_else(|| "—".into(), |b| fmt(coin_price(sz, b), 0)),
            self.mark_str(market),
            if hold_seconds > 0.0 {
                format!(" for {hold_seconds}s")
            } else {
                String::new()
            },
            if busts == 1 { "" } else { "s" }
        );
        self.record(market, RiskKind::Gap, vec![], text, None);
        Ok(effects)
    }

    pub fn release_hold(&mut self, market: &str) -> XResult<()> {
        self.market_mut(market)?.held_until = None;
        self.version += 1;
        Ok(())
    }

    pub fn resolve(&mut self, market: &str, price: Dec) -> XResult<Vec<Effect>> {
        let sz = self.market(market)?.sz_decimals;
        let coin = price.nano();
        self.commit(&[Event::Resolve {
            market: market.into(),
            price: dec(lot_price(sz, coin)).into(),
        }])
    }

    /// Move the engine clock to wall time: funding accrues, curve TWAPs refresh, tapers tighten, risk runs.
    /// Then open every launch whose snipe window has ended. Book mids go to the engine first, so funding accrues at
    /// a rate from the current book.
    pub fn clock(&mut self) -> XResult<Vec<Effect>> {
        self.sync_books();
        let t = self.engine_time(self.now());
        let mut effects = vec![];
        if t > self.state.time {
            let seconds = (t - self.state.time).to_string();
            effects = self.commit(&[Event::Advance {
                seconds: seconds.into(),
            }])?;
        }
        let now = self.now();
        let due: Vec<String> = self
            .markets
            .values()
            .filter(|m| {
                m.launch
                    .as_ref()
                    .is_some_and(|l| l.opened.is_none() && now >= l.opens_at)
            })
            .map(|m| m.id.clone())
            .collect();
        for id in due {
            effects.extend(self.commit(&[Event::Open { market: id }])?);
        }
        let books: Vec<String> = self
            .markets
            .values()
            .filter(|m| m.source == Source::Book)
            .map(|m| m.id.clone())
            .collect();
        for id in books {
            effects.extend(self.reprice(&id)?);
        }
        Ok(effects)
    }

    /// Tell the engine each open market's book mid (both sides quoted, else none) where it changed: the funding
    /// premium's perp price. A refused update (it shouldn't be) is logged and skipped.
    pub fn sync_books(&mut self) {
        let events: Vec<Event> = self
            .markets
            .keys()
            .filter_map(|id| {
                let m = &self.state.markets[id];
                if m.status != Status::Open || m.mark.is_none() {
                    return None;
                }
                let book = &self.books[id];
                let mid = match (book.best(Side::Buy), book.best(Side::Sell)) {
                    (Some(bid), Some(ask)) => Some((bid.price + ask.price) / 2),
                    _ => None,
                };
                (mid != m.mid).then(|| Event::Book {
                    market: id.clone(),
                    mid: mid.map(|v| dec(v).into()),
                })
            })
            .collect();
        if events.is_empty() || self.exec(&events).is_ok() {
            return;
        }
        for e in events {
            if let Err(err) = self.exec(std::slice::from_ref(&e)) {
                eprintln!("book mid refused: {}", err.message());
            }
        }
    }
}
