// HTTP + WebSocket API. Every handler locks the one exchange core and runs synchronously against it, so each
// request is one atomic step of the single-threaded core (Mirror's "one monolithic core", in miniature).
//
// Auth: `Authorization: Bearer <apiKey>` (issued at signup) for trading; `x-admin-token` for admin.

use crate::book::{Side, Tif};
use crate::bots::Bots;
use crate::command::{Command, Reply, Tick};
pub use crate::sequencer::Core;
use crate::exchange::{ExError, Exchange, Kind, MarketSpec, OrderInput, OrderType, Source};
use crate::intake::{api_key, wall_ms};
use crate::feeds;
use crate::rng::Rng;
use crate::units::usd;
use crate::views;
use axum::extract::{FromRequest, FromRequestParts, Path, Query, Request, State};
use axum::http::{header, request::Parts, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use impulse_engine::{check_invariants, Effect};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Component, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

/// One timestamped line on stdout. Write errors are ignored: a closed pipe must not take the server down.
pub fn log(s: &str) {
    use std::io::Write;
    let t = crate::feeds::iso_utc(wall_ms());
    let _ = writeln!(std::io::stdout(), "[{}] {s}", &t[11..19]);
}

pub struct Inner {
    core: Mutex<Core>,
    pub admin_token: String,
    pub web_dir: Option<PathBuf>,
    pub http: reqwest::Client,
    pub test_hooks: bool,
}

#[derive(Clone)]
pub struct App(Arc<Inner>);

impl std::ops::Deref for App {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl App {
    pub fn new(core: Core, admin_token: String, web_dir: Option<PathBuf>, test_hooks: bool) -> Self {
        App(Arc::new(Inner { core: Mutex::new(core), admin_token, web_dir, http: feeds::client(), test_hooks }))
    }

    pub fn lock(&self) -> MutexGuard<'_, Core> {
        // A panicking handler poisons the lock; the core is still consistent at engine-commit granularity.
        self.core.lock().unwrap_or_else(|e| e.into_inner())
    }
}

// ---------- errors and extractors ----------

pub struct ApiError(ExError);

impl From<ExError> for ApiError {
    fn from(e: ExError) -> Self {
        ApiError(e)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self.0 {
            ExError::Http(s, m) => (StatusCode::from_u16(s).unwrap_or(StatusCode::BAD_REQUEST), m),
            ExError::Internal(m) => {
                log(&format!("500: {m}"));
                (StatusCode::INTERNAL_SERVER_ERROR, m)
            }
        };
        (status, Json(json!({ "error": msg }))).into_response()
    }
}

type ApiResult = Result<Response, ApiError>;

fn ok<T: Serialize>(v: T) -> ApiResult {
    Ok(Json(v).into_response())
}

/// The signed-in account.
pub struct User(pub String);

impl FromRequestParts<App> for User {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, ApiError> {
        let key = parts.headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")).filter(|k| !k.is_empty());
        let account = key.and_then(|k| app.lock().x.account_by_key(k).map(|a| a.id.clone()));
        account.map(User).ok_or_else(|| ExError::status(401, "sign in first (missing or unknown API key)").into())
    }
}

pub struct Admin;

impl FromRequestParts<App> for Admin {
    type Rejection = ApiError;
    async fn from_request_parts(parts: &mut Parts, app: &App) -> Result<Self, ApiError> {
        match parts.headers.get("x-admin-token") {
            Some(t) if t.as_bytes() == app.admin_token.as_bytes() => Ok(Admin),
            _ => Err(ExError::status(403, "admin token required").into()),
        }
    }
}

/// A JSON object body with the TS server's loose field rules: anything that isn't an object reads as `{}`.
pub struct Body(Map<String, Value>);

impl<S: Send + Sync> FromRequest<S> for Body {
    type Rejection = ApiError;
    async fn from_request(req: Request, _: &S) -> Result<Self, ApiError> {
        if req.method() == Method::GET || req.method() == Method::HEAD {
            return Ok(Body(Map::new()));
        }
        let bytes = axum::body::to_bytes(req.into_body(), 64 * 1024).await.map_err(|_| ExError::status(413, "body too large"))?;
        if bytes.is_empty() {
            return Ok(Body(Map::new()));
        }
        match serde_json::from_slice::<Value>(&bytes) {
            Ok(Value::Object(m)) => Ok(Body(m)),
            Ok(_) => Ok(Body(Map::new())),
            Err(_) => Err(ExError::bad("body must be JSON").into()),
        }
    }
}

/// JS Number(v).
fn js_number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) if s.trim().is_empty() => 0.0,
        Value::String(s) => s.trim().parse().unwrap_or(f64::NAN),
        Value::Bool(b) => f64::from(u8::from(*b)),
        Value::Null => 0.0,
        _ => f64::NAN,
    }
}

impl Body {
    /// A required string field; numbers are accepted and read as their decimal text.
    fn str(&self, name: &str) -> Result<String, ExError> {
        match self.0.get(name) {
            Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
            Some(Value::Number(n)) => Ok(n.as_i64().map_or_else(|| n.as_f64().unwrap_or(0.0).to_string(), |i| i.to_string())),
            _ => Err(ExError::bad(format!("{name} is required"))),
        }
    }

    /// A string field, if present and non-empty.
    fn opt_str(&self, name: &str) -> Option<String> {
        match self.0.get(name) {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            _ => None,
        }
    }

    /// undefined, null and "" are absent; anything else goes through Number().
    fn num(&self, name: &str) -> Option<f64> {
        match self.0.get(name) {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) if s.is_empty() => None,
            Some(v) => Some(js_number(v)),
        }
    }

    /// JS truthiness.
    fn truthy(&self, name: &str) -> bool {
        match self.0.get(name) {
            None | Some(Value::Null) => false,
            Some(Value::Bool(b)) => *b,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
            Some(Value::String(s)) => !s.is_empty(),
            Some(_) => true,
        }
    }

    /// A truthy field as a number (`b.x && Number(b.x)`).
    fn truthy_num(&self, name: &str) -> Option<f64> {
        self.truthy(name).then(|| js_number(&self.0[name]))
    }
}

fn kinds(effects: &[Effect]) -> Vec<&'static str> {
    effects.iter().map(effect_kind).collect()
}

pub fn effect_kind(e: &Effect) -> &'static str {
    match e {
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

fn parse_side(s: &str) -> Result<Side, ExError> {
    match s {
        "buy" => Ok(Side::Buy),
        "sell" => Ok(Side::Sell),
        _ => Err(ExError::bad("side must be buy or sell")),
    }
}

fn parse_kind(s: &str) -> Result<Kind, ExError> {
    match s {
        "perp" => Ok(Kind::Perp),
        "binary" => Ok(Kind::Binary),
        "attention" => Ok(Kind::Attention),
        "preipo" => Ok(Kind::Preipo),
        _ => Err(ExError::bad("kind must be perp, binary, attention or preipo")),
    }
}

// ---------- public ----------

async fn health(State(app): State<App>) -> ApiResult {
    let core = app.lock();
    ok(json!({ "ok": true, "version": core.x.version, "time": core.x.now(), "engineTime": core.x.state.time as i64 }))
}

async fn config(State(app): State<App>) -> ApiResult {
    ok(views::config_view(&app.lock().x))
}

async fn markets(State(app): State<App>) -> ApiResult {
    ok(views::markets_view(&app.lock().x))
}

async fn market(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let core = app.lock();
    core.x.market(&id)?;
    ok(json!({ "market": views::market_view(&core.x, &id), "book": views::book_view(&core.x, &id, 20), "trades": views::trades_view(&core.x, &id, 60) }))
}

async fn candles(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let core = app.lock();
    core.x.market(&id)?;
    ok(views::candles_view(&core.x, &id))
}

async fn positions(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let core = app.lock();
    core.x.market(&id)?;
    ok(views::public_positions(&core.x, &id))
}

/// `?before=<id>` and `limit` page through the full history (the database); `limit` alone too.
fn page(q: &HashMap<String, String>) -> Option<(Option<u64>, usize)> {
    if !q.contains_key("before") && !q.contains_key("limit") {
        return None;
    }
    let before = q.get("before").and_then(|b| b.parse().ok());
    let limit = q.get("limit").and_then(|l| l.parse().ok()).unwrap_or(200).clamp(1, 1000);
    Some((before, limit))
}

async fn feed(State(app): State<App>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let core = app.lock();
    let market = q.get("market").filter(|m| !m.is_empty());
    if let (Some((before, limit)), Some(store)) = (page(&q), core.store()) {
        return ok(store.risk_page(market.map(String::as_str), before, limit).map_err(ExError::Internal)?);
    }
    let mut rows: Vec<_> = core.x.risk.iter().filter(|r| market.is_none_or(|m| *m == r.market)).collect();
    rows = rows.split_off(rows.len().saturating_sub(200));
    rows.reverse();
    ok(rows)
}

/// A market's trades, newest first: the latest 60 from memory, or pages of the full history (`before`, `limit`).
async fn trades(State(app): State<App>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let core = app.lock();
    core.x.market(&id)?;
    if let (Some((before, limit)), Some(store)) = (page(&q), core.store()) {
        return ok(store.fills_page(&id, before, limit).map_err(ExError::Internal)?);
    }
    ok(views::trades_view(&core.x, &id, 60))
}

async fn leaderboard(State(app): State<App>) -> ApiResult {
    ok(views::leaderboard_view(&app.lock().x))
}

async fn signup(State(app): State<App>, b: Body) -> ApiResult {
    let Reply::Account(meta) = app.lock().submit(Command::Signup { name: b.str("name")?, api_key: api_key() })? else { unreachable!() };
    log(&format!("new account {}", meta.id));
    ok(json!({ "id": meta.id, "apiKey": meta.api_key }))
}

fn effects_of(r: Reply) -> Vec<&'static str> {
    kinds(&r.effects())
}

fn order_reply(x: &Exchange, id: &str, r: Reply, with_order: bool) -> ApiResult {
    let Reply::Order(r) = r else { unreachable!() };
    let fills: Vec<_> = r.fills.iter().map(|f| views::fill_view(x, f, Some(id))).collect();
    if with_order {
        ok(json!({ "status": r.status, "reason": r.reason, "order": views::order_view(x, &r.order), "fills": fills }))
    } else {
        ok(json!({ "status": r.status, "reason": r.reason, "fills": fills }))
    }
}

// ---------- trading ----------

async fn account(State(app): State<App>, User(id): User) -> ApiResult {
    ok(views::account_view(&app.lock().x, &id))
}

async fn faucet(State(app): State<App>, User(id): User) -> ApiResult {
    let Reply::Faucet(amount) = app.lock().submit(Command::Faucet { account: id })? else { unreachable!() };
    ok(json!({ "amount": usd(amount) }))
}

async fn withdraw(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(Command::Withdraw { account: id, amount: b.str("amount")? })?;
    ok(json!({ "ok": true }))
}

async fn place_order(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    let kind = match b.0.get("type") {
        None | Some(Value::Null) => "limit".to_string(),
        _ => b.str("type")?,
    };
    let input = OrderInput {
        market: b.str("market")?,
        side: parse_side(&b.str("side")?)?,
        kind: match kind.as_str() {
            "limit" => OrderType::Limit,
            "market" => OrderType::Market,
            _ => return Err(ExError::bad("type must be limit or market").into()),
        },
        size: b.str("size")?,
        price: match b.0.get("price") {
            None => None,
            Some(Value::String(s)) if s.is_empty() => None,
            _ => Some(b.str("price")?),
        },
        leverage: b.num("leverage"),
        reduce_only: b.truthy("reduceOnly"),
        tif: match b.0.get("tif") {
            None => None,
            _ => Some(match b.str("tif")?.as_str() {
                "gtc" => Tif::Gtc,
                "ioc" => Tif::Ioc,
                "alo" => Tif::Alo,
                _ => return Err(ExError::bad("tif must be gtc, ioc or alo").into()),
            }),
        },
        slippage: b.num("slippage"),
    };
    let mut core = app.lock();
    let r = core.submit(Command::PlaceOrder { account: id.clone(), order: input })?;
    order_reply(&core.x, &id, r, true)
}

async fn cancel(State(app): State<App>, User(id): User, Path(order): Path<String>) -> ApiResult {
    app.lock().submit(Command::Cancel { account: id, order })?;
    ok(json!({ "ok": true }))
}

async fn cancel_all(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    let market = match b.0.get("market") {
        Some(Value::String(m)) => Some(m.clone()),
        _ => None,
    };
    let Reply::Cancelled(n) = app.lock().submit(Command::CancelAll { account: id, market })? else { unreachable!() };
    ok(json!({ "cancelled": n }))
}

async fn close_position(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    let cmd = Command::ClosePosition { account: id.clone(), market: b.str("market")?, slippage: b.num("slippage").unwrap_or(0.1) };
    let mut core = app.lock();
    let r = core.submit(cmd)?;
    order_reply(&core.x, &id, r, false)
}

async fn margin(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(Command::Margin { account: id, market: b.str("market")?, amount: b.str("amount")? })?;
    ok(json!({ "ok": true }))
}

async fn spot_buy(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(Command::SpotBuy { account: id, market: b.str("market")?, usdc: b.str("usdc")? })?;
    ok(json!({ "ok": true }))
}

async fn spot_sell(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(Command::SpotSell { account: id, market: b.str("market")?, tokens: b.str("tokens")? })?;
    ok(json!({ "ok": true }))
}

/// How long a new creator coin takes bids before its curve opens.
const SNIPE_SECONDS: i64 = 60;

/// A creator coin for a handle: an attention market that opens after a snipe window.
fn coin_spec(raw: &str, window: f64, adl: &str, creator: &str) -> Result<MarketSpec, ExError> {
    let handle = format!("@{}", raw.strip_prefix('@').unwrap_or(raw));
    if !(3..=21).contains(&handle.len()) || !handle[1..].bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_') {
        return Err(ExError::bad("handle must be 2–20 letters, digits or _"));
    }
    if ![0.0, 60.0, 600.0, 3600.0].contains(&window) {
        return Err(ExError::bad("oracleWindow must be 0, 60, 600 or 3600 seconds"));
    }
    let oracle = if window == 0.0 { "the instant spot price".into() } else { format!("a {}-minute TWAP of the spot price", window / 60.0) };
    Ok(MarketSpec {
        name: Some(format!("{handle} attention token")),
        base: Some(handle.clone()),
        oracle_window: Some(window),
        adl: Some(adl.into()),
        creator: Some(creator.into()),
        snipe_seconds: Some(SNIPE_SECONDS),
        description: Some(format!(
            "Listed by {creator}. Bids for {SNIPE_SECONDS} s, then opens at one price for every bid. Spot trades on an xy=k curve ($5k virtual USDC, 1B tokens); the perp's oracle is {oracle}."
        )),
        ..MarketSpec::new(handle, Kind::Attention, Source::Curve)
    })
}

/// Permissionless listing, Mirror's pitch: anyone can launch an attention market for a handle.
async fn attention(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    let adl = if b.0.get("adl") == Some(&json!("size")) { "size" } else { "pnl" };
    let spec = coin_spec(&b.str("handle")?, b.num("oracleWindow").unwrap_or(600.0), adl, &id)?;
    list(&app, spec)
}

/// List a market and reply with its view.
fn list(app: &App, spec: MarketSpec) -> ApiResult {
    let mut core = app.lock();
    let Reply::Market(id) = core.submit(Command::ListMarket { spec })? else { unreachable!() };
    ok(views::market_view(&core.x, &id))
}

async fn snipe(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(Command::Snipe { account: id, market: b.str("market")?, usdc: b.str("usdc")? })?;
    ok(json!({ "ok": true }))
}

// ---------- admin ----------

/// After a gap the book is still quoted around the old price; have the bot maker re-quote that market now
/// (rather than on its next turn), so the book, and the funding premium read from it, follow the new mark.
fn requote(core: &mut Core, market: &str) {
    let cmd = if core.bots.is_some() && core.x.bots_enabled { Command::BotQuote { market: market.into() } } else { Command::Clock };
    if let Err(e) = core.submit(cmd) {
        log(&format!("requote {market}: {}", e.message()));
    }
}

async fn admin_price(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let market = b.str("market")?;
    let mut core = app.lock();
    let r = core.submit(Command::AdminPrice { market: market.clone(), price: b.str("price")?, hold_seconds: b.num("holdSeconds").unwrap_or(60.0) })?;
    requote(&mut core, &market);
    ok(json!({ "effects": effects_of(r) }))
}

async fn admin_release(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    app.lock().submit(Command::ReleaseHold { market: b.str("market")? })?;
    ok(json!({ "ok": true }))
}

async fn admin_resolve(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    app.lock().submit(Command::Resolve { market: b.str("market")?, price: b.str("price")? })?;
    ok(json!({ "ok": true }))
}

async fn admin_market(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let id = b.str("id")?;
    let kind = parse_kind(&b.opt_str("kind").unwrap_or_else(|| "binary".into()))?;
    let now = app.lock().clock.now();
    let sz = match b.num("szDecimals") {
        None => None,
        Some(v) if v.fract() == 0.0 && (0.0..=9.0).contains(&v) => Some(v as u32),
        Some(_) => return Err(ExError::bad("szDecimals must be a whole number 0–9").into()),
    };
    // Admin perps get a random-walk oracle so they move on their own; admin binaries move only when told to.
    let source = if kind == Kind::Perp {
        let vol = b.num("volBps").unwrap_or(20.0);
        Source::Sim { vol_bps: if vol.is_nan() || vol == 0.0 { 20.0 } else { vol } }
    } else {
        Source::Manual
    };
    let spec = MarketSpec {
        name: Some(b.opt_str("name").unwrap_or_else(|| id.clone())),
        price: Some(b.str("price")?),
        base: b.opt_str("base"),
        sz_decimals: sz,
        adl: b.opt_str("adl"),
        description: b.opt_str("description"),
        resolves_at_ms: b.truthy_num("resolvesInMinutes").map(|m| (now as f64 + m * 60_000.0) as i64),
        taper_seconds: b.truthy_num("taperMinutes").map(|m| (m * 60.0).round()),
        initial_leverage: b.truthy_num("initialLeverage"),
        maintenance_leverage: b.truthy_num("maintenanceLeverage"),
        creator: Some("admin".into()),
        ..MarketSpec::new(id, kind, source)
    };
    list(&app, spec)
}

// Listing from live venues fetches the venue's metadata first, outside the lock.
async fn admin_polymarket(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let id = feeds::list_polymarket(&app, &b.str("ref")?).await?;
    ok(views::market_view(&app.lock().x, &id))
}

async fn admin_hyperliquid(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let id = feeds::list_hyperliquid(&app, &b.str("coin")?).await?;
    ok(views::market_view(&app.lock().x, &id))
}

/// A creator coin for the demo, listed by admin (a random handle if none is given).
async fn admin_demo_coin(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let handle = match b.opt_str("handle") {
        Some(h) => h,
        None => {
            let mut rng = Rng::from_time();
            let tag: String = (0..5).map(|_| b"abcdefghijkmnpqrstuvwxyz23456789"[rng.below(32)] as char).collect();
            format!("demo_{tag}")
        }
    };
    list(&app, coin_spec(&handle, 600.0, "pnl", "admin")?)
}

async fn admin_pump(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let r = app.lock().submit(Command::Pump { market: b.str("market")?, usdc: b.str("usdc")?, house_key: api_key() })?;
    ok(json!({ "effects": effects_of(r) }))
}

/// A pre-IPO perp: no outside price, the mark is the market's own book until the admin IPO.
async fn admin_preipo(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let id = b.str("id")?;
    let price = b.str("price")?;
    let seed: f64 = price.parse().unwrap_or(0.0);
    let spec = MarketSpec {
        name: Some(b.opt_str("name").unwrap_or_else(|| id.clone())),
        price: Some(price),
        sz_decimals: Some(if seed > 1000.0 { 4 } else if seed > 10.0 { 2 } else { 0 }),
        description: b.opt_str("description"),
        creator: Some("admin".into()),
        ..MarketSpec::new(id, Kind::Preipo, Source::Book)
    };
    list(&app, spec)
}

async fn admin_ipo(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let market = b.str("market")?;
    let mut core = app.lock();
    let r = core.submit(Command::Ipo { market: market.clone(), price: b.str("price")? })?;
    requote(&mut core, &market);
    ok(json!({ "effects": effects_of(r) }))
}

async fn admin_deposit(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    app.lock().submit(Command::Deposit { account: b.str("account")?, amount: b.str("amount")? })?;
    ok(json!({ "ok": true }))
}

async fn admin_bots(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let mut core = app.lock();
    if core.bots.is_none() {
        return Err(ExError::bad("bots are not running (BOTS=0)").into());
    }
    let enabled = b.truthy("enabled");
    core.submit(Command::SetBots { enabled })?;
    ok(json!({ "enabled": enabled }))
}

async fn admin_status(State(app): State<App>, _: Admin) -> ApiResult {
    let core = app.lock();
    let bots = core.bots.as_ref().map(|_| json!({ "enabled": core.x.bots_enabled, "accounts": Bots::summary(&core.x) }));
    ok(json!({ "bots": bots }))
}

// ---------- test hooks (TEST_CLOCK=1): a clock only tests move, and views into the core ----------

async fn test_advance(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let mut core = app.lock();
    core.clock.advance(b.num("ms").unwrap_or(0.0) as i64);
    let r = core.submit(Command::Clock)?;
    ok(json!({ "effects": effects_of(r), "now": core.clock.now() }))
}

async fn test_market(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let source = match b.0.get("source") {
        Some(v) => serde_json::from_value::<Source>(v.clone()).map_err(|e| ExError::bad(format!("source: {e}")))?,
        None => Source::Manual,
    };
    let spec = MarketSpec {
        price: b.opt_str("price"),
        sz_decimals: b.num("szDecimals").map(|v| v as u32),
        oracle_window: b.num("oracleWindow"),
        fee_bps: b.num("feeBps"),
        adl: b.opt_str("adl"),
        snipe_seconds: b.num("snipeSeconds").map(|v| v as i64),
        ..MarketSpec::new(b.str("id")?, parse_kind(&b.str("kind")?)?, source)
    };
    list(&app, spec)
}

async fn test_tick(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let tick = Tick { market: b.str("market")?, price: crate::units::parse_fixed(&b.str("price")?).map_err(ExError::bad)? };
    let Reply::Tick(effects) = app.lock().submit(Command::Tick { tick })? else { unreachable!() };
    ok(json!({ "effects": effects.map(|e| kinds(&e)) }))
}

async fn test_invariants(State(app): State<App>, _: Admin) -> ApiResult {
    ok(check_invariants(&app.lock().x.state))
}

async fn test_hash(State(app): State<App>, _: Admin) -> ApiResult {
    let core = app.lock();
    ok(json!({ "hash": core.x.state_hash(), "seq": core.seq }))
}

/// Round-trip the whole exchange through a snapshot in place, then treat `downMs` as downtime.
async fn test_reload(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let down = b.num("downMs").unwrap_or(0.0) as i64;
    let mut core = app.lock();
    core.clock.advance(down);
    let Reply::Reload { identical, effects } = core.submit(Command::TestReload { down_ms: down })? else { unreachable!() };
    ok(json!({ "identical": identical, "effects": kinds(&effects) }))
}

// ---------- plumbing ----------

async fn not_found(method: Method, uri: Uri) -> ApiError {
    ExError::status(404, format!("no route {method} {}", uri.path())).into()
}

async fn fallback(State(app): State<App>, method: Method, uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return not_found(method, uri).await.into_response();
    }
    serve_static(app.web_dir.as_deref(), uri.path()).await
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn content_type(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "json" => "application/json",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

async fn serve_static(web_dir: Option<&std::path::Path>, path: &str) -> Response {
    let Some(root) = web_dir.filter(|d| d.is_dir()) else {
        return ([(header::CONTENT_TYPE, "text/plain")], "Impulse API is running. The web app isn't built: run `make web` (or `make dev` for the Vite dev server).")
            .into_response();
    };
    let Some(decoded) = percent_decode(path) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let rel = PathBuf::from(decoded.trim_start_matches('/'));
    if rel.components().any(|c| !matches!(c, Component::Normal(_))) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let mut file = root.join(&rel);
    if !file.is_file() {
        file = root.join("index.html"); // SPA fallback
    }
    match tokio::fs::read(&file).await {
        Ok(bytes) => ([(header::CONTENT_TYPE, content_type(&file))], bytes).into_response(),
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

/// CORS for the API, as the TS server sends it.
async fn cors(req: Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        let h = res.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET,POST,DELETE,OPTIONS"));
        h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("content-type,authorization,x-admin-token"));
        return res;
    }
    let api = req.uri().path().starts_with("/api/");
    let mut res = next.run(req).await;
    if api {
        res.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    }
    res
}

pub fn router(app: App) -> Router {
    let mut r = Router::new()
        .route("/api/health", get(health))
        .route("/api/config", get(config))
        .route("/api/markets", get(markets))
        .route("/api/markets/{id}", get(market))
        .route("/api/markets/{id}/candles", get(candles))
        .route("/api/markets/{id}/positions", get(positions))
        .route("/api/markets/{id}/trades", get(trades))
        .route("/api/feed", get(feed))
        .route("/api/leaderboard", get(leaderboard))
        .route("/api/accounts", post(signup))
        .route("/api/account", get(account))
        .route("/api/faucet", post(faucet))
        .route("/api/withdraw", post(withdraw))
        .route("/api/orders", post(place_order))
        .route("/api/orders/cancel-all", post(cancel_all))
        .route("/api/orders/{id}", delete(cancel))
        .route("/api/positions/close", post(close_position))
        .route("/api/margin", post(margin))
        .route("/api/spot/buy", post(spot_buy))
        .route("/api/spot/sell", post(spot_sell))
        .route("/api/attention", post(attention))
        .route("/api/snipe", post(snipe))
        .route("/api/admin/price", post(admin_price))
        .route("/api/admin/release", post(admin_release))
        .route("/api/admin/resolve", post(admin_resolve))
        .route("/api/admin/market", post(admin_market))
        .route("/api/admin/polymarket", post(admin_polymarket))
        .route("/api/admin/hyperliquid", post(admin_hyperliquid))
        .route("/api/admin/deposit", post(admin_deposit))
        .route("/api/admin/demo-coin", post(admin_demo_coin))
        .route("/api/admin/pump", post(admin_pump))
        .route("/api/admin/preipo", post(admin_preipo))
        .route("/api/admin/ipo", post(admin_ipo))
        .route("/api/admin/bots", post(admin_bots))
        .route("/api/admin/status", get(admin_status))
        .route("/ws", get(crate::ws::upgrade));
    if app.test_hooks {
        r = r
            .route("/api/test/advance", post(test_advance))
            .route("/api/test/market", post(test_market))
            .route("/api/test/tick", post(test_tick))
            .route("/api/test/invariants", get(test_invariants))
            .route("/api/test/hash", get(test_hash))
            .route("/api/test/reload", post(test_reload));
    }
    r.method_not_allowed_fallback(not_found).fallback(fallback).layer(axum::middleware::from_fn(cors)).with_state(app)
}

