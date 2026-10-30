// The exchange: a central limit order book per market in front of the Impulse risk engine.
//
// The engine owns every dollar (wallets, per-market collateral, positions) and runs liquidation and ADL inside
// each transition. The exchange owns what the engine doesn't model: resting orders, matching, account keys,
// market metadata, and history. Every match becomes one atomic engine transaction:
//   allocate margin for each side (auto-margin, isolated) → trade at the maker's price
// and either commits whole or not at all. Feed ticks, curve trades and the clock are engine events too, so
// "solvent after every transition" holds for the live venue exactly as it does in replay.

use crate::book::{Book, Order, Side, Tif};
use crate::units::{auto_tick, cents, coin_price, coins_from_lots, dec, fmt, group, lot_price, lots_from_coins, parse_fixed, pow10, usd};
use impulse_engine::fixed::ceil_div;
use impulse_engine::ser::{big, Num};
use impulse_engine::{apply, equity, initial_margin, initial_state, leverage_now, ApplyError, Effect, Event, Market, MarketEvent, Position, State, Status};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, PartialEq)]
pub enum ExError {
    /// A refusal the caller can see: HTTP status and message.
    Http(u16, String),
    /// What the TS server would throw as a plain Error (malformed engine input, broken invariant): a 500.
    Internal(String),
}

impl ExError {
    pub fn bad(msg: impl Into<String>) -> Self {
        ExError::Http(400, msg.into())
    }
    pub fn status(status: u16, msg: impl Into<String>) -> Self {
        ExError::Http(status, msg.into())
    }
    pub fn message(&self) -> &str {
        match self {
            ExError::Http(_, m) | ExError::Internal(m) => m,
        }
    }
}

pub type XResult<T> = Result<T, ExError>;

// ---------- types ----------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Source {
    Hyperliquid {
        coin: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        dex: Option<String>,
    },
    Polymarket { market_id: String, token_id: String, outcome: String },
    /// attention market: the perp's oracle is its own spot curve
    Curve,
    /// offline random walk, volatility per step in bps
    Sim { vol_bps: f64 },
    /// admin ticks only
    Manual,
    /// pre-IPO: the mark comes from the market's own order book
    Book,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Perp,
    Binary,
    Attention,
    /// perp on a private company: no outside price until the admin IPO
    Preipo,
}

impl Kind {
    pub fn preset(self) -> &'static str {
        match self {
            Kind::Perp | Kind::Preipo => "perp",
            Kind::Binary => "binary",
            Kind::Attention => "attention",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketMeta {
    pub id: String,
    pub name: String,
    pub kind: Kind,
    pub base: String,
    pub sz_decimals: u32, // one lot = 10^-szDecimals coins
    #[serde(with = "big")]
    pub tick: i128, // price increment, nano-USD per coin
    pub source: Source,
    pub description: String,
    pub url: Option<String>,
    pub created_at: i64,
    pub creator: Option<String>,
    pub resolves_at_ms: Option<i64>,
    pub held_until: Option<i64>, // admin price override: feed ticks are ignored until then
    #[serde(default)]
    pub launch: Option<LaunchMeta>,
    #[serde(default)]
    pub preipo: Option<PreipoMeta>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreipoMeta {
    #[serde(with = "big")]
    pub seed: i128, // nano-USD per share: the mark until the book has a trade
    pub ipo_at: Option<i64>,
    #[serde(default, with = "impulse_engine::ser::big_opt")]
    pub ipo_price: Option<i128>, // nano-USD per share
}

/// Shares behind a pre-IPO valuation: implied valuation = mark × this.
pub const PREIPO_SHARES: i128 = 1_000_000_000;

/// A creator coin's snipe window, as the exchange sees it: when it opens and every bid, for the views. The
/// engine holds the money (net bids per account) and does the open.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchMeta {
    pub opens_at: i64,
    pub bids: Vec<SnipeBid>, // in time order
    pub opened: Option<Opened>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SnipeBid {
    pub account: String,
    #[serde(with = "big")]
    pub usdc: i128, // what the bidder paid, fee included
    pub time: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Opened {
    #[serde(with = "big")]
    pub open_price: i128, // nano-USD per token
    pub opened_at: i64,
    #[serde(with = "big")]
    pub sniped: i128, // bids net of the fee: what bought the tokens
    #[serde(with = "big")]
    pub tokens_sold: i128,
    #[serde(with = "big")]
    pub reserve: i128,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSpec {
    pub id: String,
    pub kind: Kind,
    pub source: Source,
    pub name: Option<String>,
    pub base: Option<String>,
    pub sz_decimals: Option<u32>,
    pub tick: Option<String>,  // coin price
    pub price: Option<String>, // first oracle price (coin price) for externally priced markets
    pub description: Option<String>,
    pub url: Option<String>,
    pub creator: Option<String>,
    pub adl: Option<String>,
    pub oracle_window: Option<f64>,
    pub fee_bps: Option<f64>,
    pub resolves_at_ms: Option<i64>,
    pub taper_seconds: Option<f64>,
    pub initial_leverage: Option<f64>,
    pub maintenance_leverage: Option<f64>,
    pub snipe_seconds: Option<i64>, // attention markets: open with a snipe window this long
}

impl MarketSpec {
    pub fn new(id: impl Into<String>, kind: Kind, source: Source) -> Self {
        MarketSpec {
            id: id.into(),
            kind,
            source,
            name: None,
            base: None,
            sz_decimals: None,
            tick: None,
            price: None,
            description: None,
            url: None,
            creator: None,
            adl: None,
            oracle_window: None,
            fee_bps: None,
            resolves_at_ms: None,
            taper_seconds: None,
            initial_leverage: None,
            maintenance_leverage: None,
            snipe_seconds: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountMeta {
    pub id: String,
    pub api_key: String,
    pub bot: bool,
    pub created_at: i64,
    pub last_faucet: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FillKind {
    Perp,
    Spot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fill {
    pub id: u64,
    pub time: i64,
    pub market: String,
    pub kind: FillKind,
    #[serde(with = "big")]
    pub price: i128, // nano-USD per lot (spot: average incl. fee)
    #[serde(with = "big")]
    pub size: i128, // lots
    pub side: Side, // taker side
    pub taker: String,
    pub maker: String, // "curve" for spot
    pub taker_order: Option<u64>,
    pub maker_order: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskKind {
    Liquidation,
    Bankrupt,
    Haircut,
    Adl,
    Settlement,
    Graduation,
    Gap,
    Listing,
    Open,
    Ipo,
}

/// Serialized as is for the API and the websocket feed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct RiskEvent {
    pub id: u64,
    pub time: i64,
    pub market: String,
    pub kind: RiskKind,
    pub accounts: Vec<String>,
    pub text: String,
    pub amount: Option<String>, // USD, where there is one
    pub price: Option<String>,  // mark at the event (USD per coin), for chart markers
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Candle {
    pub t: i64, // minute start, ms
    #[serde(with = "big")]
    pub o: i128, // mark, nano-USD per lot
    #[serde(with = "big")]
    pub h: i128,
    #[serde(with = "big")]
    pub l: i128,
    #[serde(with = "big")]
    pub c: i128,
    #[serde(with = "big")]
    pub v: i128, // traded notional, nano-USD
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderType {
    Limit,
    Market,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderInput {
    pub market: String,
    pub side: Side,
    pub kind: OrderType,
    pub size: String,          // coins
    pub price: Option<String>, // coin price, limit orders
    pub leverage: Option<f64>,
    pub reduce_only: bool,
    pub tif: Option<Tif>,
    pub slippage: Option<f64>, // market orders: worst acceptable price as a fraction of mark (default 5%)
}

impl OrderInput {
    pub fn market(market: &str, side: Side, size: String) -> Self {
        OrderInput { market: market.into(), side, kind: OrderType::Market, size, price: None, leverage: None, reduce_only: false, tif: None, slippage: None }
    }
    pub fn limit(market: &str, side: Side, price: String, size: String) -> Self {
        OrderInput { kind: OrderType::Limit, price: Some(price), ..OrderInput::market(market, side, size) }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderStatus {
    Filled,
    Partial,
    Resting,
    Cancelled,
}

pub struct OrderResult {
    pub order: Order,
    pub fills: Vec<Fill>,
    pub status: OrderStatus,
    pub reason: Option<String>,
}

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
    (1..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b"@_.-".contains(&b))
}

/// Did the engine reject a trade because of this account (its margin, or no collateral bucket at all)?
fn blames(reason: &str, account: &str) -> bool {
    reason.starts_with(&format!("{account}:")) || reason.starts_with(&format!("{account} has no collateral"))
}

/// String(n) for a JS number, as the TS server hands numeric config to the engine.
fn js_number(v: f64) -> String {
    if v.fract() == 0.0 && v.abs() < 1e21 {
        format!("{}", v as i128)
    } else {
        v.to_string()
    }
}

fn parse(v: &str) -> XResult<i128> {
    parse_fixed(v).map_err(ExError::bad)
}

fn ev_deposit(account: &str, amount: String) -> Event {
    Event::Deposit { account: account.into(), amount: amount.into() }
}

fn ev_allocate(account: &str, market: &str, amount: String) -> Event {
    Event::Allocate { account: account.into(), market: market.into(), amount: amount.into() }
}

fn ev_release(account: &str, market: &str, amount: String) -> Event {
    Event::Release { account: account.into(), market: market.into(), amount: amount.into() }
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
    order_market: BTreeMap<u64, String>, // resting order id → market, in time priority
    #[serde(skip)]
    pub version: u64, // bumps on every change: the websocket hub diffs on it, and the journal records a step only if it moved
    /// The current step's time (wall-clock ms), set at intake. The core never reads a clock.
    #[serde(default)]
    pub now: i64,
    /// Admin switch for the house bots (they only act while it's on).
    #[serde(default = "yes")]
    pub bots_enabled: bool,
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
            order_market: BTreeMap::new(),
            version: 0,
            now: genesis,
            bots_enabled: true,
        }
    }

    /// Rebuild the indexes a snapshot doesn't carry.
    pub fn restored(mut self) -> Self {
        self.keys = self.accounts.values().map(|a| (a.api_key.clone(), a.id.clone())).collect();
        self.order_market = self.books.iter().flat_map(|(id, b)| b.orders().map(move |o| (o.id, id.clone()))).collect();
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
        format!("{:016x}", crate::intake::fnv64(&serde_json::to_vec(self).expect("exchange serializes")))
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

    // ---------- lookups ----------

    pub fn market(&self, id: &str) -> XResult<&MarketMeta> {
        self.markets.get(id).ok_or_else(|| ExError::status(404, format!("unknown market \"{id}\"")))
    }

    fn market_mut(&mut self, id: &str) -> XResult<&mut MarketMeta> {
        self.version += 1;
        self.markets.get_mut(id).ok_or_else(|| ExError::status(404, format!("unknown market \"{id}\"")))
    }

    pub fn engine_market(&self, id: &str) -> XResult<&Market> {
        self.market(id)?;
        Ok(&self.state.markets[id])
    }

    pub fn account(&self, id: &str) -> XResult<&AccountMeta> {
        self.accounts.get(id).ok_or_else(|| ExError::status(404, format!("unknown account \"{id}\"")))
    }

    pub fn account_by_key(&self, key: &str) -> Option<&AccountMeta> {
        self.keys.get(key).and_then(|id| self.accounts.get(id))
    }

    pub fn wallet(&self, account: &str) -> i128 {
        self.state.accounts.get(account).map_or(0, |a| a.wallet)
    }

    pub fn position(&self, market: &str, account: &str) -> Option<&Position> {
        self.state.markets.get(market).and_then(|m| m.positions.get(account))
    }

    pub fn size_of(&self, market: &str, account: &str) -> i128 {
        self.position(market, account).map_or(0, |p| p.size)
    }

    /// Resting orders in time priority, optionally in one market.
    pub fn orders_of<'a>(&'a self, account: &'a str, market: Option<&'a str>) -> impl Iterator<Item = &'a Order> + 'a {
        self.order_market
            .iter()
            .filter(move |(_, m)| market.is_none_or(|want| want == m.as_str()))
            .filter_map(move |(id, m)| self.books.get(m)?.orders().find(|o| o.id == *id))
            .filter(move |o| o.account == account)
    }

    /// Engine time in seconds since genesis.
    pub fn engine_time(&self, ms: i64) -> i128 {
        ((ms - self.genesis).max(0) / 1000) as i128
    }

    // ---------- engine transactions ----------

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
            .flat_map(|m| m.positions.values().filter(|p| p.size == 0 && p.collateral > 0).map(|p| ev_release(&p.account, &m.id, "all".into())))
            .collect();
        if events.is_empty() {
            return;
        }
        if let Err(e) = self.exec(&events) {
            eprintln!("sweep failed (collateral stays in the market): {}", e.message());
        }
    }

    fn digest(&mut self, effects: &[Effect]) {
        let mut distressed = HashSet::new();
        for e in effects {
            if let Effect::Liquidation { market, account, .. } | Effect::Bankrupt { market, account, .. } = e {
                distressed.insert((market.clone(), account.clone()));
            }
        }
        for e in effects {
            match e {
                Effect::Liquidation { market, account, size, equity, .. } => {
                    let text = format!("{account} liquidated: {} closed at {}, kept ${}", self.side_size(market, *size), self.mark_str(market), cents(*equity));
                    self.record(market, RiskKind::Liquidation, vec![account.clone()], text, Some(*equity));
                    self.drop_orders(account, Some(market));
                }
                Effect::Bankrupt { market, account, size, shortfall } => {
                    let text = format!(
                        "{account} bankrupt: {} closed at {}, ${} shortfall charged to the other side",
                        self.side_size(market, *size),
                        self.mark_str(market),
                        cents(*shortfall)
                    );
                    self.record(market, RiskKind::Bankrupt, vec![account.clone()], text, Some(*shortfall));
                    self.drop_orders(account, Some(market));
                }
                Effect::Haircut { market, account, amount, from_principal } => {
                    let from = if *from_principal > 0 { format!(" (${} of it from principal)", cents(*from_principal)) } else { " (from profit)".into() };
                    let text = format!("{account} paid a ${} ADL haircut{from}", cents(*amount));
                    self.record(market, RiskKind::Haircut, vec![account.clone()], text, Some(*amount));
                }
                Effect::ForcedClose { market, closes } => {
                    let sz = self.markets[market.as_str()].sz_decimals;
                    for c in closes {
                        if distressed.contains(&(market.clone(), c.account.clone())) {
                            continue;
                        }
                        let text = format!("{} auto-deleveraged: {} force-closed at {}", c.account, self.side_size(market, -c.closed), fmt(coin_price(sz, c.price), 0));
                        self.record(market, RiskKind::Adl, vec![c.account.clone()], text, None);
                    }
                }
                Effect::Settlement { market, price, closes } => {
                    let sz = self.markets[market.as_str()].sz_decimals;
                    let text = format!("{market} resolved at {}; {} positions settled", fmt(coin_price(sz, *price), 0), closes.len());
                    self.record(market, RiskKind::Settlement, closes.iter().map(|c| c.account.clone()).collect(), text, None);
                    let ids: Vec<u64> = self.order_market.iter().filter(|(_, m)| *m == market).map(|(id, _)| *id).collect();
                    for id in ids {
                        self.remove_order(id);
                    }
                }
                Effect::Graduation { market, tier, leverage } => {
                    self.record(market, RiskKind::Graduation, vec![], format!("{market} graduated to tier {tier}: max leverage now {leverage}×"), None);
                }
                Effect::Mark { market, to, .. } => self.candle(market, *to, 0, None),
                Effect::Spot { market, account, usdc, tokens, .. } => {
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
                    };
                    self.push_fill(fill);
                    let mark = self.state.markets[market].mark.unwrap_or(0);
                    self.candle(market, mark, usdc.abs(), None);
                }
                Effect::Open { market, price, sniped, tokens, reserve, fills } => {
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
                    self.record(market, RiskKind::Open, fills.iter().filter(|f| f.tokens > 0).map(|f| f.account.clone()).collect(), text, Some(*sniped));
                    if let Some(l) = self.markets.get_mut(market.as_str()).and_then(|m| m.launch.as_mut()) {
                        l.opened = Some(Opened { open_price: *price, opened_at: now, sniped: *sniped, tokens_sold: *tokens, reserve: *reserve });
                    }
                    self.candle(market, *price, 0, None);
                }
                Effect::Funding { .. } => {} // funding accrues every clock step; positions carry the running total
            }
        }
    }

    fn bump_id(&mut self) -> u64 {
        self.version += 1;
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn side_size(&self, market: &str, size: i128) -> String {
        let meta = &self.markets[market];
        let coins = coins_from_lots(meta.sz_decimals, size.abs());
        let grouped = match coins.split_once('.') {
            Some((int, frac)) => format!("{}.{frac}", group(int)),
            None => group(&coins),
        };
        format!("{} {grouped} {}", if size > 0 { "long" } else { "short" }, meta.base)
    }

    /// Mark as a coin price ("—" if none).
    pub fn mark_str(&self, market: &str) -> String {
        self.mark_coin(market).map_or_else(|| "—".into(), |v| fmt(v, 0))
    }

    pub fn mark_coin(&self, market: &str) -> Option<i128> {
        let sz = self.markets.get(market)?.sz_decimals;
        self.state.markets.get(market)?.mark.map(|m| coin_price(sz, m))
    }

    pub fn record(&mut self, market: &str, kind: RiskKind, accounts: Vec<String>, text: String, amount: Option<i128>) {
        let id = self.bump_id();
        let price = self.mark_coin(market).map(|v| fmt(v, 0));
        self.risk.push_back(RiskEvent { id, time: self.now(), market: market.into(), kind, accounts, text, amount: amount.map(usd), price });
        while self.risk.len() > RISK_HISTORY {
            self.risk.pop_front();
        }
    }

    fn push_fill(&mut self, f: Fill) {
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
                return;
            }
        }
        let o = cs.last().map_or(lot_px, |c| c.c);
        cs.push(Candle { t, o, h: o.max(lot_px), l: o.min(lot_px), c: lot_px, v: volume });
        if cs.len() > CANDLES {
            let extra = cs.len() - CANDLES;
            cs.drain(..extra);
        }
    }

    // ---------- accounts and money ----------

    /// `api_key` comes from intake (the core has no randomness).
    pub fn create_account(&mut self, name: &str, bot: bool, api_key: &str) -> XResult<AccountMeta> {
        let id = name.trim();
        if !valid_name(id) {
            return Err(ExError::bad("name must be 3–16 letters, digits or _"));
        }
        if RESERVED.contains(&id.to_lowercase().as_str()) {
            return Err(ExError::status(409, format!("\"{id}\" is reserved")));
        }
        if self.accounts.keys().any(|a| a.eq_ignore_ascii_case(id)) {
            return Err(ExError::status(409, format!("name \"{id}\" is taken")));
        }
        let meta = AccountMeta { id: id.into(), api_key: api_key.into(), bot, created_at: self.now(), last_faucet: 0 };
        self.accounts.insert(id.into(), meta.clone());
        self.keys.insert(meta.api_key.clone(), id.into());
        self.version += 1;
        Ok(meta)
    }

    /// Paper money in. Bypasses the faucet's limits: for bots, tests and admin.
    pub fn deposit(&mut self, account: &str, amount: &str) -> XResult<()> {
        self.account(account)?;
        self.commit(&[ev_deposit(account, amount.into())])?;
        Ok(())
    }

    pub fn faucet(&mut self, account: &str) -> XResult<i128> {
        let last = self.account(account)?.last_faucet;
        let wallet = self.wallet(account);
        if wallet >= FAUCET_CAP {
            return Err(ExError::bad(format!("wallet already holds ${}; the faucet stops at ${}", usd(wallet), usd(FAUCET_CAP))));
        }
        let wait = last + FAUCET_COOLDOWN_MS - self.now();
        if wait > 0 {
            return Err(ExError::status(429, format!("faucet cooling down: try again in {}s", (wait + 999) / 1000)));
        }
        self.commit(&[ev_deposit(account, dec(FAUCET_AMOUNT))])?;
        let now = self.now();
        self.accounts[account].last_faucet = now;
        Ok(FAUCET_AMOUNT)
    }

    pub fn withdraw(&mut self, account: &str, amount: &str) -> XResult<()> {
        self.account(account)?;
        self.commit(&[Event::Withdraw { account: account.into(), amount: amount.into() }])?;
        Ok(())
    }

    /// Add (positive) or remove (negative) isolated margin on an open position.
    pub fn adjust_margin(&mut self, account: &str, market: &str, amount: &str) -> XResult<()> {
        self.account(account)?;
        let m = self.engine_market(market)?;
        if m.positions.get(account).is_none_or(|p| p.size == 0) {
            return Err(ExError::bad(format!("no open position in {market}")));
        }
        let v = parse(amount)?;
        if v == 0 {
            return Err(ExError::bad("amount must be non-zero"));
        }
        let e = if v > 0 { ev_allocate(account, market, dec(v)) } else { ev_release(account, market, dec(-v)) };
        self.commit(&[e])?;
        Ok(())
    }

    // ---------- markets and prices ----------

    pub fn create_market(&mut self, spec: MarketSpec) -> XResult<&MarketMeta> {
        if !valid_market_id(&spec.id) {
            return Err(ExError::bad("market id must be 1–32 letters, digits or @_.-"));
        }
        if self.markets.contains_key(&spec.id) {
            return Err(ExError::status(409, format!("market {} exists", spec.id)));
        }
        let kind = spec.kind;
        let sz = if matches!(kind, Kind::Perp | Kind::Preipo) { spec.sz_decimals.unwrap_or(0) } else { 0 };
        let source = if kind == Kind::Preipo { Source::Book } else { spec.source };
        let start = spec.price.as_deref().map(parse).transpose()?;
        if kind != Kind::Attention && source != Source::Manual && start.is_none() {
            return Err(ExError::bad("externally priced markets need a starting price"));
        }
        let tick = match (&spec.tick, kind) {
            (Some(t), _) => parse(t)?,
            (None, Kind::Binary) => 1_000_000,
            (None, Kind::Attention) => 1,
            (None, _) => auto_tick(start.unwrap_or(impulse_engine::fixed::ONE), sz),
        };
        if tick <= 0 || tick % pow10(sz) != 0 {
            return Err(ExError::bad("tick must be a positive whole number of nano-USD per lot"));
        }
        let num = |v: f64| Some(Num(js_number(v)));
        let event = Event::Market(MarketEvent {
            id: spec.id.clone(),
            preset: Some(kind.preset().into()),
            adl: Some(spec.adl.clone().unwrap_or_else(|| "pnl".into())),
            oracle_window: spec.oracle_window.and_then(num),
            fee_bps: spec.fee_bps.and_then(num),
            resolves_at: spec.resolves_at_ms.map(|ms| Num(self.engine_time(ms).to_string())),
            taper_seconds: spec.taper_seconds.and_then(num),
            initial_leverage: spec.initial_leverage.and_then(num),
            maintenance_leverage: spec.maintenance_leverage.and_then(num),
            launch: spec.snipe_seconds.map(|_| true),
            ..Default::default()
        });
        let meta = MarketMeta {
            id: spec.id.clone(),
            name: spec.name.unwrap_or_else(|| spec.id.clone()),
            kind,
            base: spec.base.unwrap_or_else(|| if kind == Kind::Binary { "YES".into() } else { spec.id.clone() }),
            sz_decimals: sz,
            tick,
            source,
            description: spec.description.unwrap_or_default(),
            url: spec.url,
            created_at: self.now(),
            creator: spec.creator.clone(),
            resolves_at_ms: spec.resolves_at_ms,
            held_until: None,
            launch: spec.snipe_seconds.map(|secs| LaunchMeta { opens_at: self.now() + secs * 1000, bids: vec![], opened: None }),
            preipo: (kind == Kind::Preipo).then(|| PreipoMeta { seed: start.unwrap_or(0), ipo_at: None, ipo_price: None }),
        };
        let mut events = vec![event];
        if let (Some(start), false) = (start, kind == Kind::Attention) {
            events.push(Event::Tick { market: spec.id.clone(), price: dec(clamp_lot(kind, lot_price(sz, start))).into() });
        }
        self.exec(&events)?; // validates the config before anything else is registered
        let id = spec.id;
        let name = meta.name.clone();
        self.markets.insert(id.clone(), meta);
        self.books.insert(id.clone(), Book::default());
        if let Some(mark) = self.state.markets[&id].mark {
            self.candle(&id, mark, 0, None);
        }
        let by = spec.creator.as_ref().map(|c| format!(" by {c}")).unwrap_or_default();
        self.record(&id, RiskKind::Listing, spec.creator.into_iter().collect(), format!("{id} listed{by}: {name}"), None);
        Ok(&self.markets[&id])
    }

    /// Oracle update from a feed (coin price, nano-USD). Ignored while an admin hold is active unless forced.
    /// Liquidation and ADL run inside the same transition.
    pub fn tick(&mut self, market: &str, coin_nano: i128, force: bool) -> XResult<Option<Vec<Effect>>> {
        let now = self.now();
        let meta = self.market(market)?;
        if meta.source == Source::Curve {
            return Err(ExError::bad(format!("{market} is priced by its own curve")));
        }
        if meta.source == Source::Book {
            return Err(ExError::bad(format!("{market} is priced by its own order book")));
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
        let effects = self.commit(&[Event::Tick { market: market.into(), price: dec(lot).into() }])?;
        self.candle(market, lot, 0, None);
        Ok(Some(effects))
    }

    /// Admin price override: set the oracle now and ignore the feed for `hold_seconds`.
    pub fn admin_price(&mut self, market: &str, price: &str, hold_seconds: f64) -> XResult<Vec<Effect>> {
        let now = self.now();
        let meta = self.market(market)?;
        if meta.source == Source::Curve {
            return Err(ExError::bad(format!("{market} is priced by its own curve; move it with spot trades")));
        }
        if meta.source == Source::Book {
            return Err(ExError::bad(format!("{market} is priced by its own order book until its IPO: use /api/admin/ipo")));
        }
        let sz = meta.sz_decimals;
        let before = self.state.markets[market].mark;
        let coin = parse(price)?;
        self.market_mut(market)?.held_until = if hold_seconds > 0.0 { Some(now + (hold_seconds * 1000.0) as i64) } else { None };
        let effects = self.tick(market, coin, true)?.unwrap_or_default();
        let busts = effects.iter().filter(|e| matches!(e, Effect::Liquidation { .. } | Effect::Bankrupt { .. })).count();
        let text = format!(
            "{market} oracle forced {} → {}{}: {busts} position{} liquidated or bankrupt",
            before.map_or_else(|| "—".into(), |b| fmt(coin_price(sz, b), 0)),
            self.mark_str(market),
            if hold_seconds > 0.0 { format!(" for {hold_seconds}s") } else { String::new() },
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

    pub fn resolve(&mut self, market: &str, price: &str) -> XResult<Vec<Effect>> {
        let sz = self.market(market)?.sz_decimals;
        let coin = parse(price)?;
        self.commit(&[Event::Resolve { market: market.into(), price: dec(lot_price(sz, coin)).into() }])
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
            effects = self.commit(&[Event::Advance { seconds: seconds.into() }])?;
        }
        let now = self.now();
        let due: Vec<String> = self.markets.values().filter(|m| m.launch.as_ref().is_some_and(|l| l.opened.is_none() && now >= l.opens_at)).map(|m| m.id.clone()).collect();
        for id in due {
            effects.extend(self.commit(&[Event::Open { market: id }])?);
        }
        let books: Vec<String> = self.markets.values().filter(|m| m.source == Source::Book).map(|m| m.id.clone()).collect();
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
                (mid != m.mid).then(|| Event::Book { market: id.clone(), mid: mid.map(|v| dec(v).into()) })
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
                v.sort();
                v[1]
            }
            _ => last,
        })
    }

    /// Move a book-priced market's mark to its book (liquidation and ADL run in that transaction). Liquidations
    /// cancel orders, which can move the book again, so repeat until it settles.
    fn reprice(&mut self, market: &str) -> XResult<Vec<Effect>> {
        let mut effects = vec![];
        for _ in 0..4 {
            if self.markets.get(market).is_none_or(|m| m.source != Source::Book) || self.state.markets[market].status != Status::Open {
                break;
            }
            let Some(lot) = self.book_mark(market) else { break };
            if Some(lot.max(1)) == self.state.markets[market].mark {
                break;
            }
            effects.extend(self.commit(&[Event::Tick { market: market.into(), price: dec(lot.max(1)).into() }])?);
            self.candle(market, lot.max(1), 0, None);
        }
        Ok(effects)
    }

    /// Admin IPO: the market leaves its book for an admin-set public price. The mark gaps to it, and liquidation
    /// and ADL run in that transaction.
    pub fn ipo(&mut self, market: &str, price: &str) -> XResult<Vec<Effect>> {
        let meta = self.market(market)?;
        if meta.preipo.is_none() {
            return Err(ExError::bad(format!("{market} is not a pre-IPO market")));
        }
        if meta.source != Source::Book {
            return Err(ExError::bad(format!("{market} has already had its IPO")));
        }
        let sz = meta.sz_decimals;
        let coin = parse(price)?;
        if coin <= 0 {
            return Err(ExError::bad("price must be positive"));
        }
        let before = self.mark_str(market);
        let lot = lot_price(sz, coin).max(1);
        let effects = if Some(lot) == self.state.markets[market].mark {
            vec![]
        } else {
            self.commit(&[Event::Tick { market: market.into(), price: dec(lot).into() }])?
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
        let (mut busts, mut shortfall) = (0, 0);
        for e in &effects {
            match e {
                Effect::Liquidation { account, .. } => {
                    busts += 1;
                    hit.push(account.clone());
                }
                Effect::Bankrupt { account, shortfall: s, .. } => {
                    busts += 1;
                    shortfall += s;
                    hit.push(account.clone());
                }
                Effect::Haircut { account, .. } => hit.push(account.clone()),
                _ => {}
            }
        }
        hit.dedup();
        let paid = if shortfall > 0 { format!("; ${} shortfall charged to the other side", cents(shortfall)) } else { String::new() };
        let text = format!(
            "{market} IPO at {}: mark gapped {before} → {}, {busts} position{} liquidated or bankrupt{paid}",
            fmt(coin, 0),
            self.mark_str(market),
            if busts == 1 { "" } else { "s" }
        );
        self.record(market, RiskKind::Ipo, hit, text, (shortfall > 0).then_some(shortfall));
        Ok(effects)
    }

    /// A snipe-window bid: USDC from the wallet, no cancel, filled at the open price.
    pub fn snipe(&mut self, account: &str, market: &str, usdc: &str) -> XResult<()> {
        self.account(account)?;
        let now = self.now();
        let Some(launch) = &self.market(market)?.launch else {
            return Err(ExError::bad(format!("{market} has no snipe window")));
        };
        if launch.opened.is_some() || now >= launch.opens_at {
            return Err(ExError::bad(format!("{market}'s snipe window has closed")));
        }
        let before = self.wallet(account);
        self.commit(&[Event::Snipe { account: account.into(), market: market.into(), amount: usdc.into() }])?;
        let paid = before - self.wallet(account);
        if let Some(l) = self.market_mut(market)?.launch.as_mut() {
            l.bids.push(SnipeBid { account: account.into(), usdc: paid, time: now });
        }
        Ok(())
    }

    /// Net bids waiting for a launch's open, per account (the engine's book of bids).
    pub fn pending_bids(&self, market: &str) -> Option<&BTreeMap<String, i128>> {
        self.state.markets.get(market)?.launch.as_ref().filter(|l| !l.open).map(|l| &l.bids)
    }

    /// Admin pump: the house account buys (usdc > 0) or sells about |usdc| of tokens (usdc < 0) on the curve.
    /// `house_key` (from intake) is the house account's API key if this pump creates it.
    pub fn pump(&mut self, market: &str, usdc: &str, house_key: &str) -> XResult<Vec<Effect>> {
        let meta = self.market(market)?;
        if meta.kind != Kind::Attention {
            return Err(ExError::bad(format!("{market} has no spot curve: use /api/admin/price")));
        }
        let v = parse(usdc)?;
        if v == 0 {
            return Err(ExError::bad("usdc must be non-zero"));
        }
        if !self.accounts.contains_key(HOUSE) {
            let meta = AccountMeta { id: HOUSE.into(), api_key: house_key.into(), bot: true, created_at: self.now(), last_faucet: 0 };
            self.version += 1;
            self.keys.insert(meta.api_key.clone(), HOUSE.into());
            self.accounts.insert(HOUSE.into(), meta);
        }
        if v > 0 {
            let short = v - self.wallet(HOUSE);
            let mut events = vec![];
            if short > 0 {
                events.push(ev_deposit(HOUSE, dec(short)));
            }
            events.push(Event::SpotBuy { account: HOUSE.into(), market: market.into(), amount: dec(v).into() });
            return self.commit(&events);
        }
        // Tokens whose sale nets about |usdc| after the fee: x − k/(y + t) = |usdc| / (1 − fee).
        let c = self.state.markets[market].curve.as_ref().expect("attention markets have a curve");
        let gross = (-v) * 10_000 / (10_000 - c.fee_bps);
        if gross >= c.x - c.x0 {
            return Err(ExError::bad(format!("the curve holds only ${} of real USDC", usd(c.x - c.x0))));
        }
        let tokens = ceil_div(c.x * c.y, c.x - gross) - c.y;
        let held = self.state.accounts.get(HOUSE).and_then(|a| a.spot.get(market)).copied().unwrap_or(0);
        if held == 0 {
            return Err(ExError::bad(format!("the house holds no {market} to sell: pump it up first")));
        }
        self.commit(&[Event::SpotSell { account: HOUSE.into(), market: market.into(), tokens: tokens.min(held).to_string().into() }])
    }

    // ---------- spot (attention curves) ----------

    pub fn spot_buy(&mut self, account: &str, market: &str, usdc: &str) -> XResult<Vec<Effect>> {
        self.account(account)?;
        self.market(market)?;
        self.commit(&[Event::SpotBuy { account: account.into(), market: market.into(), amount: usdc.into() }])
    }

    pub fn spot_sell(&mut self, account: &str, market: &str, tokens: &str) -> XResult<Vec<Effect>> {
        self.account(account)?;
        self.market(market)?;
        if tokens != "all" && (tokens.is_empty() || !tokens.bytes().all(|b| b.is_ascii_digit())) {
            return Err(ExError::bad("tokens must be a whole number or \"all\""));
        }
        self.commit(&[Event::SpotSell { account: account.into(), market: market.into(), tokens: tokens.into() }])
    }

    // ---------- orders ----------

    pub fn place_order(&mut self, account: &str, input: OrderInput) -> XResult<OrderResult> {
        self.account(account)?;
        let meta = self.market(&input.market)?.clone();
        let m = &self.state.markets[&meta.id];
        if m.status != Status::Open {
            return Err(ExError::bad(format!("{} is resolved", meta.id)));
        }
        let Some(mark) = m.mark else {
            return Err(ExError::bad(format!("{} has no price yet", meta.id)));
        };
        if m.launch.as_ref().is_some_and(|l| !l.open) {
            return Err(ExError::bad(format!("{} is in its snipe window: trading starts at the open", meta.id)));
        }
        let mut size = lots_from_coins(meta.sz_decimals, &input.size).map_err(|e| ExError::bad(format!("size: {e}")))?;
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
            return Err(ExError::bad(format!("leverage must be 1–{max_lev}× in {} right now", meta.id)));
        }

        let (lower, upper) = (m.config.lower, m.config.upper);
        let (price, tif) = match input.kind {
            OrderType::Market => {
                let slip = (input.slippage.unwrap_or(0.05).max(0.001).min(0.5) * 10_000.0).round() as i128;
                let band = (mark * slip / 10_000).max((meta.tick / pow10(meta.sz_decimals)) * 5);
                let mut price = if input.side == Side::Buy { mark + band } else { mark - band };
                if let Some(u) = upper {
                    price = price.min(u);
                }
                (price.max(lower.max(if upper.is_none() { 1 } else { lower })), Tif::Ioc)
            }
            OrderType::Limit => {
                let Some(p) = input.price.as_deref() else {
                    return Err(ExError::bad("limit orders need a price"));
                };
                let coin = parse_fixed(p).map_err(|e| ExError::bad(format!("price: {e}")))?;
                if coin <= 0 {
                    return Err(ExError::bad("price must be positive"));
                }
                if coin % meta.tick != 0 {
                    return Err(ExError::bad(format!("price must be a multiple of the tick {}", fmt(meta.tick, 0))));
                }
                let price = lot_price(meta.sz_decimals, coin);
                if price < lower || upper.is_some_and(|u| price > u) {
                    return Err(ExError::bad("price outside the market's bounds"));
                }
                (price, input.tif.unwrap_or(Tif::Gtc))
            }
        };

        let dir = input.side.dir();
        let cur = self.size_of(&meta.id, account);
        if input.reduce_only {
            if cur == 0 || cur.signum() == dir {
                return Err(ExError::bad("reduce-only order would not reduce a position"));
            }
            size = size.min(cur.abs());
        } else {
            self.check_affordable(&meta.id, account, dir * size, price, leverage)?;
        }
        if tif == Tif::Alo && self.books[&meta.id].crosses(input.side, price) {
            return Err(ExError::bad("post-only order would take liquidity"));
        }
        if tif != Tif::Ioc && self.orders_of(account, None).count() >= MAX_OPEN_ORDERS {
            return Err(ExError::bad(format!("at most {MAX_OPEN_ORDERS} open orders")));
        }

        let mut order = Order {
            id: self.bump_id(),
            account: account.into(),
            market: meta.id.clone(),
            side: input.side,
            price,
            size,
            filled: 0,
            leverage,
            reduce_only: input.reduce_only,
            tif,
            time: self.now(),
        };
        let (fills, stop) = self.match_order(&mut order)?;
        let status = if order.size == 0 {
            OrderStatus::Filled
        } else if tif != Tif::Ioc && stop.is_none() {
            self.order_market.insert(order.id, meta.id.clone());
            self.books.get_mut(&meta.id).expect("book").add(order.clone());
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
        self.reprice(&meta.id)?;
        let reason = stop.or_else(|| (status == OrderStatus::Cancelled).then(|| "no liquidity at or inside the limit price".into()));
        Ok(OrderResult { order, fills, status, reason })
    }

    /// Rough pre-trade check so obviously unaffordable orders don't rest. Fills re-check exactly.
    fn check_affordable(&self, market: &str, account: &str, delta: i128, price: i128, leverage: i128) -> XResult<()> {
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
        let wallet = self.wallet(account);
        let free = p.map_or(0, |p| 0.max(equity(p, m.mark) - initial_margin(m, p)));
        if need > wallet + free {
            return Err(ExError::bad(format!("insufficient balance: needs about ${} of margin, ${} available", usd(need), usd(wallet + free))));
        }
        Ok(())
    }

    fn match_order(&mut self, o: &mut Order) -> XResult<(Vec<Fill>, Option<String>)> {
        let mut fills = vec![];
        let opp = o.side.opposite();
        while o.size > 0 {
            let Some(maker) = self.books[&o.market].best(opp).cloned() else { break };
            if if o.side == Side::Buy { maker.price > o.price } else { maker.price < o.price } {
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
            match self.try_fill(o, &maker, qty)? {
                Ok(fill) => {
                    fills.push(fill);
                    o.size -= qty;
                    o.filled += qty;
                    // The fill's own risk processing may have cancelled the maker already.
                    if let Some(m) = self.books.get_mut(&o.market).and_then(|b| b.get_mut(maker.id)) {
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

    fn try_fill(&mut self, taker: &Order, maker: &Order, qty: i128) -> XResult<Result<Fill, Blame>> {
        let market = taker.market.clone();
        let price = maker.price;
        let (buyer, seller) = if taker.side == Side::Buy { (taker, maker) } else { (maker, taker) };
        let mut events = vec![];
        {
            let m = &self.state.markets[&market];
            for (o, d) in [(buyer, qty), (seller, -qty)] {
                let need = self.margin_for(m, &o.account, d, price, o.leverage);
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
        });
        match self.commit(&events) {
            Ok(_) => {}
            Err(ExError::Http(_, reason)) => {
                return Ok(Err(if blames(&reason, &maker.account) { Blame::Maker } else { Blame::Taker(reason) }));
            }
            Err(e) => return Err(e),
        }
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
        };
        self.push_fill(fill.clone());
        let mark = self.state.markets[&market].mark.expect("mark");
        self.candle(&market, mark, qty * price, None);
        self.reprice(&market)?;
        Ok(Ok(fill))
    }

    /// Auto-margin for one side of a fill: top the position's equity (after the fill, marked at the oracle) up to
    /// the larger of the engine's initial margin and the order's chosen leverage. Capped by the wallet; if that's
    /// not enough the engine rejects the trade and the matcher blames this side.
    pub fn margin_for(&self, m: &Market, account: &str, delta: i128, price: i128, leverage: i128) -> i128 {
        let p = m.positions.get(account);
        let cur = p.map_or(0, |p| p.size);
        let next = cur + delta;
        if next.abs() <= cur.abs() && next.signum() != -cur.signum() {
            return 0; // pure reduction needs nothing new
        }
        let mark = m.mark.expect("mark");
        let eq_after = p.map_or(0, |p| equity(p, Some(mark))) + delta * (mark - price);
        let lev = leverage.min(leverage_now(m).0);
        let engine_im = initial_margin(m, &Position { size: next, ..Default::default() });
        let mut chosen = ceil_div(next.abs() * mark, lev);
        let cap = if next > 0 { Some(next * (mark - m.config.lower)) } else { m.config.upper.map(|u| next.abs() * (u - mark)) };
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

    fn remove_order(&mut self, id: u64) -> Option<Order> {
        let market = self.order_market.remove(&id)?;
        self.version += 1;
        self.books.get_mut(&market)?.remove(id)
    }

    pub fn cancel(&mut self, account: &str, order_id: &str) -> XResult<()> {
        let owned = order_id.parse::<u64>().ok().filter(|id| self.orders_of(account, None).any(|o| o.id == *id));
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
    fn drop_orders(&mut self, account: &str, market: Option<&str>) -> Vec<Order> {
        let ids: Vec<u64> = self.orders_of(account, market).map(|o| o.id).collect();
        ids.into_iter().filter_map(|id| self.remove_order(id)).collect()
    }

    /// Prepend history older than the market's first candle, merged into 1m buckets (chart backfill).
    pub fn candles_from_history(&mut self, market: &str, points: &mut [(i64, i128, i128, i128, i128)]) {
        let Some(meta) = self.markets.get(market) else { return };
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
                _ => older.push(Candle { t, o: lot(o), h: lot(h), l: lot(l), c: lot(c), v: 0 }),
            }
        }
        older.append(cs);
        let extra = older.len().saturating_sub(CANDLES);
        *cs = older.split_off(extra);
        self.version += 1;
    }
}

enum Blame {
    Maker,
    Taker(String),
}

fn clamp_lot(kind: Kind, lot: i128) -> i128 {
    if kind == Kind::Binary {
        lot.clamp(0, impulse_engine::fixed::ONE)
    } else {
        lot.max(1)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A small session: a market, two accounts, a resting order and a fill.
    fn session(key: &str) -> Exchange {
        let mut x = Exchange::new(1_000_000);
        let spec = MarketSpec { price: Some("100".into()), sz_decimals: Some(2), ..MarketSpec::new("X", Kind::Perp, Source::Manual) };
        x.create_market(spec).unwrap();
        for (i, id) in ["alice", "bob"].into_iter().enumerate() {
            x.now += 1000;
            x.create_account(id, false, &format!("{key}{i}")).unwrap();
            x.deposit(id, "1000").unwrap();
        }
        x.now += 1000;
        x.place_order("bob", OrderInput::limit("X", Side::Sell, "100".into(), "5".into())).unwrap();
        x.place_order("alice", OrderInput::market("X", Side::Buy, "2".into())).unwrap();
        x
    }

    #[test]
    fn the_same_steps_at_the_same_times_give_the_same_hash() {
        assert_eq!(session("k").state_hash(), session("k").state_hash());
    }

    #[test]
    fn the_hash_covers_keys_time_books_and_history() {
        let base = session("k").state_hash();
        assert_ne!(session("other").state_hash(), base); // API keys
        let mut later = session("k");
        later.now += 1;
        assert_ne!(later.state_hash(), base); // the clock
        let mut cancelled = session("k");
        cancelled.cancel_all("bob", None).unwrap();
        assert_ne!(cancelled.state_hash(), base); // books and orders
        let mut noted = session("k");
        noted.record("X", RiskKind::Gap, vec![], "note".into(), None);
        assert_ne!(noted.state_hash(), base); // history
    }

    #[test]
    fn every_change_bumps_the_version() {
        let mut x = session("k");
        for step in [
            (|x: &mut Exchange| x.candle("X", 1, 0, None)) as fn(&mut Exchange),
            |x| x.record("X", RiskKind::Gap, vec![], "note".into(), None),
            |x| {
                x.release_hold("X").unwrap();
            },
            |x| {
                x.cancel_all("bob", None).unwrap();
            },
        ] {
            let v = x.version;
            step(&mut x);
            assert!(x.version > v);
        }
    }
}
