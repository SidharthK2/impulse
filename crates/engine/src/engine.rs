// Impulse risk engine, ported from impulse-research: reference/engine/engine.ts: same events, effects, invariants and rounding.
// Markets are isolated shards: each owns its positions, collateral vault and config, and risk processing
// (liquidation + ADL) only ever reads and writes the market it runs in. Accounts hold a wallet and move
// collateral into per-market buckets explicitly.
// Every event is an atomic state transition: apply to a clone, assert invariants, commit or reject.

use crate::alloc::allocate;
use crate::fixed::{ceil_div, fmt_price, fmt_usd, isqrt, parse_fixed, parse_int, sign};
use crate::ser::{big, big_map, big_opt, Num};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const PPB: i128 = 1_000_000_000;

// ---------- parameters ----------

pub struct Tier {
    pub leverage: i128,
    pub volume: i128,
    pub depth: i128,
}

const USD: i128 = 1_000_000_000;

/// Leverage graduation tiers (OUR criteria; see impulse-research: reference/engine/engine.ts): a tier unlocks once cumulative traded notional
/// AND depth (open-interest notional at mark, plus real USDC in the spot curve) both reach its thresholds.
pub const GRADUATION: [Tier; 5] = [
    Tier {
        leverage: 5,
        volume: 100_000 * USD,
        depth: 10_000 * USD,
    },
    Tier {
        leverage: 10,
        volume: 1_000_000 * USD,
        depth: 50_000 * USD,
    },
    Tier {
        leverage: 20,
        volume: 10_000_000 * USD,
        depth: 250_000 * USD,
    },
    Tier {
        leverage: 50,
        volume: 100_000_000 * USD,
        depth: 1_000_000 * USD,
    },
    Tier {
        leverage: 100,
        volume: 1_000_000_000 * USD,
        depth: 5_000_000 * USD,
    },
];

/// Funding base rate per tier, ppb per hour (OUR parameters).
pub const FUNDING_BASE_PPB: [i128; 6] = [500_000, 250_000, 100_000, 50_000, 25_000, 12_500];
pub const FUNDING_PREMIUM_CAP_PPB: i128 = 40_000_000;

pub const DEFAULT_INITIAL_LEVERAGE: i128 = 3;
pub const DEFAULT_MAINTENANCE_LEVERAGE: i128 = 6;

// ---------- types ----------

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdlPolicy {
    Size,
    Pnl,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketConfig {
    #[serde(with = "big")]
    pub lower: i128,
    #[serde(with = "big_opt")]
    pub upper: Option<i128>,
    pub resolvable: bool,
    #[serde(with = "big")]
    pub initial_leverage: i128,
    #[serde(with = "big")]
    pub maintenance_leverage: i128,
    pub adl: AdlPolicy,
    pub graduation: bool,
    pub funding: bool,
    #[serde(with = "big_opt")]
    pub resolves_at: Option<i128>,
    #[serde(with = "big")]
    pub taper_seconds: i128,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub account: String,
    #[serde(with = "big")]
    pub collateral: i128,
    #[serde(with = "big")]
    pub size: i128,
    #[serde(with = "big")]
    pub basis: i128,
    #[serde(with = "big")]
    pub allocated: i128,
    #[serde(with = "big")]
    pub realized: i128,
    #[serde(with = "big")]
    pub adl_transfer: i128,
    #[serde(with = "big")]
    pub funding: i128,
}

/// Mirror-style spot market: xy=k bonding curve on virtual reserves (USDC x, tokens y).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Curve {
    #[serde(with = "big")]
    pub x0: i128,
    #[serde(with = "big")]
    pub y0: i128,
    #[serde(with = "big")]
    pub x: i128,
    #[serde(with = "big")]
    pub y: i128,
    #[serde(with = "big")]
    pub fee_bps: i128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct OraclePoint {
    #[serde(with = "big")]
    pub t: i128,
    #[serde(with = "big")]
    pub price: i128,
}

/// Perp oracle read from the market's own curve: instant (window 0) or a time-weighted average.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurveOracle {
    #[serde(with = "big")]
    pub window: i128,
    pub history: Vec<OraclePoint>,
}

/// Creator-coin launch: a snipe window before the curve opens. Bids are USDC from the wallet (net of the spot fee)
/// and can't be cancelled. At the open, the whole book of bids buys from the curve at one price (see on_open).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Launch {
    pub open: bool,
    /// net USDC per account, waiting for the open
    #[serde(with = "big_map")]
    pub bids: BTreeMap<String, i128>,
    /// after the open: the part of the bids the curve didn't take, held by the market
    #[serde(with = "big")]
    pub reserve: i128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Open,
    Resolved,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub id: String,
    pub config: MarketConfig,
    pub curve: Option<Curve>,
    pub oracle: Option<CurveOracle>,
    pub launch: Option<Launch>,
    #[serde(with = "big_opt")]
    pub mark: Option<i128>,
    #[serde(with = "big")]
    pub time: i128,
    pub tier: usize,
    #[serde(with = "big")]
    pub volume: i128,
    #[serde(with = "big_opt")]
    pub last_trade: Option<i128>,
    /// order-book mid from the exchange (`book` events): the funding premium's perp price
    #[serde(with = "big_opt")]
    pub mid: Option<i128>,
    #[serde(with = "big")]
    pub funding_rate: i128,
    pub status: Status,
    #[serde(with = "big")]
    pub vault: i128,
    pub positions: BTreeMap<String, Position>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub id: String,
    #[serde(with = "big")]
    pub wallet: i128,
    #[serde(with = "big_map")]
    pub spot: BTreeMap<String, i128>,
    #[serde(with = "big")]
    pub deposited: i128,
    #[serde(with = "big")]
    pub withdrawn: i128,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub seq: u64,
    #[serde(with = "big")]
    pub time: i128,
    #[serde(with = "big")]
    pub fees: i128,
    #[serde(with = "big")]
    pub total_deposits: i128,
    #[serde(with = "big")]
    pub total_withdrawals: i128,
    pub accounts: BTreeMap<String, Account>,
    pub markets: BTreeMap<String, Market>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CurveSpec {
    pub usdc: Option<Num>,
    pub tokens: Option<Num>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketEvent {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<(Num, Option<Num>)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub curve: Option<CurveSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_bps: Option<Num>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oracle_window: Option<Num>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adl: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graduation: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub funding: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolves_at: Option<Num>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub taper_seconds: Option<Num>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolvable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_leverage: Option<Num>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maintenance_leverage: Option<Num>,
    /// curve markets only: open with a snipe window (spot and perp trading wait for `open`)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub launch: Option<bool>,
}

/// Amounts are decimals, or "all" where the TS engine allows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Event {
    Market(MarketEvent),
    Deposit {
        account: String,
        amount: Num,
    },
    Withdraw {
        account: String,
        amount: Num,
    },
    Allocate {
        account: String,
        market: String,
        amount: Num,
    },
    Release {
        account: String,
        market: String,
        amount: Num,
    },
    Trade {
        market: String,
        buyer: String,
        seller: String,
        size: Num,
        price: Num,
    },
    Tick {
        market: String,
        price: Num,
    },
    SpotBuy {
        account: String,
        market: String,
        amount: Num,
    },
    SpotSell {
        account: String,
        market: String,
        tokens: Num,
    },
    Advance {
        seconds: Num,
    },
    Resolve {
        market: String,
        price: Num,
    },
    /// bid USDC into a launch; "all" allowed
    Snipe {
        account: String,
        market: String,
        amount: Num,
    },
    /// end a launch's snipe window: fill every bid at one price
    Open {
        market: String,
    },
    /// the exchange's order-book mid (None: a side is empty)
    Book {
        market: String,
        mid: Option<Num>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LaunchFill {
    pub account: String,
    /// net bid
    #[serde(with = "big")]
    pub usdc: i128,
    #[serde(with = "big")]
    pub tokens: i128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ForcedClose {
    pub account: String,
    #[serde(with = "big")]
    pub closed: i128,
    #[serde(with = "big")]
    pub price: i128,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Effect {
    Liquidation {
        market: String,
        account: String,
        #[serde(with = "big")]
        size: i128,
        #[serde(with = "big")]
        equity: i128,
        #[serde(with = "big")]
        maintenance: i128,
    },
    Bankrupt {
        market: String,
        account: String,
        #[serde(with = "big")]
        size: i128,
        #[serde(with = "big")]
        shortfall: i128,
    },
    ForcedClose {
        market: String,
        closes: Vec<ForcedClose>,
    },
    Haircut {
        market: String,
        account: String,
        #[serde(with = "big")]
        amount: i128,
        #[serde(rename = "fromPrincipal", with = "big")]
        from_principal: i128,
    },
    Settlement {
        market: String,
        #[serde(with = "big")]
        price: i128,
        closes: Vec<ForcedClose>,
    },
    Spot {
        market: String,
        account: String,
        #[serde(with = "big")]
        usdc: i128,
        #[serde(with = "big")]
        tokens: i128,
        #[serde(with = "big")]
        fee: i128,
        #[serde(rename = "priceBefore", with = "big")]
        price_before: i128,
        #[serde(rename = "priceAfter", with = "big")]
        price_after: i128,
    },
    Mark {
        market: String,
        #[serde(with = "big")]
        from: i128,
        #[serde(with = "big")]
        to: i128,
        #[serde(with = "big")]
        spot: i128,
    },
    Funding {
        market: String,
        #[serde(with = "big")]
        rate: i128,
        #[serde(with = "big")]
        seconds: i128,
        #[serde(with = "big")]
        total: i128,
        payers: String,
    },
    Graduation {
        market: String,
        tier: usize,
        #[serde(with = "big")]
        leverage: i128,
    },
    Open {
        market: String,
        #[serde(with = "big")]
        price: i128,
        #[serde(with = "big")]
        sniped: i128,
        #[serde(with = "big")]
        tokens: i128,
        #[serde(with = "big")]
        reserve: i128,
        fills: Vec<LaunchFill>,
    },
}

impl Effect {
    /// The effect's `kind` tag, as it serializes.
    pub fn kind(&self) -> &'static str {
        match self {
            Effect::Liquidation { .. } => "liquidation",
            Effect::Bankrupt { .. } => "bankrupt",
            Effect::ForcedClose { .. } => "forcedClose",
            Effect::Haircut { .. } => "haircut",
            Effect::Settlement { .. } => "settlement",
            Effect::Spot { .. } => "spot",
            Effect::Mark { .. } => "mark",
            Effect::Funding { .. } => "funding",
            Effect::Graduation { .. } => "graduation",
            Effect::Open { .. } => "open",
        }
    }
}

/// Why a transition didn't commit. `Rejected` is an ordinary refusal (the TS engine's `Rejected`); `Fatal` is
/// what the TS engine throws as a plain Error: malformed input or a broken invariant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ApplyError {
    Rejected(String),
    Fatal(String),
}

impl ApplyError {
    pub fn message(&self) -> &str {
        match self {
            ApplyError::Rejected(s) | ApplyError::Fatal(s) => s,
        }
    }
}

type R<T> = Result<T, ApplyError>;

fn rej<T>(msg: impl Into<String>) -> R<T> {
    Err(ApplyError::Rejected(msg.into()))
}

fn fatal(msg: impl Into<String>) -> ApplyError {
    ApplyError::Fatal(msg.into())
}

fn fixed(s: &str) -> R<i128> {
    parse_fixed(s).map_err(fatal)
}

fn int(s: &str) -> R<i128> {
    parse_int(s).map_err(fatal)
}

pub fn initial_state() -> State {
    State::default()
}

// ---------- derived quantities ----------

pub fn equity(p: &Position, mark: Option<i128>) -> i128 {
    if p.size == 0 {
        return p.collateral - p.basis;
    }
    let mark =
        mark.unwrap_or_else(|| panic!("position {} has size but market has no mark", p.account));
    p.collateral + p.size * mark - p.basis
}

pub fn unrealized(p: &Position, mark: Option<i128>) -> i128 {
    if p.size == 0 {
        0
    } else {
        p.size * mark.expect("mark") - p.basis
    }
}

/// Worst-case loss before the price hits a bound; None if unbounded.
fn max_loss(m: &Market, p: &Position) -> Option<i128> {
    let mark = m.mark.expect("mark");
    if p.size > 0 {
        return Some(p.size * (mark - m.config.lower));
    }
    m.config.upper.map(|u| p.size.abs() * (u - mark))
}

/// Current max leverage: the graduation tier's, or the configured launch leverage at tier 0.
pub fn leverage_now(m: &Market) -> (i128, i128) {
    if m.tier == 0 {
        return (m.config.initial_leverage, m.config.maintenance_leverage);
    }
    let initial = GRADUATION[m.tier - 1].leverage;
    (
        initial,
        (initial * m.config.maintenance_leverage) / m.config.initial_leverage,
    )
}

/// Pre-resolution taper progress in ppb: 0 outside the taper window, rising linearly to 1e9 at resolvesAt.
pub fn taper_progress(m: &Market) -> i128 {
    let (Some(resolves_at), taper) = (m.config.resolves_at, m.config.taper_seconds) else {
        return 0;
    };
    if taper == 0 {
        return 0;
    }
    let start = resolves_at - taper;
    if m.time <= start {
        return 0;
    }
    if m.time >= resolves_at {
        return PPB;
    }
    ((m.time - start) * PPB) / taper
}

fn requirement(m: &Market, p: &Position, leverage: i128) -> i128 {
    if p.size == 0 {
        return 0;
    }
    let by_notional = ceil_div(p.size.abs() * m.mark.expect("mark"), leverage);
    let cap = max_loss(m, p);
    let normal = match cap {
        None => by_notional,
        Some(c) => c.min(by_notional),
    };
    let t = taper_progress(m);
    match cap {
        Some(c) if t != 0 => normal + ceil_div((c - normal) * t, PPB),
        _ => normal,
    }
}

pub fn initial_margin(m: &Market, p: &Position) -> i128 {
    requirement(m, p, leverage_now(m).0)
}

pub fn maintenance_margin(m: &Market, p: &Position) -> i128 {
    requirement(m, p, leverage_now(m).1)
}

/// Realized collateral that can leave the market while still covering initial margin.
pub fn releasable(m: &Market, p: &Position) -> i128 {
    0.max(p.collateral.min(equity(p, m.mark) - initial_margin(m, p)))
}

// ---------- curve and oracle ----------

/// nano-USD per token
pub fn spot_price(c: &Curve) -> i128 {
    c.x / c.y
}

/// Time-weighted average of the curve price over the oracle window ending now; None if no time has elapsed.
fn curve_mark(o: &CurveOracle, now: i128, spot: i128) -> Option<i128> {
    if o.window == 0 {
        return Some(spot);
    }
    let from = now - o.window;
    let mut weighted = 0;
    let mut start: Option<i128> = None;
    for (i, h) in o.history.iter().enumerate() {
        let seg_start = if h.t > from { h.t } else { from };
        let seg_end = o.history.get(i + 1).map_or(now, |n| n.t);
        if seg_end <= seg_start {
            continue;
        }
        start.get_or_insert(seg_start);
        weighted += h.price * (seg_end - seg_start);
    }
    match start {
        Some(s) if s != now => Some(weighted / (now - s)),
        _ => None, // a zero-width window says nothing: keep the previous mark
    }
}

/// Record the current spot price and recompute the mark. Returns a mark effect if it moved.
fn refresh_oracle(now: i128, m: &mut Market) -> Vec<Effect> {
    let (Some(curve), Some(oracle)) = (&m.curve, &mut m.oracle) else {
        return vec![];
    };
    let spot = spot_price(curve);
    let h = &mut oracle.history;
    match h.last_mut() {
        Some(last) if last.t == now => last.price = spot,
        Some(last) if last.price == spot => {}
        _ => h.push(OraclePoint {
            t: now,
            price: spot,
        }),
    }
    // Drop change points that ended before the window began (keep the one straddling its start).
    while h.len() > 1 && h[1].t <= now - oracle.window {
        h.remove(0);
    }
    let before = m.mark.expect("curve market has a mark");
    let next = curve_mark(oracle, now, spot).unwrap_or(before);
    m.mark = Some(next);
    if next == before {
        vec![]
    } else {
        vec![Effect::Mark {
            market: m.id.clone(),
            from: before,
            to: next,
            spot,
        }]
    }
}

// ---------- fills ----------

/// Apply a signed fill of `d` units at price `x`. Returns realized PnL.
fn fill(p: &mut Position, mut d: i128, x: i128) -> i128 {
    let mut realized = 0;
    if p.size != 0 && sign(d) != sign(p.size) {
        let r = d.abs().min(p.size.abs());
        let basis_removed = (p.basis * r) / p.size.abs(); // truncation stays inside this position
        realized = -sign(d) * r * x - basis_removed;
        p.basis -= basis_removed;
        p.collateral += realized;
        p.size += sign(d) * r;
        d -= sign(d) * r;
    }
    if d != 0 {
        p.size += d;
        p.basis += d * x;
    }
    p.realized += realized;
    realized
}

// ---------- lookups and parsing ----------

fn get_account<'a>(accounts: &'a mut BTreeMap<String, Account>, id: &str) -> R<&'a mut Account> {
    match accounts.get_mut(id) {
        Some(a) => Ok(a),
        None => rej(format!("unknown account \"{id}\"")),
    }
}

fn get_market<'a>(markets: &'a mut BTreeMap<String, Market>, id: &str) -> R<&'a mut Market> {
    match markets.get_mut(id) {
        Some(m) => Ok(m),
        None => rej(format!("unknown market \"{id}\"")),
    }
}

fn get_position(m: &Market, account: &str) -> R<Position> {
    match m.positions.get(account) {
        Some(p) => Ok(p.clone()),
        None => rej(format!("{account} has no collateral in {}", m.id)),
    }
}

fn parse_price(m: &Market, p: &str) -> R<i128> {
    let v = fixed(p)?;
    if v < m.config.lower || m.config.upper.is_some_and(|u| v > u) {
        let hi = m.config.upper.map_or_else(|| "∞".to_string(), fmt_price);
        return rej(format!(
            "price {p} outside [{}, {hi}] for {}",
            fmt_price(m.config.lower),
            m.id
        ));
    }
    if v <= 0 && m.config.upper.is_none() {
        return rej("unbounded markets need a positive price");
    }
    Ok(v)
}

fn parse_amount(amount: &Num, available: i128, what: &str) -> R<i128> {
    let all = amount.is("all");
    let v = if all { available } else { fixed(&amount.0)? };
    if v <= 0 {
        return rej(if all {
            format!("nothing to {what}")
        } else {
            format!("{what} must be positive")
        });
    }
    if v > available {
        return rej(format!(
            "{what} ${} exceeds available ${}",
            fmt_usd(v),
            fmt_usd(available)
        ));
    }
    Ok(v)
}

// ---------- event handlers ----------

fn on_market(s: &mut State, e: &MarketEvent) -> R<()> {
    if s.markets.contains_key(&e.id) {
        return rej(format!("market {} exists", e.id));
    }
    let binary = e.preset.as_deref() == Some("binary");
    let attention = e.preset.as_deref() == Some("attention");
    let (lo, hi) = match &e.bounds {
        Some((lo, hi)) => (lo.0.clone(), hi.as_ref().map(|h| h.0.clone())),
        None if binary => ("0".into(), Some("1".into())),
        None => ("0".into(), None),
    };
    let lower = fixed(&lo)?;
    let upper = match hi {
        Some(h) => Some(fixed(&h)?),
        None => None,
    };
    let resolvable = e.resolvable.unwrap_or(binary);
    let initial_leverage = match &e.initial_leverage {
        Some(n) => int(&n.0)?,
        None => DEFAULT_INITIAL_LEVERAGE,
    };
    let maintenance_leverage = match &e.maintenance_leverage {
        Some(n) => int(&n.0)?,
        None => DEFAULT_MAINTENANCE_LEVERAGE,
    };
    let adl = e.adl.clone().unwrap_or_else(|| "size".into());
    let resolves_at = match &e.resolves_at {
        Some(n) => Some(int(&n.0)?),
        None => None,
    };
    let taper_seconds = match &e.taper_seconds {
        Some(n) => int(&n.0)?,
        None => 0,
    };
    if lower < 0 || upper.is_some_and(|u| u <= lower) {
        return rej("bad bounds");
    }
    let adl = match adl.as_str() {
        "size" => AdlPolicy::Size,
        "pnl" => AdlPolicy::Pnl,
        other => return rej(format!("unknown ADL policy {other}")),
    };
    if (resolves_at.is_some() || taper_seconds > 0) && !resolvable {
        return rej("only resolvable markets can schedule resolution");
    }
    if taper_seconds < 0 || (taper_seconds > 0 && resolves_at.is_none()) {
        return rej("taper needs resolvesAt");
    }
    if initial_leverage < 1 || maintenance_leverage < initial_leverage {
        return rej("need 1 ≤ initialLeverage ≤ maintenanceLeverage");
    }
    let config = MarketConfig {
        lower,
        upper,
        resolvable,
        initial_leverage,
        maintenance_leverage,
        adl,
        graduation: e.graduation.unwrap_or(true),
        funding: e.funding.unwrap_or(true),
        resolves_at,
        taper_seconds,
    };
    let mut curve = None;
    let mut oracle = None;
    if e.launch == Some(true) && !(attention || e.curve.is_some()) {
        return rej("only curve markets can launch");
    }
    if attention || e.curve.is_some() {
        let spec = e.curve.as_ref();
        let x0 = fixed(
            spec.and_then(|c| c.usdc.as_ref())
                .map_or("5000", |n| n.0.as_str()),
        )?;
        let y0 = match spec.and_then(|c| c.tokens.as_ref()) {
            Some(n) => int(&n.0)?,
            None => 1_000_000_000,
        };
        if x0 <= 0 || y0 <= 0 {
            return rej("curve reserves must be positive");
        }
        let fee_bps = match &e.fee_bps {
            Some(n) => int(&n.0)?,
            None => 100,
        };
        if !(0..10_000).contains(&fee_bps) {
            return rej("feeBps must be in [0, 10000)");
        }
        let c = Curve {
            x0,
            y0,
            x: x0,
            y: y0,
            fee_bps,
        };
        let window = match &e.oracle_window {
            Some(n) => int(&n.0)?,
            None => 0,
        };
        oracle = Some(CurveOracle {
            window,
            history: vec![OraclePoint {
                t: s.time,
                price: spot_price(&c),
            }],
        });
        curve = Some(c);
    }
    let mark = curve.as_ref().map(spot_price);
    let mut m = Market {
        id: e.id.clone(),
        config,
        curve,
        oracle,
        launch: (e.launch == Some(true)).then(|| Launch {
            open: false,
            bids: BTreeMap::new(),
            reserve: 0,
        }),
        mark,
        time: s.time,
        tier: 0,
        volume: 0,
        last_trade: None,
        mid: None,
        funding_rate: 0,
        status: Status::Open,
        vault: 0,
        positions: BTreeMap::new(),
    };
    update_funding_rate(&mut m);
    s.markets.insert(e.id.clone(), m);
    Ok(())
}

fn on_deposit(s: &mut State, account: &str, amount: &Num) -> R<()> {
    let amt = fixed(&amount.0)?;
    if amt <= 0 {
        return rej("deposit must be positive");
    }
    let a = s
        .accounts
        .entry(account.to_string())
        .or_insert_with(|| Account {
            id: account.to_string(),
            wallet: 0,
            spot: BTreeMap::new(),
            deposited: 0,
            withdrawn: 0,
        });
    a.wallet += amt;
    a.deposited += amt;
    s.total_deposits += amt;
    Ok(())
}

fn on_withdraw(s: &mut State, account: &str, amount: &Num) -> R<()> {
    let a = get_account(&mut s.accounts, account)?;
    let amt = parse_amount(amount, a.wallet, "withdraw")?;
    a.wallet -= amt;
    a.withdrawn += amt;
    s.total_withdrawals += amt;
    Ok(())
}

fn on_allocate(s: &mut State, account: &str, market: &str, amount: &Num) -> R<()> {
    let a = get_account(&mut s.accounts, account)?;
    let m = get_market(&mut s.markets, market)?;
    let amt = parse_amount(amount, a.wallet, "allocate")?;
    let p = m.positions.entry(a.id.clone()).or_insert_with(|| Position {
        account: a.id.clone(),
        ..Default::default()
    });
    a.wallet -= amt;
    p.collateral += amt;
    p.allocated += amt;
    m.vault += amt;
    Ok(())
}

fn on_release(s: &mut State, account: &str, market: &str, amount: &Num) -> R<()> {
    let a = get_account(&mut s.accounts, account)?;
    let m = get_market(&mut s.markets, market)?;
    let p = get_position(m, &a.id)?;
    let amt = parse_amount(amount, releasable(m, &p), "release")?;
    let p = m.positions.get_mut(&a.id).unwrap();
    p.collateral -= amt;
    p.allocated -= amt;
    m.vault -= amt;
    a.wallet += amt;
    Ok(())
}

fn on_trade(
    s: &mut State,
    market: &str,
    buyer: &str,
    seller: &str,
    size: &Num,
    price: &Num,
) -> R<Vec<Effect>> {
    let m = get_market(&mut s.markets, market)?;
    if m.status != Status::Open {
        return rej(format!("{} is resolved", m.id));
    }
    assert_launched(m)?;
    if m.mark.is_none() {
        return rej(format!("{} has no oracle price yet", m.id));
    }
    if buyer == seller {
        return rej("self-trade");
    }
    let size = int(&size.0)?;
    if size <= 0 {
        return rej("size must be positive");
    }
    let price = parse_price(m, &price.0)?;
    let mut parties = [
        (get_position(m, buyer)?, size),
        (get_position(m, seller)?, -size),
    ];
    for (p, d) in parties.iter_mut() {
        let before = p.size;
        fill(p, *d, price);
        let reduce_only = p.size.abs() < before.abs() && sign(p.size) != -sign(before);
        let eq = equity(p, m.mark);
        let need = if reduce_only {
            maintenance_margin(m, p)
        } else {
            initial_margin(m, p)
        };
        if eq < need {
            return rej(format!(
                "{}: equity ${} below {} margin ${}",
                p.account,
                fmt_usd(eq),
                if reduce_only {
                    "maintenance"
                } else {
                    "initial"
                },
                fmt_usd(need)
            ));
        }
    }
    for (p, _) in parties {
        m.positions.insert(p.account.clone(), p);
    }
    m.volume += size * price;
    m.last_trade = Some(price);
    let effects = graduate(m);
    update_funding_rate(m);
    Ok(effects)
}

// ---------- graduation and funding ----------

/// Depth proxy: open-interest notional at mark, plus real USDC in the spot curve.
pub fn depth(m: &Market) -> i128 {
    let oi: i128 = m
        .positions
        .values()
        .filter(|p| p.size > 0)
        .map(|p| p.size)
        .sum();
    oi * m.mark.unwrap_or(0) + m.curve.as_ref().map_or(0, |c| c.x - c.x0)
}

pub fn open_interest(m: &Market) -> i128 {
    m.positions
        .values()
        .filter(|p| p.size > 0)
        .map(|p| p.size)
        .sum()
}

fn graduate(m: &mut Market) -> Vec<Effect> {
    let mut effects = vec![];
    if !m.config.graduation || m.mark.is_none() {
        return effects;
    }
    while m.tier < GRADUATION.len() {
        let next = &GRADUATION[m.tier];
        if m.volume < next.volume || depth(m) < next.depth {
            break;
        }
        m.tier += 1;
        effects.push(Effect::Graduation {
            market: m.id.clone(),
            tier: m.tier,
            leverage: next.leverage,
        });
    }
    effects
}

fn update_funding_rate(m: &mut Market) {
    let mark = match m.mark {
        Some(mk) if m.config.funding && mk != 0 => mk,
        _ => {
            m.funding_rate = 0;
            return;
        }
    };
    let base = FUNDING_BASE_PPB[m.tier];
    // The perp price is the book mid, else the last trade. A last trade goes stale when the oracle gaps; the
    // book is re-quoted around the new mark.
    let premium = match m.mid.or(m.last_trade) {
        None => 0,
        Some(perp) => ((perp - mark) * PPB) / mark / 8,
    };
    m.funding_rate = base + premium.clamp(-FUNDING_PREMIUM_CAP_PPB, FUNDING_PREMIUM_CAP_PPB);
}

/// Accrue `dt` seconds of funding at the current rate: exact transfer, payers and receivers each pro-rata by size.
fn accrue_funding(m: &mut Market, dt: i128) -> R<Vec<Effect>> {
    let Some(mark) = m.mark else {
        return Ok(vec![]);
    };
    if !m.config.funding || m.funding_rate == 0 {
        return Ok(vec![]);
    }
    let longs: Vec<String> = m
        .positions
        .values()
        .filter(|p| p.size > 0)
        .map(|p| p.account.clone())
        .collect();
    let shorts: Vec<String> = m
        .positions
        .values()
        .filter(|p| p.size < 0)
        .map(|p| p.account.clone())
        .collect();
    let oi: i128 = longs.iter().map(|id| m.positions[id].size).sum();
    if oi == 0 {
        return Ok(vec![]);
    }
    let rate = m.funding_rate;
    let total = (oi * mark * rate.abs() * dt) / (3600 * PPB);
    if total == 0 {
        return Ok(vec![]);
    }
    let (payers, receivers) = if rate > 0 {
        (longs, shorts)
    } else {
        (shorts, longs)
    };
    let w = |ids: &[String]| {
        ids.iter()
            .map(|id| m.positions[id].size.abs())
            .collect::<Vec<_>>()
    };
    let paid = allocate(total, &w(&payers)).map_err(fatal)?;
    let got = allocate(total, &w(&receivers)).map_err(fatal)?;
    for (id, v) in payers.iter().zip(paid) {
        let p = m.positions.get_mut(id).unwrap();
        p.collateral -= v;
        p.funding -= v;
    }
    for (id, v) in receivers.iter().zip(got) {
        let p = m.positions.get_mut(id).unwrap();
        p.collateral += v;
        p.funding += v;
    }
    Ok(vec![Effect::Funding {
        market: m.id.clone(),
        rate,
        seconds: dt,
        total,
        payers: if rate > 0 { "long" } else { "short" }.into(),
    }])
}

/// Profit an absorber has made in this market: equity above their net allocation, capped at equity.
fn positive_pnl(p: &Position, mark: i128) -> i128 {
    let eq = equity(p, Some(mark));
    eq.min(0.max(eq - p.allocated))
}

/// How much of a haircut `h` came out of principal rather than profit.
fn principal_part(p: &Position, mark: i128, h: i128) -> i128 {
    0.max(h - positive_pnl(p, mark))
}

/// Capped pro-rata on positive PnL, falling back to principal pro-rata by remaining equity.
/// Returns (haircuts, fromPrincipal) in the order of `opposing`.
fn pnl_haircuts(opposing: &[&Position], mark: i128, d_total: i128) -> R<(Vec<i128>, Vec<i128>)> {
    let profit: Vec<i128> = opposing.iter().map(|p| positive_pnl(p, mark)).collect();
    let total_profit: i128 = profit.iter().sum();
    let from_profit = allocate(d_total.min(total_profit), &profit).map_err(fatal)?;
    let rest = d_total - d_total.min(total_profit);
    let remaining: Vec<i128> = opposing
        .iter()
        .zip(&from_profit)
        .map(|(p, f)| equity(p, Some(mark)) - f)
        .collect();
    let from_principal = allocate(rest, &remaining).map_err(fatal)?;
    let haircuts = from_profit
        .iter()
        .zip(&from_principal)
        .map(|(a, b)| a + b)
        .collect();
    Ok((haircuts, from_principal))
}

/// Liquidation + ADL loop for one market. Reads and writes nothing outside `m`.
fn resolve_distress(m: &mut Market) -> R<Vec<Effect>> {
    let mut effects = vec![];
    let Some(mark) = m.mark else {
        return Ok(effects);
    };
    loop {
        let all_distressed: Vec<String> = m
            .positions
            .values()
            .filter(|p| p.size != 0 && equity(p, Some(mark)) < maintenance_margin(m, p))
            .map(|p| p.account.clone())
            .collect();
        if all_distressed.is_empty() {
            return Ok(effects);
        }

        // A price move only distresses one side, but a taper can distress both. Handle one side per round: the
        // side with a bankrupt position first, otherwise the first distressed side.
        let bankrupt = all_distressed
            .iter()
            .find(|id| equity(&m.positions[*id], Some(mark)) < 0);
        let side = sign(m.positions[bankrupt.unwrap_or(&all_distressed[0])].size);
        let distressed: Vec<String> = all_distressed
            .into_iter()
            .filter(|id| sign(m.positions[id].size) == side)
            .collect();
        let opposing: Vec<String> = m
            .positions
            .values()
            .filter(|p| sign(p.size) == -side)
            .map(|p| p.account.clone())
            .collect();

        let mut q_total = 0;
        let mut d_total = 0;
        for id in &distressed {
            let p = &m.positions[id];
            let eq = equity(p, Some(mark));
            q_total += p.size.abs();
            if eq < 0 {
                d_total += -eq;
                effects.push(Effect::Bankrupt {
                    market: m.id.clone(),
                    account: id.clone(),
                    size: p.size,
                    shortfall: -eq,
                });
            } else {
                effects.push(Effect::Liquidation {
                    market: m.id.clone(),
                    account: id.clone(),
                    size: p.size,
                    equity: eq,
                    maintenance: maintenance_margin(m, p),
                });
            }
        }

        let weights: Vec<i128> = opposing
            .iter()
            .map(|id| m.positions[id].size.abs())
            .collect();
        let closes = allocate(q_total, &weights).map_err(fatal)?;
        let (haircuts, from_principal) = match m.config.adl {
            AdlPolicy::Pnl => {
                let opp: Vec<&Position> = opposing.iter().map(|id| &m.positions[id]).collect();
                let (h, f) = pnl_haircuts(&opp, mark, d_total)?;
                (h, Some(f))
            }
            AdlPolicy::Size => (allocate(d_total, &weights).map_err(fatal)?, None),
        };

        // Close distressed positions fully at mark; take the other side pro-rata at mark.
        let mut forced = vec![];
        for id in &distressed {
            let p = m.positions.get_mut(id).unwrap();
            forced.push(ForcedClose {
                account: id.clone(),
                closed: -p.size,
                price: mark,
            });
            let s = p.size;
            fill(p, -s, mark);
        }
        for (id, &r) in opposing.iter().zip(&closes) {
            let p = m.positions.get_mut(id).unwrap();
            if r > p.size.abs() {
                return Err(fatal(format!(
                    "invariant: ADL closes {r} > position {} for {id}",
                    p.size
                )));
            }
            if r == 0 {
                continue;
            }
            forced.push(ForcedClose {
                account: id.clone(),
                closed: side * r,
                price: mark,
            });
            fill(p, side * r, mark);
        }
        effects.push(Effect::ForcedClose {
            market: m.id.clone(),
            closes: forced,
        });

        // Move the shortfall from absorbers to bankrupt positions.
        for (i, id) in opposing.iter().enumerate() {
            let h = haircuts[i];
            if h == 0 {
                continue;
            }
            let p = m.positions.get_mut(id).unwrap();
            if h > equity(p, Some(mark)) {
                return Err(fatal(format!(
                    "invariant: haircut {h} exceeds equity of {id}"
                )));
            }
            let principal = match &from_principal {
                Some(f) => f[i],
                None => principal_part(p, mark, h),
            };
            p.collateral -= h;
            p.adl_transfer -= h;
            effects.push(Effect::Haircut {
                market: m.id.clone(),
                account: id.clone(),
                amount: h,
                from_principal: principal,
            });
        }
        for id in &distressed {
            let p = m.positions.get_mut(id).unwrap();
            let eq = equity(p, Some(mark));
            if eq < 0 {
                p.collateral += -eq;
                p.adl_transfer += -eq;
            }
        }
    }
}

fn on_book(s: &mut State, market: &str, mid: Option<&Num>) -> R<()> {
    let m = get_market(&mut s.markets, market)?;
    if m.status != Status::Open {
        return rej(format!("{} is resolved", m.id));
    }
    m.mid = match mid {
        None => None,
        Some(p) => Some(parse_price(m, &p.0)?),
    };
    update_funding_rate(m);
    Ok(())
}

fn on_tick(s: &mut State, market: &str, price: &str) -> R<Vec<Effect>> {
    let m = get_market(&mut s.markets, market)?;
    if m.status != Status::Open {
        return rej(format!("{} is resolved", m.id));
    }
    if m.curve.is_some() {
        return rej(format!(
            "{} is priced by its own curve, not an external tick",
            m.id
        ));
    }
    m.mark = Some(parse_price(m, price)?);
    let effects = resolve_distress(m)?;
    update_funding_rate(m);
    Ok(effects)
}

fn fee(gross: i128, bps: i128) -> i128 {
    ceil_div(gross * bps, 10_000)
}

fn check_curve(m: &Market) -> R<()> {
    if m.curve.is_none() {
        return rej(format!("{} has no spot curve", m.id));
    }
    if m.status != Status::Open {
        return rej(format!("{} is resolved", m.id));
    }
    Ok(())
}

/// Spot and perp trading wait for a launch's open.
fn assert_launched(m: &Market) -> R<()> {
    match &m.launch {
        Some(l) if !l.open => rej(format!(
            "{} is in its snipe window: trading starts at the open",
            m.id
        )),
        _ => Ok(()),
    }
}

fn pending_launch(m: &Market) -> R<()> {
    match &m.launch {
        None => rej(format!("{} has no launch", m.id)),
        Some(l) if l.open => rej(format!("{} is already open", m.id)),
        Some(_) => Ok(()),
    }
}

fn on_snipe(s: &mut State, account: &str, market: &str, amount: &Num) -> R<()> {
    let a = get_account(&mut s.accounts, account)?;
    let m = get_market(&mut s.markets, market)?;
    check_curve(m)?;
    pending_launch(m)?;
    let usdc = parse_amount(amount, a.wallet, "snipe")?;
    let f = fee(usdc, m.curve.as_ref().unwrap().fee_bps); // the spot fee applies to snipes too
    if usdc - f <= 0 {
        return rej("snipe too small");
    }
    a.wallet -= usdc;
    s.fees += f;
    *m.launch
        .as_mut()
        .unwrap()
        .bids
        .entry(a.id.clone())
        .or_insert(0) += usdc - f;
    Ok(())
}

/// The open: all bids B buy from the curve together, at one price. The curve moves from (x0, y0) to (x1, y1) with
///   x1 = (x0 + √(x0·(x0 + 4B))) / 2,  y1 = ⌈x0·y0 / x1⌉,  open price x1 / y1,
/// the point where buying y0 − y1 tokens at the open price costs B: x1·(x1 − x0) = x0·B. Only x1 − x0 enters the
/// curve; the rest of B stays in the market as its launch reserve. Tokens split pro-rata by bid (largest remainder).
/// Where a launch's curve opens for total bids `b`: (x1, y1). See on_open.
pub fn open_curve(x0: i128, y0: i128, b: i128) -> (i128, i128) {
    let x1 = (x0 + isqrt(x0 * (x0 + 4 * b))) / 2;
    (x1, ceil_div(x0 * y0, x1))
}

fn on_open(s: &mut State, market: &str) -> R<Vec<Effect>> {
    let now = s.time;
    let m = get_market(&mut s.markets, market)?;
    check_curve(m)?;
    pending_launch(m)?;
    let bids: Vec<(String, i128)> = m
        .launch
        .as_ref()
        .unwrap()
        .bids
        .iter()
        .map(|(k, v)| (k.clone(), *v))
        .collect();
    let b: i128 = bids.iter().map(|(_, v)| v).sum();
    let c = m.curve.as_mut().unwrap();
    let x0 = c.x;
    let (x1, y1) = open_curve(x0, c.y, b);
    let tokens = c.y - y1;
    let split =
        allocate(tokens, &bids.iter().map(|(_, v)| *v).collect::<Vec<_>>()).map_err(fatal)?;
    let mut fills = vec![];
    for ((account, usdc), t) in bids.into_iter().zip(split) {
        if t > 0 {
            let a = s
                .accounts
                .get_mut(&account)
                .ok_or_else(|| fatal(format!("bid from unknown account {account}")))?;
            *a.spot.entry(m.id.clone()).or_insert(0) += t;
        }
        fills.push(LaunchFill {
            account,
            usdc,
            tokens: t,
        });
    }
    c.x = x1;
    c.y = y1;
    let reserve = b - (x1 - x0);
    m.launch = Some(Launch {
        open: true,
        bids: BTreeMap::new(),
        reserve,
    });
    // The oracle restarts at the open price as if it had held for a whole window: nobody could trade the curve
    // before the open, and a pump right after it must take a full window to move a TWAP mark.
    let before = m.mark.expect("curve market has a mark");
    let price = spot_price(c);
    let oracle = m.oracle.as_mut().unwrap();
    oracle.history = vec![OraclePoint {
        t: now - oracle.window,
        price,
    }];
    m.mark = Some(price);
    let mut effects = vec![Effect::Open {
        market: m.id.clone(),
        price,
        sniped: b,
        tokens,
        reserve,
        fills,
    }];
    if price != before {
        effects.push(Effect::Mark {
            market: m.id.clone(),
            from: before,
            to: price,
            spot: price,
        });
    }
    effects.extend(graduate(m));
    update_funding_rate(m);
    Ok(effects)
}

fn on_spot_buy(s: &mut State, account: &str, market: &str, amount: &Num) -> R<Vec<Effect>> {
    let a = get_account(&mut s.accounts, account)?;
    let m = get_market(&mut s.markets, market)?;
    check_curve(m)?;
    assert_launched(m)?;
    let c = m.curve.as_mut().unwrap();
    let usdc = parse_amount(amount, a.wallet, "spend")?;
    let f = fee(usdc, c.fee_bps);
    let price_before = spot_price(c);
    let k = c.x * c.y;
    let x = c.x + usdc - f;
    let y = ceil_div(k, x); // round in the curve's favour
    let tokens = c.y - y;
    if tokens <= 0 {
        return rej("buy too small");
    }
    a.wallet -= usdc;
    *a.spot.entry(m.id.clone()).or_insert(0) += tokens;
    s.fees += f;
    c.x = x;
    c.y = y;
    let spot = Effect::Spot {
        market: m.id.clone(),
        account: a.id.clone(),
        usdc,
        tokens,
        fee: f,
        price_before,
        price_after: spot_price(c),
    };
    let mut effects = vec![spot];
    effects.extend(refresh_oracle(s.time, m));
    effects.extend(resolve_distress(m)?);
    effects.extend(graduate(m));
    update_funding_rate(m);
    Ok(effects)
}

fn on_spot_sell(s: &mut State, account: &str, market: &str, tokens: &Num) -> R<Vec<Effect>> {
    let a = get_account(&mut s.accounts, account)?;
    let m = get_market(&mut s.markets, market)?;
    check_curve(m)?;
    assert_launched(m)?;
    let c = m.curve.as_mut().unwrap();
    let held = a.spot.get(&m.id).copied().unwrap_or(0);
    let tokens = if tokens.is("all") {
        held
    } else {
        int(&tokens.0)?
    };
    if tokens <= 0 {
        return rej("nothing to sell");
    }
    if tokens > held {
        return rej(format!("sell {tokens} exceeds holdings {held}"));
    }
    let price_before = spot_price(c);
    let k = c.x * c.y;
    let y = c.y + tokens;
    let x = ceil_div(k, y); // round in the curve's favour
    let gross = c.x - x;
    let f = fee(gross, c.fee_bps);
    if gross - f <= 0 {
        return rej("sell too small");
    }
    a.spot.insert(m.id.clone(), held - tokens);
    a.wallet += gross - f;
    s.fees += f;
    c.x = x;
    c.y = y;
    let spot = Effect::Spot {
        market: m.id.clone(),
        account: a.id.clone(),
        usdc: -(gross - f),
        tokens: -tokens,
        fee: f,
        price_before,
        price_after: spot_price(c),
    };
    let mut effects = vec![spot];
    effects.extend(refresh_oracle(s.time, m));
    effects.extend(resolve_distress(m)?);
    update_funding_rate(m);
    Ok(effects)
}

fn on_advance(s: &mut State, seconds: &Num) -> R<Vec<Effect>> {
    let dt = int(&seconds.0)?;
    if dt <= 0 {
        return rej("advance must be positive");
    }
    s.time += dt;
    let now = s.time;
    let mut effects = vec![];
    for m in s.markets.values_mut() {
        m.time = now;
        if m.status != Status::Open {
            continue;
        }
        // Each step is its own risk round, so every round starts from a solvent state.
        effects.extend(accrue_funding(m, dt)?);
        effects.extend(resolve_distress(m)?);
        effects.extend(refresh_oracle(now, m));
        effects.extend(resolve_distress(m)?);
        effects.extend(graduate(m));
        update_funding_rate(m);
    }
    Ok(effects)
}

fn on_resolve(s: &mut State, market: &str, price: &str) -> R<Vec<Effect>> {
    let now = s.time;
    let m = get_market(&mut s.markets, market)?;
    if !m.config.resolvable {
        return rej(format!("{} is not resolvable", m.id));
    }
    if let Some(at) = m.config.resolves_at {
        if now < at {
            return rej(format!("{} resolves at t={at}s (now t={now}s)", m.id));
        }
    }
    let mut effects = on_tick(s, market, price)?;
    let m = s.markets.get_mut(market).unwrap();
    let price = m.mark.unwrap();
    let mut closes = vec![];
    for p in m.positions.values_mut() {
        if p.size == 0 {
            continue;
        }
        closes.push(ForcedClose {
            account: p.account.clone(),
            closed: -p.size,
            price,
        });
        let sz = p.size;
        fill(p, -sz, price);
    }
    effects.push(Effect::Settlement {
        market: m.id.clone(),
        price,
        closes,
    });
    m.status = Status::Resolved;
    Ok(effects)
}

// ---------- invariants ----------

pub fn check_market(m: &Market) -> Vec<String> {
    let mut errs = vec![];
    let (
        mut net_size,
        mut allocated,
        mut collateral_minus_basis,
        mut sum_equity,
        mut sum_releasable,
    ) = (0, 0, 0, 0, 0);
    for p in m.positions.values() {
        let id = format!("{}/{}", m.id, p.account);
        net_size += p.size;
        allocated += p.allocated;
        collateral_minus_basis += p.collateral - p.basis;
        if p.size != 0 && m.mark.is_none() {
            errs.push(format!("{id}: position without mark"));
            continue;
        }
        let eq = equity(p, m.mark);
        sum_equity += eq;
        if eq < 0 {
            errs.push(format!("{id}: negative equity {eq}"));
        }
        if p.size != 0 && eq < maintenance_margin(m, p) {
            errs.push(format!("{id}: below maintenance margin"));
        }
        let r = releasable(m, p);
        if r > eq {
            errs.push(format!("{id}: releasable {r} > equity {eq}"));
        }
        sum_releasable += r;
        if p.collateral != p.allocated + p.realized + p.adl_transfer + p.funding {
            errs.push(format!("{id}: ledger mismatch"));
        }
        if m.status == Status::Resolved && (p.size != 0 || p.basis != 0) {
            errs.push(format!("{id}: open position after resolution"));
        }
    }
    if net_size != 0 {
        errs.push(format!("{}: unbalanced exposure Σsize = {net_size}", m.id));
    }
    if allocated != m.vault {
        errs.push(format!(
            "{}: vault {} != Σallocated {allocated}",
            m.id, m.vault
        ));
    }
    if collateral_minus_basis != m.vault {
        errs.push(format!(
            "{}: Σ(collateral − basis) {collateral_minus_basis} != vault {}",
            m.id, m.vault
        ));
    }
    if sum_equity != m.vault {
        errs.push(format!(
            "{}: Σequity {sum_equity} != vault {}",
            m.id, m.vault
        ));
    }
    if sum_releasable > m.vault {
        errs.push(format!("{}: Σreleasable > vault", m.id));
    }
    if let Some(c) = &m.curve {
        if c.x < c.x0 {
            errs.push(format!("{}: curve holds negative USDC", m.id));
        }
        if c.x * c.y < c.x0 * c.y0 {
            errs.push(format!("{}: curve invariant k decreased", m.id));
        }
        if c.y <= 0 {
            errs.push(format!("{}: curve token reserve exhausted", m.id));
        }
    }
    errs
}

pub fn check_invariants(s: &State) -> Vec<String> {
    let mut errs: Vec<String> = s.markets.values().flat_map(check_market).collect();
    for m in s.markets.values() {
        if m.time != s.time {
            errs.push(format!("{}: clock out of sync", m.id));
        }
    }
    let mut wallets = 0;
    for a in s.accounts.values() {
        wallets += a.wallet;
        if a.wallet < 0 {
            errs.push(format!("{}: negative wallet", a.id));
        }
    }
    let mut held = 0;
    for m in s.markets.values() {
        held += m.vault;
        if let Some(l) = &m.launch {
            held += l.reserve; // USDC the open didn't put in the curve
            held += l.bids.values().sum::<i128>(); // bids waiting for the open
            if l.open && !l.bids.is_empty() {
                errs.push(format!("{}: bids left after the open", m.id));
            }
        }
        let Some(c) = &m.curve else { continue };
        held += c.x - c.x0; // real USDC sitting in the curve
        let tokens: i128 = s
            .accounts
            .values()
            .map(|a| a.spot.get(&m.id).copied().unwrap_or(0))
            .sum();
        if tokens != c.y0 - c.y {
            errs.push(format!(
                "{}: Σ holdings {tokens} != tokens sold {}",
                m.id,
                c.y0 - c.y
            ));
        }
    }
    if wallets + held + s.fees != s.total_deposits - s.total_withdrawals {
        errs.push(format!(
            "wallets + vaults + curves + launches + fees {} != deposits − withdrawals {}",
            wallets + held + s.fees,
            s.total_deposits - s.total_withdrawals
        ));
    }
    errs
}

// ---------- apply / replay ----------

/// Apply one event to a copy of `state`: the new state and what the engine did, or why it didn't.
pub fn apply(state: &State, event: &Event) -> Result<(State, Vec<Effect>), ApplyError> {
    let mut s = state.clone();
    let effects = match event {
        Event::Market(e) => on_market(&mut s, e).map(|_| vec![]),
        Event::Deposit { account, amount } => on_deposit(&mut s, account, amount).map(|_| vec![]),
        Event::Withdraw { account, amount } => on_withdraw(&mut s, account, amount).map(|_| vec![]),
        Event::Allocate {
            account,
            market,
            amount,
        } => on_allocate(&mut s, account, market, amount).map(|_| vec![]),
        Event::Release {
            account,
            market,
            amount,
        } => on_release(&mut s, account, market, amount).map(|_| vec![]),
        Event::Trade {
            market,
            buyer,
            seller,
            size,
            price,
        } => on_trade(&mut s, market, buyer, seller, size, price),
        Event::Tick { market, price } => on_tick(&mut s, market, &price.0),
        Event::Resolve { market, price } => on_resolve(&mut s, market, &price.0),
        Event::SpotBuy {
            account,
            market,
            amount,
        } => on_spot_buy(&mut s, account, market, amount),
        Event::SpotSell {
            account,
            market,
            tokens,
        } => on_spot_sell(&mut s, account, market, tokens),
        Event::Advance { seconds } => on_advance(&mut s, seconds),
        Event::Snipe {
            account,
            market,
            amount,
        } => on_snipe(&mut s, account, market, amount).map(|_| vec![]),
        Event::Open { market } => on_open(&mut s, market),
        Event::Book { market, mid } => on_book(&mut s, market, mid.as_ref()).map(|_| vec![]),
    }?;
    let errs = check_invariants(&s);
    if !errs.is_empty() {
        let ev = serde_json::to_string(event).unwrap_or_default();
        return Err(fatal(format!(
            "invariant violation after {ev}:\n  {}",
            errs.join("\n  ")
        )));
    }
    s.seq += 1;
    Ok((s, effects))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(events: &[Event]) -> (State, Vec<Result<Vec<Effect>, ApplyError>>) {
        let mut s = initial_state();
        let mut out = vec![];
        for e in events {
            match apply(&s, e) {
                Ok((next, effects)) => {
                    s = next;
                    out.push(Ok(effects));
                }
                Err(err) => out.push(Err(err)),
            }
        }
        (s, out)
    }

    #[test]
    fn launch_opens_at_the_documented_price() {
        let market = Event::Market(MarketEvent {
            id: "C".into(),
            preset: Some("attention".into()),
            fee_bps: Some("0".into()),
            launch: Some(true),
            ..Default::default()
        });
        let (s, results) = run(&[
            market,
            Event::Deposit {
                account: "a".into(),
                amount: "100000".into(),
            },
            Event::Snipe {
                account: "a".into(),
                market: "C".into(),
                amount: "100000".into(),
            },
            Event::Open { market: "C".into() },
        ]);
        let Ok(effects) = &results[3] else {
            panic!("open failed: {:?}", results[3])
        };
        let Effect::Open {
            price,
            tokens,
            reserve,
            sniped,
            ..
        } = &effects[0]
        else {
            panic!("no open effect")
        };
        assert_eq!(
            (*price, *tokens, *sniped, *reserve),
            (125_000, 800_000_000, 100_000 * PPB, 80_000 * PPB)
        ); // $0.000125
        assert_eq!(s.accounts["a"].spot["C"], 800_000_000);
        assert_eq!(s.markets["C"].mark, Some(125_000));
        assert!(check_invariants(&s).is_empty());
    }
}
