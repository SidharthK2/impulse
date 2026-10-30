// House bots so a lone user has someone to trade with.
//  - maker: quotes a ladder around the oracle on every market, skewed against its inventory. It is an ordinary
//    account with no special treatment, so ADL haircuts it like anyone else.
//  - noise traders: open and close random leveraged positions against the book, so markets have volume (and
//    graduate) and gaps have somebody to liquidate. They also snipe new creator coins with small amounts and
//    trade the curves of open ones.

use crate::book::{Side, Tif};
use crate::exchange::{Exchange, Kind, OrderInput};
use crate::rng::Rng;
use crate::units::{coins_from_lots, dec, usd, ONE};
use impulse_engine::{leverage_now, Status};
use serde::Serialize;

pub const MM: &str = "maker";
const MM_DEPOSIT: &str = "2000000";

struct Trader {
    id: &'static str,
    deposit: &'static str,
    aggression: f64,
}

const TRADERS: [Trader; 4] = [
    Trader { id: "ape", deposit: "25000", aggression: 0.9 },
    Trader { id: "degen", deposit: "10000", aggression: 1.0 },
    Trader { id: "whale", deposit: "150000", aggression: 0.4 },
    Trader { id: "scalper", deposit: "20000", aggression: 0.6 },
];

struct Ladder {
    offsets: [f64; 6], // perps and attention: fraction of price; binaries: absolute price
    usd: [f64; 6],     // notional per level
    max_inventory_usd: f64,
}

fn ladder(kind: Kind) -> Ladder {
    match kind {
        Kind::Perp => Ladder { offsets: [0.0005, 0.0012, 0.0025, 0.005, 0.01, 0.02], usd: [1500., 2500., 4000., 7000., 12000., 20000.], max_inventory_usd: 250_000. },
        Kind::Binary => Ladder { offsets: [0.005, 0.01, 0.02, 0.035, 0.055, 0.08], usd: [300., 500., 900., 1500., 2500., 4000.], max_inventory_usd: 40_000. },
        Kind::Attention => Ladder { offsets: [0.004, 0.01, 0.02, 0.04, 0.07, 0.12], usd: [60., 120., 250., 500., 900., 1500.], max_inventory_usd: 6_000. },
        // No outside price to lean on: quote wider, so the book (which is the oracle) moves on real flow.
        Kind::Preipo => Ladder { offsets: [0.004, 0.01, 0.02, 0.035, 0.06, 0.1], usd: [1000., 1500., 2500., 4000., 6000., 10000.], max_inventory_usd: 80_000. },
    }
}

#[derive(Serialize)]
pub struct BotSummary {
    id: &'static str,
    wallet: String,
}

pub struct Bots {
    pub enabled: bool,
    cursor: usize,
    rng: Rng,
}

impl Bots {
    pub fn new() -> Self {
        Bots { enabled: true, cursor: 0, rng: Rng::from_time() }
    }

    pub fn ids() -> impl Iterator<Item = &'static str> {
        std::iter::once(MM).chain(TRADERS.iter().map(|t| t.id))
    }

    pub fn ensure_accounts(&self, x: &mut Exchange) {
        let wanted = std::iter::once((MM, MM_DEPOSIT)).chain(TRADERS.iter().map(|t| (t.id, t.deposit)));
        for (id, deposit) in wanted {
            if x.accounts.contains_key(id) {
                continue;
            }
            if x.create_account(id, true, &crate::intake::api_key()).is_ok() {
                let _ = x.deposit(id, deposit);
            }
        }
    }

    /// Requote a few markets per call rather than all at once.
    pub fn requote_some(&mut self, x: &mut Exchange, n: usize) {
        let mut ids: Vec<String> = x.markets.keys().cloned().collect();
        ids.sort();
        for _ in 0..n.min(ids.len()) {
            let id = &ids[self.cursor % ids.len()];
            self.cursor += 1;
            self.quote(x, id);
        }
    }

    /// Replace the market maker's ladder in one market.
    pub fn quote(&mut self, x: &mut Exchange, id: &str) {
        let _ = x.cancel_all(MM, Some(id));
        let meta = x.markets[id].clone();
        let m = &x.state.markets[id];
        let Some(mark_lot) = m.mark else { return };
        if m.status != Status::Open || m.launch.as_ref().is_some_and(|l| !l.open) {
            return;
        }
        let lev = leverage_now(m).0 as f64;
        let pos = x.size_of(id, MM);
        if x.wallet(MM) < 500_000 * ONE {
            let _ = x.deposit(MM, "1000000");
        }

        let ladder = ladder(meta.kind);
        let scale = 10f64.powi(meta.sz_decimals as i32);
        let mark = mark_lot as f64 * scale / 1e9; // coin price
        let tick = meta.tick as f64 / 1e9;
        let inv_usd = pos as f64 * mark_lot as f64 / 1e9;
        let skew = (inv_usd / ladder.max_inventory_usd).clamp(-1.0, 1.0);
        // Lean against inventory: long → lower both sides, so asks fill first.
        let binary = meta.kind == Kind::Binary;
        let center = if binary { mark - skew * 0.01 } else { mark * (1.0 - skew * ladder.offsets[1]) };
        let hi = if binary { 1.0 - tick } else { f64::INFINITY };

        for (off, notional) in ladder.offsets.iter().zip(ladder.usd) {
            let d = if binary { *off } else { center * off };
            if skew < 0.98 {
                place(x, id, Side::Buy, tick.max(((center - d) / tick).floor() * tick), notional, lev);
            }
            if skew > -0.98 {
                place(x, id, Side::Sell, hi.min(((center + d) / tick).ceil() * tick), notional, lev);
            }
        }
    }

    /// One random action by one noise trader.
    pub fn noise(&mut self, x: &mut Exchange, log: impl Fn(&str)) {
        let t = &TRADERS[self.rng.below(TRADERS.len())];
        if self.rng.next() > t.aggression {
            return;
        }
        let wallet = x.wallet(t.id);
        if wallet > 500 * ONE && self.coins(x, t.id) {
            return;
        }
        let open: Vec<String> = x.state.markets.values().filter(|m| m.status == Status::Open && m.positions.get(t.id).is_some_and(|p| p.size != 0)).map(|m| m.id.clone()).collect();

        if !open.is_empty() && (self.rng.next() < 0.35 || open.len() >= 4) {
            let id = &open[self.rng.below(open.len())];
            let size = x.size_of(id, t.id);
            let sz = x.markets[id.as_str()].sz_decimals;
            let side = if size > 0 { Side::Sell } else { Side::Buy };
            let input = OrderInput { reduce_only: true, slippage: Some(0.03), ..OrderInput::market(id, side, coins_from_lots(sz, size.abs())) };
            let _ = x.place_order(t.id, input); // no liquidity right now
            return;
        }

        if wallet < 50 * ONE {
            if open.is_empty() {
                let _ = x.deposit(t.id, t.deposit);
                log(&format!("{} is broke; refilled ${}", t.id, t.deposit));
            }
            return;
        }

        let candidates: Vec<String> = x
            .markets
            .keys()
            .filter(|id| {
                let m = &x.state.markets[id.as_str()];
                let b = &x.books[id.as_str()];
                m.status == Status::Open && m.mark.is_some() && !b.bids.is_empty() && !b.asks.is_empty()
            })
            .cloned()
            .collect();
        if candidates.is_empty() {
            return;
        }
        let id = &candidates[self.rng.below(candidates.len())];
        let sz = x.markets[id.as_str()].sz_decimals;
        let m = &x.state.markets[id.as_str()];
        let max_lev = leverage_now(m).0 as f64;
        let lev = 1.0 + (self.rng.next().powf(0.7) * max_lev).floor();
        let budget = (wallet as f64 / 1e9) * (0.03 + self.rng.next() * 0.15);
        let scale = 10f64.powi(sz as i32);
        let price = m.mark.unwrap_or(0) as f64 * scale / 1e9;
        let lots = ((budget * lev.min(max_lev)) / price * scale).floor();
        if !(lots >= 1.0) {
            return;
        }
        // Mild momentum: follow the last few minutes of the chart more often than not.
        let cs = x.candles.get(id.as_str()).map(|c| c.as_slice()).unwrap_or(&[]);
        let recent = &cs[cs.len().saturating_sub(5)..];
        let drift = if recent.len() > 1 { recent[recent.len() - 1].c - recent[0].o } else { 0 };
        let p_buy = if drift > 0 {
            0.6
        } else if drift < 0 {
            0.4
        } else {
            0.5
        };
        let side = if self.rng.next() < p_buy { Side::Buy } else { Side::Sell };
        let input = OrderInput { leverage: Some(lev.min(max_lev)), slippage: Some(0.03), ..OrderInput::market(id, side, coins_from_lots(sz, lots as i128)) };
        let _ = x.place_order(t.id, input); // insufficient balance for this size, or no liquidity
    }

    /// Maybe snipe a coin in its window (once each, $20–300) or trade an open curve ($20–200). True if it acted.
    fn coins(&mut self, x: &mut Exchange, id: &str) -> bool {
        let now = x.now();
        let sniping: Vec<String> = x
            .markets
            .values()
            .filter(|m| m.launch.as_ref().is_some_and(|l| l.opened.is_none() && now < l.opens_at && !l.bids.iter().any(|b| b.account == id)))
            .map(|m| m.id.clone())
            .collect();
        if !sniping.is_empty() && self.rng.next() < 0.5 {
            let coin = &sniping[self.rng.below(sniping.len())];
            let usdc = 20 + (self.rng.next() * 280.0) as i64;
            return x.snipe(id, coin, &usdc.to_string()).is_ok();
        }
        if self.rng.next() >= 0.15 {
            return false;
        }
        let curves: Vec<String> = x
            .state
            .markets
            .values()
            .filter(|m| m.status == Status::Open && m.curve.is_some() && m.launch.as_ref().is_none_or(|l| l.open))
            .map(|m| m.id.clone())
            .collect();
        if curves.is_empty() {
            return false;
        }
        let coin = &curves[self.rng.below(curves.len())];
        let held = x.state.accounts.get(id).and_then(|a| a.spot.get(coin)).copied().unwrap_or(0);
        if held > 1 && self.rng.next() < 0.4 {
            x.spot_sell(id, coin, &(held / 2).to_string()).is_ok()
        } else {
            let usdc = 20 + (self.rng.next() * 180.0) as i64;
            x.spot_buy(id, coin, &usdc.to_string()).is_ok()
        }
    }

    pub fn summary(x: &Exchange) -> Vec<BotSummary> {
        Bots::ids().map(|id| BotSummary { id, wallet: usd(x.wallet(id)) }).collect()
    }
}

fn place(x: &mut Exchange, id: &str, side: Side, price: f64, notional: f64, leverage: f64) {
    if !(price > 0.0) || !price.is_finite() {
        return;
    }
    let meta = &x.markets[id];
    let price_nano = (price * 1e9 / meta.tick as f64).round() as i128 * meta.tick;
    if price_nano <= 0 {
        return;
    }
    let scale = 10f64.powi(meta.sz_decimals as i32);
    let lots = ((notional / price) * scale).floor().max(1.0) as i128;
    let size = coins_from_lots(meta.sz_decimals, lots);
    let input = OrderInput { tif: Some(Tif::Alo), leverage: Some(leverage), ..OrderInput::limit(id, side, dec(price_nano), size) };
    let _ = x.place_order(crate::bots::MM, input); // crossed a user's resting order, or margin: skip this level
}
