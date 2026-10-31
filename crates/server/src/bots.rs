// House bots so a lone user has someone to trade with.
//  - maker: quotes a ladder around the oracle on every market, skewed against its inventory. It is an ordinary
//    account with no special treatment, so ADL haircuts it like anyone else.
//  - noise traders: open and close random leveraged positions against the book, so markets have volume (and
//    graduate) and gaps have somebody to liquidate. They also snipe new creator coins with small amounts and
//    trade the curves of open ones.

use crate::book::{Side, Tif};
use crate::command::{
    BotQuote, Command, CreateAccount, Deposit, PlaceOrder, Snipe, SpotBuy, SpotSell,
};
use crate::exchange::{Exchange, Kind, OrderInput};
use crate::money::{Amount, Dec, Tokens};
use crate::rng::Rng;
use crate::units::{coins_dec, pow10, usd, ONE};
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
    Trader {
        id: "ape",
        deposit: "25000",
        aggression: 0.9,
    },
    Trader {
        id: "degen",
        deposit: "10000",
        aggression: 1.0,
    },
    Trader {
        id: "whale",
        deposit: "150000",
        aggression: 0.4,
    },
    Trader {
        id: "scalper",
        deposit: "20000",
        aggression: 0.6,
    },
];

struct Ladder {
    offsets: [f64; 6], // perps and attention: fraction of price; binaries: absolute price
    usd: [f64; 6],     // notional per level
    max_inventory_usd: f64,
}

fn ladder(kind: Kind) -> Ladder {
    match kind {
        Kind::Perp => Ladder {
            offsets: [0.0005, 0.0012, 0.0025, 0.005, 0.01, 0.02],
            usd: [1500., 2500., 4000., 7000., 12000., 20000.],
            max_inventory_usd: 250_000.,
        },
        Kind::Binary => Ladder {
            offsets: [0.005, 0.01, 0.02, 0.035, 0.055, 0.08],
            usd: [300., 500., 900., 1500., 2500., 4000.],
            max_inventory_usd: 40_000.,
        },
        Kind::Attention => Ladder {
            offsets: [0.004, 0.01, 0.02, 0.04, 0.07, 0.12],
            usd: [60., 120., 250., 500., 900., 1500.],
            max_inventory_usd: 6_000.,
        },
        // No outside price to lean on: quote wider, so the book (which is the oracle) moves on real flow.
        Kind::Preipo => Ladder {
            offsets: [0.004, 0.01, 0.02, 0.035, 0.06, 0.1],
            usd: [1000., 1500., 2500., 4000., 6000., 10000.],
            max_inventory_usd: 80_000.,
        },
    }
}

#[derive(Serialize)]
pub struct BotSummary {
    id: &'static str,
    wallet: String,
}

/// The bots' intake side: which market to requote next, and the randomness behind every trader's choice. The bots
/// are ordinary clients: they read the exchange and submit commands like anyone; nothing here is exchange state.
/// Whole dollars as a wallet amount.
fn whole_usd(usd: i64) -> Amount {
    Amount::Exact(Dec::from_nano(usd as i128 * ONE))
}

pub struct Bots {
    cursor: usize,
    rng: Rng,
}

impl Bots {
    pub fn new() -> Self {
        Bots {
            cursor: 0,
            rng: Rng::from_time(),
        }
    }

    pub fn ids() -> impl Iterator<Item = &'static str> {
        std::iter::once(MM).chain(TRADERS.iter().map(|t| t.id))
    }

    /// Accounts and paper money for any bot that doesn't exist yet.
    pub fn setup(x: &Exchange) -> Vec<Command> {
        let wanted =
            std::iter::once((MM, MM_DEPOSIT)).chain(TRADERS.iter().map(|t| (t.id, t.deposit)));
        wanted
            .filter(|(id, _)| !x.accounts.contains_key(*id))
            .flat_map(|(id, deposit)| {
                [
                    CreateAccount {
                        name: id.into(),
                        api_key: crate::intake::api_key(),
                        bot: true,
                    }
                    .into(),
                    Deposit {
                        account: id.into(),
                        amount: Dec::parse(deposit).expect("a bot deposit"),
                    }
                    .into(),
                ]
            })
            .collect()
    }

    /// The next few markets to requote, rather than all at once.
    pub fn next_quotes(&mut self, x: &Exchange, n: usize) -> Vec<Command> {
        let mut ids: Vec<&String> = x.markets.keys().collect();
        ids.sort();
        (0..n.min(ids.len()))
            .map(|_| {
                let id = ids[self.cursor % ids.len()].clone();
                self.cursor += 1;
                BotQuote { market: id }.into()
            })
            .collect()
    }

    /// One random action by one noise trader, and a line for the log if it's worth one.
    pub fn noise(&mut self, x: &Exchange) -> (Vec<Command>, Option<String>) {
        let t = &TRADERS[self.rng.below(TRADERS.len())];
        if self.rng.next() > t.aggression {
            return (vec![], None);
        }
        let wallet = x.wallet(t.id);
        if wallet > 500 * ONE {
            if let Some(cmd) = self.coins(x, t.id) {
                return (vec![cmd], None);
            }
        }
        let open: Vec<String> = x
            .state
            .markets
            .values()
            .filter(|m| {
                m.status == Status::Open && m.positions.get(t.id).is_some_and(|p| p.size != 0)
            })
            .map(|m| m.id.clone())
            .collect();

        if !open.is_empty() && (self.rng.next() < 0.35 || open.len() >= 4) {
            let id = &open[self.rng.below(open.len())];
            let size = x.size_of(id, t.id);
            let sz = x.markets[id.as_str()].sz_decimals;
            let side = if size > 0 { Side::Sell } else { Side::Buy };
            let order = OrderInput {
                reduce_only: true,
                slippage: Some(0.03),
                ..OrderInput::market(id, side, coins_dec(sz, size.abs()))
            };
            return (
                vec![PlaceOrder {
                    account: t.id.into(),
                    order,
                }
                .into()],
                None,
            );
        }

        if wallet < 50 * ONE {
            if open.is_empty() {
                let refill = Deposit {
                    account: t.id.into(),
                    amount: Dec::parse(t.deposit).expect("a bot deposit"),
                }
                .into();
                return (
                    vec![refill],
                    Some(format!("{} is broke; refilled ${}", t.id, t.deposit)),
                );
            }
            return (vec![], None);
        }

        let candidates: Vec<String> = x
            .markets
            .keys()
            .filter(|id| {
                let m = &x.state.markets[id.as_str()];
                let b = &x.books[id.as_str()];
                m.status == Status::Open
                    && m.mark.is_some()
                    && !b.bids.is_empty()
                    && !b.asks.is_empty()
            })
            .cloned()
            .collect();
        if candidates.is_empty() {
            return (vec![], None);
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
        if lots.is_nan() || lots < 1.0 {
            return (vec![], None);
        }
        // Mild momentum: follow the last few minutes of the chart more often than not.
        let cs = x
            .candles
            .get(id.as_str())
            .map(|c| c.as_slice())
            .unwrap_or(&[]);
        let recent = &cs[cs.len().saturating_sub(5)..];
        let drift = if recent.len() > 1 {
            recent[recent.len() - 1].c - recent[0].o
        } else {
            0
        };
        let p_buy = if drift > 0 {
            0.6
        } else if drift < 0 {
            0.4
        } else {
            0.5
        };
        let side = if self.rng.next() < p_buy {
            Side::Buy
        } else {
            Side::Sell
        };
        let order = OrderInput {
            leverage: Some(lev.min(max_lev)),
            slippage: Some(0.03),
            ..OrderInput::market(id, side, coins_dec(sz, lots as i128))
        };
        (
            vec![PlaceOrder {
                account: t.id.into(),
                order,
            }
            .into()],
            None,
        )
    }

    /// Maybe snipe a coin in its window (once each, $20–300) or trade an open curve ($20–200).
    fn coins(&mut self, x: &Exchange, id: &str) -> Option<Command> {
        let now = x.now();
        let sniping: Vec<String> = x
            .markets
            .values()
            .filter(|m| {
                m.launch.as_ref().is_some_and(|l| {
                    l.opened.is_none()
                        && now < l.opens_at
                        && !l.bids.iter().any(|b| b.account == id)
                })
            })
            .map(|m| m.id.clone())
            .collect();
        if !sniping.is_empty() && self.rng.next() < 0.5 {
            let coin = &sniping[self.rng.below(sniping.len())];
            let usdc = 20 + (self.rng.next() * 280.0) as i64;
            return Some(
                Snipe {
                    account: id.into(),
                    market: coin.clone(),
                    usdc: whole_usd(usdc),
                }
                .into(),
            );
        }
        if self.rng.next() >= 0.15 {
            return None;
        }
        let curves: Vec<String> = x
            .state
            .markets
            .values()
            .filter(|m| {
                m.status == Status::Open
                    && m.curve.is_some()
                    && m.launch.as_ref().is_none_or(|l| l.open)
            })
            .map(|m| m.id.clone())
            .collect();
        if curves.is_empty() {
            return None;
        }
        let coin = curves[self.rng.below(curves.len())].clone();
        let held = x
            .state
            .accounts
            .get(id)
            .and_then(|a| a.spot.get(&coin))
            .copied()
            .unwrap_or(0);
        Some(if held > 1 && self.rng.next() < 0.4 {
            SpotSell {
                account: id.into(),
                market: coin,
                tokens: Tokens::Exact(held / 2),
            }
            .into()
        } else {
            let usdc = 20 + (self.rng.next() * 180.0) as i64;
            SpotBuy {
                account: id.into(),
                market: coin,
                usdc: whole_usd(usdc),
            }
            .into()
        })
    }

    pub fn summary(x: &Exchange) -> Vec<BotSummary> {
        Bots::ids()
            .map(|id| BotSummary {
                id,
                wallet: usd(x.wallet(id)),
            })
            .collect()
    }
}

/// Replace the market maker's ladder in one market (the BotQuote command, inside the core: a function of the
/// exchange alone). Its float math replays identically anywhere: only IEEE-754 basic operations (+ − × ÷,
/// floor, ceil, round, comparisons), which are correctly rounded on every platform, and exact powers of ten; no
/// transcendental functions. The noise traders' float math (powf) runs at intake, and only its result is
/// journaled.
pub fn quote(x: &mut Exchange, id: &str) {
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
        let _ = x.deposit(MM, Dec::from_nano(1_000_000 * ONE));
    }

    let ladder = ladder(meta.kind);
    let scale = pow10(meta.sz_decimals) as f64;
    let mark = mark_lot as f64 * scale / 1e9; // coin price
    let tick = meta.tick as f64 / 1e9;
    let inv_usd = pos as f64 * mark_lot as f64 / 1e9;
    let skew = (inv_usd / ladder.max_inventory_usd).clamp(-1.0, 1.0);
    // Lean against inventory: long → lower both sides, so asks fill first.
    let binary = meta.kind == Kind::Binary;
    let center = if binary {
        mark - skew * 0.01
    } else {
        mark * (1.0 - skew * ladder.offsets[1])
    };
    let hi = if binary { 1.0 - tick } else { f64::INFINITY };

    for (off, notional) in ladder.offsets.iter().zip(ladder.usd) {
        let d = if binary { *off } else { center * off };
        if skew < 0.98 {
            place(
                x,
                id,
                Side::Buy,
                tick.max(((center - d) / tick).floor() * tick),
                notional,
                lev,
            );
        }
        if skew > -0.98 {
            place(
                x,
                id,
                Side::Sell,
                hi.min(((center + d) / tick).ceil() * tick),
                notional,
                lev,
            );
        }
    }
}

fn place(x: &mut Exchange, id: &str, side: Side, price: f64, notional: f64, leverage: f64) {
    if price.is_nan() || price <= 0.0 || !price.is_finite() {
        return;
    }
    let meta = &x.markets[id];
    let price_nano = (price * 1e9 / meta.tick as f64).round() as i128 * meta.tick;
    if price_nano <= 0 {
        return;
    }
    let scale = pow10(meta.sz_decimals) as f64;
    let lots = ((notional / price) * scale).floor().max(1.0) as i128;
    let size = coins_dec(meta.sz_decimals, lots);
    let input = OrderInput {
        tif: Some(Tif::Alo),
        leverage: Some(leverage),
        ..OrderInput::limit(id, side, Dec::from_nano(price_nano), size)
    };
    let _ = x.place_order(crate::bots::MM, input); // crossed a user's resting order, or margin: skip this level
}
