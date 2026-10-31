// What the engine did, as history: the risk feed (who paid), fills, and 1-minute mark candles.

use super::*;

impl Exchange {
    pub(super) fn digest(&mut self, effects: &[Effect]) {
        let mut distressed = HashSet::new();
        for e in effects {
            if let Effect::Liquidation {
                market, account, ..
            }
            | Effect::Bankrupt {
                market, account, ..
            } = e
            {
                distressed.insert((market.clone(), account.clone()));
            }
        }
        for e in effects {
            match e {
                Effect::Liquidation {
                    market,
                    account,
                    size,
                    equity,
                    ..
                } => {
                    let text = format!(
                        "{account} liquidated: {} closed at {}, kept ${}",
                        self.side_size(market, *size),
                        self.mark_str(market),
                        cents(*equity)
                    );
                    self.record(
                        market,
                        RiskKind::Liquidation,
                        vec![account.clone()],
                        text,
                        Some(*equity),
                    );
                    self.drop_orders(account, Some(market));
                }
                Effect::Bankrupt {
                    market,
                    account,
                    size,
                    shortfall,
                } => {
                    let text = format!(
                        "{account} bankrupt: {} closed at {}, ${} shortfall charged to the other side",
                        self.side_size(market, *size),
                        self.mark_str(market),
                        cents(*shortfall)
                    );
                    self.record(
                        market,
                        RiskKind::Bankrupt,
                        vec![account.clone()],
                        text,
                        Some(*shortfall),
                    );
                    self.drop_orders(account, Some(market));
                }
                Effect::Haircut {
                    market,
                    account,
                    amount,
                    from_principal,
                } => {
                    let from = if *from_principal > 0 {
                        format!(" (${} of it from principal)", cents(*from_principal))
                    } else {
                        " (from profit)".into()
                    };
                    let text = format!("{account} paid a ${} ADL haircut{from}", cents(*amount));
                    self.record(
                        market,
                        RiskKind::Haircut,
                        vec![account.clone()],
                        text,
                        Some(*amount),
                    );
                }
                Effect::ForcedClose { market, closes } => {
                    let sz = self.markets[market.as_str()].sz_decimals;
                    for c in closes {
                        if distressed.contains(&(market.clone(), c.account.clone())) {
                            continue;
                        }
                        let text = format!(
                            "{} auto-deleveraged: {} force-closed at {}",
                            c.account,
                            self.side_size(market, -c.closed),
                            fmt(coin_price(sz, c.price), 0)
                        );
                        self.record(market, RiskKind::Adl, vec![c.account.clone()], text, None);
                    }
                }
                Effect::Settlement {
                    market,
                    price,
                    closes,
                } => {
                    let sz = self.markets[market.as_str()].sz_decimals;
                    let text = format!(
                        "{market} resolved at {}; {} positions settled",
                        fmt(coin_price(sz, *price), 0),
                        closes.len()
                    );
                    self.record(
                        market,
                        RiskKind::Settlement,
                        closes.iter().map(|c| c.account.clone()).collect(),
                        text,
                        None,
                    );
                    let ids: Vec<u64> = self
                        .orders
                        .iter()
                        .filter(|(_, r)| r.market == *market)
                        .map(|(id, _)| *id)
                        .collect();
                    for id in ids {
                        self.remove_order(id);
                    }
                }
                Effect::Graduation {
                    market,
                    tier,
                    leverage,
                } => {
                    self.record(
                        market,
                        RiskKind::Graduation,
                        vec![],
                        format!("{market} graduated to tier {tier}: max leverage now {leverage}×"),
                        None,
                    );
                }
                Effect::Mark { market, to, .. } => self.candle(market, *to, 0, None),
                Effect::Spot {
                    market,
                    account,
                    usdc,
                    tokens,
                    ..
                } => {
                    let n = tokens.abs();
                    let fill = Fill {
                        id: self.bump_id(),
                        time: self.now(),
                        market: market.clone(),
                        kind: FillKind::Spot,
                        price: usdc.abs() / n,
                        size: n,
                        side: if *tokens > 0 { Side::Buy } else { Side::Sell },
                        taker: account.clone(),
                        maker: "curve".into(),
                        taker_order: None,
                        maker_order: None,
                        taker_fee: 0,
                        maker_fee: 0,
                    };
                    self.push_fill(fill);
                    let mark = self.state.markets[market].mark.unwrap_or(0);
                    self.candle(market, mark, usdc.abs(), None);
                }
                Effect::Open {
                    market,
                    price,
                    sniped,
                    tokens,
                    reserve,
                    fills,
                } => {
                    let now = self.now();
                    let snipers = fills.iter().filter(|f| f.tokens > 0).count();
                    let text = format!(
                        "{market} opened at {}: ${} of snipes from {snipers} account{} bought {} tokens; ${} held as the launch reserve",
                        fmt(*price, 0),
                        cents(*sniped),
                        if snipers == 1 { "" } else { "s" },
                        group(&tokens.to_string()),
                        cents(*reserve)
                    );
                    self.record(
                        market,
                        RiskKind::Open,
                        fills
                            .iter()
                            .filter(|f| f.tokens > 0)
                            .map(|f| f.account.clone())
                            .collect(),
                        text,
                        Some(*sniped),
                    );
                    if let Some(l) = self
                        .markets
                        .get_mut(market.as_str())
                        .and_then(|m| m.launch.as_mut())
                    {
                        l.opened = Some(Opened {
                            open_price: *price,
                            opened_at: now,
                            sniped: *sniped,
                            tokens_sold: *tokens,
                            reserve: *reserve,
                        });
                    }
                    self.candle(market, *price, 0, None);
                }
                Effect::Funding { .. } => {} // funding accrues every clock step; positions carry the running total
                Effect::Fees { .. } => {}    // the fill that paid them records them (matching.rs)
            }
        }
    }

    fn side_size(&self, market: &str, size: i128) -> String {
        let meta = &self.markets[market];
        let coins = coins_from_lots(meta.sz_decimals, size.abs());
        let grouped = match coins.split_once('.') {
            Some((int, frac)) => format!("{}.{frac}", group(int)),
            None => group(&coins),
        };
        format!(
            "{} {grouped} {}",
            if size > 0 { "long" } else { "short" },
            meta.base
        )
    }

    /// Mark as a coin price ("—" if none).
    pub fn mark_str(&self, market: &str) -> String {
        self.mark_coin(market)
            .map_or_else(|| "—".into(), |v| fmt(v, 0))
    }

    pub fn mark_coin(&self, market: &str) -> Option<i128> {
        let sz = self.markets.get(market)?.sz_decimals;
        self.state
            .markets
            .get(market)?
            .mark
            .map(|m| coin_price(sz, m))
    }

    pub fn record(
        &mut self,
        market: &str,
        kind: RiskKind,
        accounts: Vec<String>,
        text: String,
        amount: Option<i128>,
    ) {
        let id = self.bump_id();
        let price = self.mark_coin(market).map(|v| fmt(v, 0));
        self.risk.push_back(RiskEvent {
            id,
            time: self.now(),
            market: market.into(),
            kind,
            accounts,
            text,
            amount: amount.map(usd),
            price,
        });
        while self.risk.len() > RISK_HISTORY {
            self.risk.pop_front();
        }
    }

    pub(super) fn push_fill(&mut self, f: Fill) {
        self.version += 1;
        self.fills.push_back(f);
        while self.fills.len() > FILL_HISTORY {
            self.fills.pop_front();
        }
    }

    pub fn candle(&mut self, market: &str, lot_px: i128, volume: i128, at: Option<i64>) {
        self.version += 1;
        let at = at.unwrap_or_else(|| self.now());
        let t = at.div_euclid(60_000) * 60_000;
        let cs = self.candles.entry(market.into()).or_default();
        if let Some(last) = cs.last_mut() {
            if last.t > t {
                return;
            }
            if last.t == t {
                last.h = last.h.max(lot_px);
                last.l = last.l.min(lot_px);
                last.c = lot_px;
                last.v += volume;
                self.dirty_candles.insert((market.into(), t));
                return;
            }
        }
        let o = cs.last().map_or(lot_px, |c| c.c);
        cs.push(Candle {
            t,
            o,
            h: o.max(lot_px),
            l: o.min(lot_px),
            c: lot_px,
            v: volume,
        });
        self.dirty_candles.insert((market.into(), t));
        if cs.len() > CANDLES {
            let extra = cs.len() - CANDLES;
            cs.drain(..extra);
        }
    }

    /// Prepend history older than the market's first candle, merged into 1m buckets (chart backfill).
    pub fn candles_from_history(
        &mut self,
        market: &str,
        points: &mut [(i64, i128, i128, i128, i128)],
    ) {
        let Some(meta) = self.markets.get(market) else {
            return;
        };
        let sz = meta.sz_decimals;
        let lot = |v: i128| lot_price(sz, v);
        let cs = self.candles.entry(market.into()).or_default();
        let first = cs.first().map_or(i64::MAX, |c| c.t);
        points.sort_by_key(|p| p.0);
        let mut older: Vec<Candle> = vec![];
        for &(t, o, h, l, c) in points.iter() {
            let t = t.div_euclid(60_000) * 60_000;
            if t >= first {
                break;
            }
            match older.last_mut() {
                Some(last) if last.t == t => {
                    last.h = last.h.max(lot(h));
                    last.l = last.l.min(lot(l));
                    last.c = lot(c);
                }
                _ => older.push(Candle {
                    t,
                    o: lot(o),
                    h: lot(h),
                    l: lot(l),
                    c: lot(c),
                    v: 0,
                }),
            }
        }
        older.append(cs);
        let extra = older.len().saturating_sub(CANDLES);
        *cs = older.split_off(extra);
        let touched: Vec<i64> = cs.iter().map(|c| c.t).collect();
        self.dirty_candles
            .extend(touched.into_iter().map(|t| (market.to_string(), t)));
        self.version += 1;
    }
}
