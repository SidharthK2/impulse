// The exchange's data: market metadata, listing specs, accounts, fills, risk events, candles, orders, errors.

use super::*;

#[derive(Debug, Clone, PartialEq, Eq)]
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

/// Storage and other plumbing errors arrive as strings: to callers they're internal errors.
impl From<String> for ExError {
    fn from(e: String) -> Self {
        ExError::Internal(e)
    }
}

pub type XResult<T> = Result<T, ExError>;

// ---------- types ----------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Source {
    Hyperliquid {
        coin: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        dex: Option<String>,
    },
    Polymarket {
        market_id: String,
        token_id: String,
        outcome: String,
    },
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
    /// When the bot maker last posted the venue's real order book here (see mirror.rs). While that's recent, the
    /// market's liquidity is the mirror rather than the maker's ladder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mirrored_at: Option<i64>,
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
    pub tick: Option<Dec>,  // coin price
    pub price: Option<Dec>, // first oracle price (coin price) for externally priced markets
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

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OrderType {
    #[default]
    Limit,
    Market,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderInput {
    pub market: String,
    pub side: Side,
    pub kind: OrderType,
    pub size: Dec,          // coins
    pub price: Option<Dec>, // coin price, limit orders
    pub leverage: Option<f64>,
    pub reduce_only: bool,
    pub tif: Option<Tif>,
    pub slippage: Option<f64>, // market orders: worst acceptable price as a fraction of mark (default 5%)
}

impl OrderInput {
    pub fn market(market: &str, side: Side, size: Dec) -> Self {
        OrderInput {
            market: market.into(),
            side,
            kind: OrderType::Market,
            size,
            price: None,
            leverage: None,
            reduce_only: false,
            tif: None,
            slippage: None,
        }
    }
    pub fn limit(market: &str, side: Side, price: Dec, size: Dec) -> Self {
        OrderInput {
            kind: OrderType::Limit,
            price: Some(price),
            ..OrderInput::market(market, side, size)
        }
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
