// Every state-changing input to the exchange, as data. API writes, admin actions, listings (with any metadata
// fetched from a venue inside the payload), feed ticks, chart backfill, bot actions, the 2 s clock and the
// resume-after-downtime shift all become a command. The sequencer (Node::submit, then Core::submit) gives each a
// time and, if it changes the exchange, a sequence number; `Apply::apply` runs it. It is deterministic: it reads
// nothing but the exchange, the command and the exchange's `now` (the command's time), so the same commands in
// the same order give the same exchange.
//
// Each command is its own struct, with the reply it produces as `Apply::Reply`, so a caller gets back exactly
// what its command returns. The journal stores the `Command` enum: `{"kind": "...", ...fields}`.

use crate::book::Side;
use crate::exchange::{
    AccountMeta, DepthBook, ExError, Exchange, MarketSpec, OrderInput, OrderResult, XResult,
};
use crate::money::{Amount, Dec, Tokens};
use crate::units::coins_dec;
use impulse_engine::ser::big;
use impulse_engine::Effect;
use serde::{Deserialize, Serialize};

/// A command: what it does to the exchange, and what it returns.
pub trait Apply {
    type Reply;
    fn apply(&self, x: &mut Exchange) -> XResult<Self::Reply>;
}

/// A feed price for one market: coin price, nano-USD.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Tick {
    pub market: String,
    #[serde(with = "big")]
    pub price: i128,
}

/// One bar of external price history (coin prices, nano-USD), for the chart backfill.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Bar {
    pub t: i64,
    #[serde(with = "big")]
    pub o: i128,
    #[serde(with = "big")]
    pub h: i128,
    #[serde(with = "big")]
    pub l: i128,
    #[serde(with = "big")]
    pub c: i128,
}

/// A command's journal `kind` tag, known without converting it to a `Command` (so the sequencer needn't clone it).
pub trait CommandKind {
    fn kind(&self) -> &'static str;
}

/// Declares the commands' journal enum: one variant per command struct, with its `kind` tag.
macro_rules! commands {
    ($($variant:ident = $kind:literal,)*) => {
        #[derive(Clone, Debug, Serialize, Deserialize)]
        #[serde(tag = "kind")]
        pub enum Command {
            $(#[serde(rename = $kind)] $variant($variant),)*
        }

        impl CommandKind for Command {
            fn kind(&self) -> &'static str {
                match self {
                    $(Command::$variant(_) => $kind,)*
                }
            }
        }

        $(impl CommandKind for $variant {
            fn kind(&self) -> &'static str {
                $kind
            }
        })*

        /// Any command, its reply dropped: for replay, and for clients that submit a mix (the bots).
        impl Apply for Command {
            type Reply = ();
            fn apply(&self, x: &mut Exchange) -> XResult<()> {
                match self {
                    $(Command::$variant(c) => c.apply(x).map(drop),)*
                }
            }
        }

        $(impl From<$variant> for Command {
            fn from(c: $variant) -> Command {
                Command::$variant(c)
            }
        })*
    };
}

commands! {
    Genesis = "genesis",
    Resume = "resume",
    Clock = "clock",
    Signup = "signup",
    CreateAccount = "createAccount",
    Faucet = "faucet",
    Deposit = "deposit",
    Withdraw = "withdraw",
    PlaceOrder = "placeOrder",
    ClosePosition = "closePosition",
    Cancel = "cancel",
    CancelAll = "cancelAll",
    Margin = "margin",
    SpotBuy = "spotBuy",
    SpotSell = "spotSell",
    Snipe = "snipe",
    ListMarket = "listMarket",
    AdminPrice = "adminPrice",
    ReleaseHold = "releaseHold",
    Resolve = "resolve",
    Ipo = "ipo",
    Pump = "pump",
    SetBots = "setBots",
    FeedTick = "tick",
    Ticks = "ticks",
    Depth = "depth",
    Upgrade = "upgrade",
    History = "history",
    BotQuote = "botQuote",
    TestReload = "testReload",
}

/// The first command of a fresh exchange: its clock origin is this command's time.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Genesis {}

impl Apply for Genesis {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.genesis = x.now;
        x.version += 1;
        Ok(())
    }
}

/// Startup after downtime: shift the clock origin by the outage, so engine time resumes where it stopped.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resume {
    pub down_ms: i64,
}

impl Apply for Resume {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.resume_after(self.down_ms);
        Ok(())
    }
}

/// The 2 s clock step: funding, TWAPs, tapers, launch opens, book mids, pre-IPO marks.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Clock {}

impl Apply for Clock {
    type Reply = Vec<Effect>;
    fn apply(&self, x: &mut Exchange) -> XResult<Vec<Effect>> {
        x.clock()
    }
}

/// Sign up: a new account and its first faucet deposit. The API key was drawn at intake.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signup {
    pub name: String,
    pub api_key: String,
}

impl Apply for Signup {
    type Reply = AccountMeta;
    fn apply(&self, x: &mut Exchange) -> XResult<AccountMeta> {
        let meta = x.create_account(&self.name, false, &self.api_key)?;
        x.faucet(&meta.id)?;
        Ok(meta)
    }
}

/// A bot account (no faucet).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateAccount {
    pub name: String,
    pub api_key: String,
    pub bot: bool,
}

impl Apply for CreateAccount {
    type Reply = AccountMeta;
    fn apply(&self, x: &mut Exchange) -> XResult<AccountMeta> {
        x.create_account(&self.name, self.bot, &self.api_key)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Faucet {
    pub account: String,
}

impl Apply for Faucet {
    /// The amount paid.
    type Reply = i128;
    fn apply(&self, x: &mut Exchange) -> XResult<i128> {
        x.faucet(&self.account)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Deposit {
    pub account: String,
    pub amount: Dec,
}

impl Apply for Deposit {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.deposit(&self.account, self.amount)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Withdraw {
    pub account: String,
    pub amount: Amount,
}

impl Apply for Withdraw {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.withdraw(&self.account, self.amount)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PlaceOrder {
    pub account: String,
    pub order: OrderInput,
}

impl Apply for PlaceOrder {
    type Reply = OrderResult;
    fn apply(&self, x: &mut Exchange) -> XResult<OrderResult> {
        x.place_order(&self.account, &self.order)
    }
}

/// Close a whole position with a reduce-only market order.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ClosePosition {
    pub account: String,
    pub market: String,
    pub slippage: f64,
}

impl Apply for ClosePosition {
    type Reply = OrderResult;
    fn apply(&self, x: &mut Exchange) -> XResult<OrderResult> {
        let sz = x.market(&self.market)?.sz_decimals;
        let size = x.size_of(&self.market, &self.account);
        if size == 0 {
            return Err(ExError::bad(format!("no open position in {}", self.market)));
        }
        let side = if size > 0 { Side::Sell } else { Side::Buy };
        let order = OrderInput {
            reduce_only: true,
            slippage: Some(self.slippage),
            ..OrderInput::market(&self.market, side, coins_dec(sz, size.abs()))
        };
        x.place_order(&self.account, &order)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Cancel {
    pub account: String,
    pub order: String,
}

impl Apply for Cancel {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.cancel(&self.account, &self.order)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CancelAll {
    pub account: String,
    pub market: Option<String>,
}

impl Apply for CancelAll {
    /// How many orders were cancelled.
    type Reply = usize;
    fn apply(&self, x: &mut Exchange) -> XResult<usize> {
        x.cancel_all(&self.account, self.market.as_deref())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Margin {
    pub account: String,
    pub market: String,
    pub amount: Dec,
}

impl Apply for Margin {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.adjust_margin(&self.account, &self.market, self.amount)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpotBuy {
    pub account: String,
    pub market: String,
    pub usdc: Amount,
}

impl Apply for SpotBuy {
    type Reply = Vec<Effect>;
    fn apply(&self, x: &mut Exchange) -> XResult<Vec<Effect>> {
        x.spot_buy(&self.account, &self.market, self.usdc)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpotSell {
    pub account: String,
    pub market: String,
    pub tokens: Tokens,
}

impl Apply for SpotSell {
    type Reply = Vec<Effect>;
    fn apply(&self, x: &mut Exchange) -> XResult<Vec<Effect>> {
        x.spot_sell(&self.account, &self.market, self.tokens)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snipe {
    pub account: String,
    pub market: String,
    pub usdc: Amount,
}

impl Apply for Snipe {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.snipe(&self.account, &self.market, self.usdc)
    }
}

/// Any listing: creator coins, admin markets, venue mirrors (their fetched metadata is in the spec), pre-IPO.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ListMarket {
    pub spec: Box<MarketSpec>,
}

impl Apply for ListMarket {
    /// The new market's id.
    type Reply = String;
    fn apply(&self, x: &mut Exchange) -> XResult<String> {
        Ok(x.create_market((*self.spec).clone())?.id.clone())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminPrice {
    pub market: String,
    pub price: Dec,
    pub hold_seconds: f64,
}

impl Apply for AdminPrice {
    type Reply = Vec<Effect>;
    fn apply(&self, x: &mut Exchange) -> XResult<Vec<Effect>> {
        x.admin_price(&self.market, self.price, self.hold_seconds)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReleaseHold {
    pub market: String,
}

impl Apply for ReleaseHold {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.release_hold(&self.market)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Resolve {
    pub market: String,
    pub price: Dec,
}

impl Apply for Resolve {
    type Reply = Vec<Effect>;
    fn apply(&self, x: &mut Exchange) -> XResult<Vec<Effect>> {
        x.resolve(&self.market, self.price)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ipo {
    pub market: String,
    pub price: Dec,
}

impl Apply for Ipo {
    type Reply = Vec<Effect>;
    fn apply(&self, x: &mut Exchange) -> XResult<Vec<Effect>> {
        x.ipo(&self.market, self.price)
    }
}

/// The house account buys (usdc > 0) or sells about |usdc| (usdc < 0) on a curve. `house_key` is the house
/// account's API key, used if this pump creates it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pump {
    pub market: String,
    pub usdc: Dec,
    pub house_key: String,
}

impl Apply for Pump {
    type Reply = Vec<Effect>;
    fn apply(&self, x: &mut Exchange) -> XResult<Vec<Effect>> {
        x.pump(&self.market, self.usdc, &self.house_key)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SetBots {
    pub enabled: bool,
}

impl Apply for SetBots {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.bots_enabled = self.enabled;
        x.version += 1;
        if !self.enabled {
            for id in crate::bots::Bots::ids() {
                if x.accounts.contains_key(id) {
                    x.cancel_all(id, None)?;
                }
            }
        }
        Ok(())
    }
}

/// One feed tick (test hook).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FeedTick {
    pub tick: Tick,
}

impl Apply for FeedTick {
    /// None if it didn't apply (an admin hold, or a resolved market).
    type Reply = Option<Vec<Effect>>;
    fn apply(&self, x: &mut Exchange) -> XResult<Option<Vec<Effect>>> {
        x.tick(&self.tick.market, self.tick.price, false)
    }
}

/// A feed poll: each tick applies on its own; a refused one doesn't stop the rest.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ticks {
    pub ticks: Vec<Tick>,
}

impl Apply for Ticks {
    /// The refused ticks and why, for the feed's warnings.
    type Reply = Vec<(String, ExError)>;
    fn apply(&self, x: &mut Exchange) -> XResult<Vec<(String, ExError)>> {
        Ok(self
            .ticks
            .iter()
            .filter_map(|t| {
                x.tick(&t.market, t.price, false)
                    .err()
                    .map(|e| (t.market.clone(), e))
            })
            .collect())
    }
}

/// A poll of a venue's order books (Hyperliquid's top levels): the bot maker mirrors each book and its market's
/// mark moves to the book's mid. A refused book doesn't stop the rest.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Depth {
    pub books: Vec<DepthBook>,
}

impl Apply for Depth {
    /// The refused books and why, for the feed's warnings.
    type Reply = Vec<(String, ExError)>;
    fn apply(&self, x: &mut Exchange) -> XResult<Vec<(String, ExError)>> {
        Ok(self
            .books
            .iter()
            .filter_map(|b| x.mirror(b).err().map(|e| (b.market.clone(), e)))
            .collect())
    }
}

/// A one-time upgrade of an exchange an older build made (exchange::UPGRADES), submitted at startup.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Upgrade {
    pub name: String,
}

impl Apply for Upgrade {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        x.upgrade(&self.name)
    }
}

/// Chart backfill from a venue's history.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct History {
    pub market: String,
    pub bars: Vec<Bar>,
}

impl Apply for History {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        let mut points: Vec<_> = self
            .bars
            .iter()
            .map(|b| (b.t, b.o, b.h, b.l, b.c))
            .collect();
        x.candles_from_history(&self.market, &mut points);
        Ok(())
    }
}

/// The bot maker replaces its ladder in one market (then book mids go to the engine).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BotQuote {
    pub market: String,
}

impl Apply for BotQuote {
    type Reply = ();
    fn apply(&self, x: &mut Exchange) -> XResult<()> {
        if x.markets.contains_key(&self.market) {
            crate::bots::quote(x, &self.market);
        }
        x.sync_books();
        Ok(())
    }
}

/// Test hook: round-trip the exchange through its snapshot format, then resume after `down_ms` of downtime.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestReload {
    pub down_ms: i64,
}

pub struct Reloaded {
    /// The round trip reproduced the exchange's serialization exactly.
    pub identical: bool,
    pub effects: Vec<Effect>,
}

impl Apply for TestReload {
    type Reply = Reloaded;
    fn apply(&self, x: &mut Exchange) -> XResult<Reloaded> {
        let before = crate::persist::serialize(x);
        let (mut y, _) = crate::persist::deserialize(&before).map_err(ExError::Internal)?;
        let identical = crate::persist::serialize(&y) == before;
        y.version = x.version + 1;
        y.resume_after(self.down_ms);
        let effects = y.clock()?;
        *x = y;
        Ok(Reloaded { identical, effects })
    }
}
