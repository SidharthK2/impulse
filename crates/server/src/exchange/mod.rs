// The exchange: a central limit order book per market in front of the Impulse risk engine.
//
// The engine owns every dollar (wallets, per-market collateral, positions) and runs liquidation and ADL inside
// each transition. The exchange owns what the engine doesn't model: resting orders, matching, account keys,
// market metadata, and history. Every match becomes one atomic engine transaction:
//   allocate margin for each side (auto-margin, isolated) → trade at the maker's price
// and either commits whole or not at all. Feed ticks, curve trades and the clock are engine events too, so
// "solvent after every transition" holds for the live venue exactly as it does in replay.
//
// The exchange is split by concern: types (its data), matching (orders), accounts (money), markets (listing and
// prices), launch (creator coins), preipo (book-priced markets), history (what the engine did, as records).

mod accounts;
mod history;
mod launch;
mod markets;
mod matching;
mod preipo;
mod types;

#[cfg(test)]
mod tests;

pub use types::*;

use crate::book::{Book, Order, Side, Tif};
use crate::money::{Amount, Dec, Tokens};
use crate::units::{
    auto_tick, cents, coin_price, coins_from_lots, dec, fmt, group, lot_price, lots_from_coins,
    pow10, usd,
};
use impulse_engine::fixed::ceil_div;
use impulse_engine::ser::{big, Num};
use impulse_engine::{
    apply, equity, initial_margin, initial_state, leverage_now, ApplyError, Effect, Event, Market,
    MarketEvent, Position, State, Status,
};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

const FILL_HISTORY: usize = 5000;
const RISK_HISTORY: usize = 2000;
const CANDLES: usize = 1440; // a day of 1m candles
pub const FAUCET_AMOUNT: i128 = 10_000 * impulse_engine::fixed::ONE;
const FAUCET_CAP: i128 = 100_000 * impulse_engine::fixed::ONE;
const FAUCET_COOLDOWN_MS: i64 = 60_000;
const MAX_OPEN_ORDERS: usize = 200;
const RESERVED: [&str; 3] = ["curve", "admin", HOUSE];
/// The account /api/admin/pump trades from.
pub const HOUSE: &str = "house";

fn valid_name(id: &str) -> bool {
    (3..=16).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn valid_market_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@_.-".contains(&b))
}

/// Did the engine reject a trade because of this account (its margin, or no collateral bucket at all)?
fn blames(reason: &str, account: &str) -> bool {
    reason.starts_with(&format!("{account}:"))
        || reason.starts_with(&format!("{account} has no collateral"))
}

/// String(n) for a JS number, as the TS server hands numeric config to the engine.
fn js_string(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i128)
    } else {
        v.to_string()
    }
}

/// An amount as the engine reads it: a decimal string, or "all".
fn engine_amount(a: Amount) -> Num {
    Num(a.to_string())
}

fn ev_deposit(account: &str, amount: String) -> Event {
    Event::Deposit {
        account: account.into(),
        amount: amount.into(),
    }
}

fn ev_allocate(account: &str, market: &str, amount: String) -> Event {
    Event::Allocate {
        account: account.into(),
        market: market.into(),
        amount: amount.into(),
    }
}

fn ev_release(account: &str, market: &str, amount: String) -> Event {
    Event::Release {
        account: account.into(),
        market: market.into(),
        amount: amount.into(),
    }
}

// ---------- exchange ----------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exchange {
    pub state: State,
    pub genesis: i64,
    pub markets: IndexMap<String, MarketMeta>, // listing order, which is the API's order
    pub books: BTreeMap<String, Book>,
    pub accounts: IndexMap<String, AccountMeta>,
    pub fills: VecDeque<Fill>,
    pub risk: VecDeque<RiskEvent>,
    pub candles: BTreeMap<String, Vec<Candle>>,
    pub next_id: u64, // orders, fills and risk events share one counter
    #[serde(skip)]
    keys: HashMap<String, String>, // api key → account
    #[serde(skip)]
    orders: BTreeMap<u64, Resting>, // resting order id → where it rests and whose it is, in time priority
    #[serde(skip)]
    pub version: u64, // bumps on every change: the websocket hub diffs on it, and the journal records a step only if it moved
    /// The current step's time (wall-clock ms), set at intake. The core never reads a clock.
    #[serde(default)]
    pub now: i64,
    /// Admin switch for the house bots (they only act while it's on).
    #[serde(default = "yes")]
    pub bots_enabled: bool,
    /// Candles changed since the store last looked: (market, minute). Not state; the read tables' to-do list.
    #[serde(skip)]
    pub dirty_candles: std::collections::BTreeSet<(String, i64)>,
}

fn yes() -> bool {
    true
}

impl Exchange {
    pub fn new(genesis: i64) -> Self {
        Exchange {
            state: initial_state(),
            genesis,
            markets: IndexMap::new(),
            books: BTreeMap::new(),
            accounts: IndexMap::new(),
            fills: VecDeque::new(),
            risk: VecDeque::new(),
            candles: BTreeMap::new(),
            next_id: 1,
            keys: HashMap::new(),
            orders: BTreeMap::new(),
            version: 0,
            now: genesis,
            bots_enabled: true,
            dirty_candles: Default::default(),
        }
    }

    /// Rebuild the indexes a snapshot doesn't carry.
    pub fn restored(mut self) -> Self {
        self.keys = self
            .accounts
            .values()
            .map(|a| (a.api_key.clone(), a.id.clone()))
            .collect();
        self.orders = self
            .books
            .iter()
            .flat_map(|(id, b)| {
                b.orders().map(move |o| {
                    (
                        o.id,
                        Resting {
                            market: id.clone(),
                            account: o.account.clone(),
                        },
                    )
                })
            })
            .collect();
        for id in self.markets.keys() {
            self.books.entry(id.clone()).or_default();
        }
        self
    }

    pub fn now(&self) -> i64 {
        self.now
    }

    /// Stable hash of the whole exchange: engine state, books and orders, accounts and keys, history, clock.
    pub fn state_hash(&self) -> String {
        format!(
            "{:016x}",
            crate::intake::fnv64(&serde_json::to_vec(self).expect("exchange serializes"))
        )
    }

    /// Treat downtime as a pause: shift the clock origin so engine time resumes where it stopped. Otherwise a restart
    /// would charge every open position the whole outage's funding (at whatever premium was last set) in one step.
    pub fn resume_after(&mut self, down_ms: i64) {
        if down_ms <= 0 {
            return;
        }
        self.genesis += down_ms;
        for m in self.markets.values_mut() {
            if let Some(t) = m.resolves_at_ms.as_mut() {
                *t += down_ms;
            }
            if let Some(t) = m.held_until.as_mut() {
                *t += down_ms;
            }
            if let Some(l) = m.launch.as_mut().filter(|l| l.opened.is_none()) {
                l.opens_at += down_ms;
            }
        }
        self.version += 1;
    }

    pub fn market(&self, id: &str) -> XResult<&MarketMeta> {
        self.markets
            .get(id)
            .ok_or_else(|| ExError::status(404, format!("unknown market \"{id}\"")))
    }

    fn market_mut(&mut self, id: &str) -> XResult<&mut MarketMeta> {
        self.version += 1;
        self.markets
            .get_mut(id)
            .ok_or_else(|| ExError::status(404, format!("unknown market \"{id}\"")))
    }

    pub fn engine_market(&self, id: &str) -> XResult<&Market> {
        self.market(id)?;
        Ok(&self.state.markets[id])
    }

    pub fn account(&self, id: &str) -> XResult<&AccountMeta> {
        self.accounts
            .get(id)
            .ok_or_else(|| ExError::status(404, format!("unknown account \"{id}\"")))
    }

    pub fn account_by_key(&self, key: &str) -> Option<&AccountMeta> {
        self.keys.get(key).and_then(|id| self.accounts.get(id))
    }

    pub fn wallet(&self, account: &str) -> i128 {
        self.state.accounts.get(account).map_or(0, |a| a.wallet)
    }

    pub fn position(&self, market: &str, account: &str) -> Option<&Position> {
        self.state
            .markets
            .get(market)
            .and_then(|m| m.positions.get(account))
    }

    pub fn size_of(&self, market: &str, account: &str) -> i128 {
        self.position(market, account).map_or(0, |p| p.size)
    }

    /// Engine time in seconds since genesis.
    pub fn engine_time(&self, ms: i64) -> i128 {
        ((ms - self.genesis).max(0) / 1000) as i128
    }

    /// Apply events in order to a copy of the state; commit only if all succeed.
    fn exec(&mut self, events: &[Event]) -> XResult<Vec<Effect>> {
        let mut next: Option<State> = None;
        let mut effects = vec![];
        for e in events {
            let base = next.as_ref().unwrap_or(&self.state);
            match apply(base, e) {
                Ok((s, eff)) => {
                    next = Some(s);
                    effects.extend(eff);
                }
                Err(ApplyError::Rejected(r)) => return Err(ExError::bad(r)),
                Err(ApplyError::Fatal(m)) => return Err(ExError::Internal(m)),
            }
        }
        if let Some(s) = next {
            self.state = s;
        }
        self.version += 1;
        Ok(effects)
    }

    /// exec, then record what the engine did and hand idle collateral back to wallets.
    fn commit(&mut self, events: &[Event]) -> XResult<Vec<Effect>> {
        let effects = self.exec(events)?;
        self.digest(&effects);
        self.sweep();
        Ok(effects)
    }

    /// Collateral in a flat position goes back to the wallet (isolated margin is posted per fill, on demand).
    fn sweep(&mut self) {
        let events: Vec<Event> = self
            .state
            .markets
            .values()
            .flat_map(|m| {
                m.positions
                    .values()
                    .filter(|p| p.size == 0 && p.collateral > 0)
                    .map(|p| ev_release(&p.account, &m.id, "all".into()))
            })
            .collect();
        if events.is_empty() {
            return;
        }
        if let Err(e) = self.exec(&events) {
            eprintln!(
                "sweep failed (collateral stays in the market): {}",
                e.message()
            );
        }
    }

    fn bump_id(&mut self) -> u64 {
        self.version += 1;
        let id = self.next_id;
        self.next_id += 1;
        id
    }
}

/// Where a resting order is, and whose: the index behind order lookups by id and by account.
struct Resting {
    market: String,
    account: String,
}

fn clamp_lot(kind: Kind, lot: i128) -> i128 {
    if kind == Kind::Binary {
        lot.clamp(0, impulse_engine::fixed::ONE)
    } else {
        lot.max(1)
    }
}
