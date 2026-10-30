// Every state-changing input to the exchange, as data. API writes, admin actions, listings (with any metadata
// fetched from a venue inside the payload), feed ticks, chart backfill, bot actions, the 2 s clock and the
// resume-after-downtime shift all become a Command. The sequencer (Core::submit) stamps each with a sequence
// number and a time; `apply` runs it. `apply` is deterministic: it reads nothing but the exchange, the command and
// the exchange's `now` (the command's time), so the same commands in the same order give the same exchange.

use crate::book::Side;
use crate::exchange::{AccountMeta, ExError, Exchange, MarketSpec, OrderInput, OrderResult, XResult};
use crate::units::coins_from_lots;
use impulse_engine::ser::big;
use impulse_engine::Effect;
use serde::{Deserialize, Serialize};

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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Command {
    /// The first command of a fresh exchange: its clock origin is this command's time.
    Genesis,
    /// Startup after downtime: shift the clock origin by the outage, so engine time resumes where it stopped.
    Resume { down_ms: i64 },
    /// The 2 s clock step: funding, TWAPs, tapers, launch opens, book mids, pre-IPO marks.
    Clock,
    /// Sign up: a new account and its first faucet deposit. The API key was drawn at intake.
    Signup { name: String, api_key: String },
    /// A bot account (no faucet).
    CreateAccount { name: String, api_key: String, bot: bool },
    Faucet { account: String },
    Deposit { account: String, amount: String },
    Withdraw { account: String, amount: String },
    PlaceOrder { account: String, order: OrderInput },
    /// Close a whole position with a reduce-only market order.
    ClosePosition { account: String, market: String, slippage: f64 },
    Cancel { account: String, order: String },
    CancelAll { account: String, market: Option<String> },
    Margin { account: String, market: String, amount: String },
    SpotBuy { account: String, market: String, usdc: String },
    SpotSell { account: String, market: String, tokens: String },
    Snipe { account: String, market: String, usdc: String },
    /// Any listing: creator coins, admin markets, venue mirrors (their fetched metadata is in the spec), pre-IPO.
    ListMarket { spec: MarketSpec },
    AdminPrice { market: String, price: String, hold_seconds: f64 },
    ReleaseHold { market: String },
    Resolve { market: String, price: String },
    Ipo { market: String, price: String },
    /// `house_key` is the house account's API key, used if this pump creates it.
    Pump { market: String, usdc: String, house_key: String },
    SetBots { enabled: bool },
    /// One feed tick (test hook): the reply says whether it applied (None while an admin hold is on).
    Tick { tick: Tick },
    /// A feed poll: each tick applies on its own; a refused one doesn't stop the rest.
    Ticks { ticks: Vec<Tick> },
    /// Chart backfill from a venue's history.
    History { market: String, bars: Vec<Bar> },
    /// The bot maker replaces its ladder in one market (then book mids go to the engine).
    BotQuote { market: String },
    /// Test hook: round-trip the exchange through its snapshot format, then resume after `down_ms` of downtime.
    TestReload { down_ms: i64 },
}

impl Command {
    /// The journal's `kind` column.
    pub fn kind(&self) -> &'static str {
        match self {
            Command::Genesis => "genesis",
            Command::Resume { .. } => "resume",
            Command::Clock => "clock",
            Command::Signup { .. } => "signup",
            Command::CreateAccount { .. } => "createAccount",
            Command::Faucet { .. } => "faucet",
            Command::Deposit { .. } => "deposit",
            Command::Withdraw { .. } => "withdraw",
            Command::PlaceOrder { .. } => "placeOrder",
            Command::ClosePosition { .. } => "closePosition",
            Command::Cancel { .. } => "cancel",
            Command::CancelAll { .. } => "cancelAll",
            Command::Margin { .. } => "margin",
            Command::SpotBuy { .. } => "spotBuy",
            Command::SpotSell { .. } => "spotSell",
            Command::Snipe { .. } => "snipe",
            Command::ListMarket { .. } => "listMarket",
            Command::AdminPrice { .. } => "adminPrice",
            Command::ReleaseHold { .. } => "releaseHold",
            Command::Resolve { .. } => "resolve",
            Command::Ipo { .. } => "ipo",
            Command::Pump { .. } => "pump",
            Command::SetBots { .. } => "setBots",
            Command::Tick { .. } => "tick",
            Command::Ticks { .. } => "ticks",
            Command::History { .. } => "history",
            Command::BotQuote { .. } => "botQuote",
            Command::TestReload { .. } => "testReload",
        }
    }
}

/// What a command returns to its caller.
pub enum Reply {
    Done,
    Account(AccountMeta),
    Faucet(i128),
    Order(OrderResult),
    Effects(Vec<Effect>),
    /// A feed tick: None if it didn't apply (an admin hold, or a resolved market).
    Tick(Option<Vec<Effect>>),
    /// Per-tick refusals of a Ticks batch, for the feed's warnings.
    Ticks(Vec<(String, ExError)>),
    Cancelled(usize),
    Market(String),
    Reload { identical: bool, effects: Vec<Effect> },
}

impl Reply {
    pub fn effects(self) -> Vec<Effect> {
        match self {
            Reply::Effects(e) | Reply::Reload { effects: e, .. } => e,
            Reply::Tick(e) => e.unwrap_or_default(),
            Reply::Order(_) | Reply::Done | Reply::Account(_) | Reply::Faucet(_) | Reply::Ticks(_) | Reply::Cancelled(_) | Reply::Market(_) => vec![],
        }
    }
}

/// Run one command against the exchange, at the exchange's `now`.
pub fn apply(x: &mut Exchange, cmd: &Command) -> XResult<Reply> {
    Ok(match cmd {
        Command::Genesis => {
            x.genesis = x.now;
            x.version += 1;
            Reply::Done
        }
        Command::Resume { down_ms } => {
            x.resume_after(*down_ms);
            Reply::Done
        }
        Command::Clock => Reply::Effects(x.clock()?),
        Command::Signup { name, api_key } => {
            let meta = x.create_account(name, false, api_key)?;
            x.faucet(&meta.id)?;
            Reply::Account(meta)
        }
        Command::CreateAccount { name, api_key, bot } => Reply::Account(x.create_account(name, *bot, api_key)?),
        Command::Faucet { account } => Reply::Faucet(x.faucet(account)?),
        Command::Deposit { account, amount } => {
            x.deposit(account, amount)?;
            Reply::Done
        }
        Command::Withdraw { account, amount } => {
            x.withdraw(account, amount)?;
            Reply::Done
        }
        Command::PlaceOrder { account, order } => Reply::Order(x.place_order(account, order.clone())?),
        Command::ClosePosition { account, market, slippage } => {
            let sz = x.market(market)?.sz_decimals;
            let size = x.size_of(market, account);
            if size == 0 {
                return Err(ExError::bad(format!("no open position in {market}")));
            }
            let side = if size > 0 { Side::Sell } else { Side::Buy };
            let order = OrderInput { reduce_only: true, slippage: Some(*slippage), ..OrderInput::market(market, side, coins_from_lots(sz, size.abs())) };
            Reply::Order(x.place_order(account, order)?)
        }
        Command::Cancel { account, order } => {
            x.cancel(account, order)?;
            Reply::Done
        }
        Command::CancelAll { account, market } => Reply::Cancelled(x.cancel_all(account, market.as_deref())?),
        Command::Margin { account, market, amount } => {
            x.adjust_margin(account, market, amount)?;
            Reply::Done
        }
        Command::SpotBuy { account, market, usdc } => Reply::Effects(x.spot_buy(account, market, usdc)?),
        Command::SpotSell { account, market, tokens } => Reply::Effects(x.spot_sell(account, market, tokens)?),
        Command::Snipe { account, market, usdc } => {
            x.snipe(account, market, usdc)?;
            Reply::Done
        }
        Command::ListMarket { spec } => Reply::Market(x.create_market(spec.clone())?.id.clone()),
        Command::AdminPrice { market, price, hold_seconds } => Reply::Effects(x.admin_price(market, price, *hold_seconds)?),
        Command::ReleaseHold { market } => {
            x.release_hold(market)?;
            Reply::Done
        }
        Command::Resolve { market, price } => Reply::Effects(x.resolve(market, price)?),
        Command::Ipo { market, price } => Reply::Effects(x.ipo(market, price)?),
        Command::Pump { market, usdc, house_key } => Reply::Effects(x.pump(market, usdc, house_key)?),
        Command::SetBots { enabled } => {
            x.bots_enabled = *enabled;
            x.version += 1;
            if !enabled {
                for id in crate::bots::Bots::ids() {
                    if x.accounts.contains_key(id) {
                        x.cancel_all(id, None)?;
                    }
                }
            }
            Reply::Done
        }
        Command::Tick { tick } => Reply::Tick(x.tick(&tick.market, tick.price, false)?),
        Command::Ticks { ticks } => {
            let mut refused = vec![];
            for t in ticks {
                if let Err(e) = x.tick(&t.market, t.price, false) {
                    refused.push((t.market.clone(), e));
                }
            }
            Reply::Ticks(refused)
        }
        Command::History { market, bars } => {
            let mut points: Vec<_> = bars.iter().map(|b| (b.t, b.o, b.h, b.l, b.c)).collect();
            x.candles_from_history(market, &mut points);
            Reply::Done
        }
        Command::BotQuote { market } => {
            if x.markets.contains_key(market) {
                crate::bots::quote(x, market);
            }
            x.sync_books();
            Reply::Done
        }
        Command::TestReload { down_ms } => {
            let before = crate::persist::serialize(x);
            let (mut y, _) = crate::persist::deserialize(&before).map_err(ExError::Internal)?;
            let identical = crate::persist::serialize(&y) == before;
            y.version = x.version + 1;
            y.resume_after(*down_ms);
            let effects = y.clock()?;
            *x = y;
            Reply::Reload { identical, effects }
        }
    })
}
