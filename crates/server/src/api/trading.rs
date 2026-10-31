// Signed-in trading: orders, cancels, closes, margin, spot trades, creator-coin listing and snipes.

use super::*;

pub(super) async fn account(State(app): State<App>, User(id): User) -> ApiResult {
    ok(views::account_view(&app.lock().core.x, &id))
}

pub(super) async fn faucet(State(app): State<App>, User(id): User) -> ApiResult {
    let amount = app.lock().submit(Faucet { account: id })?;
    ok(json!({ "amount": usd(amount) }))
}

#[derive(Deserialize)]
pub(super) struct AmountReq {
    amount: Amount,
}

pub(super) async fn withdraw(State(app): State<App>, User(id): User, Body(b): Body<AmountReq>) -> ApiResult {
    app.lock().submit(Withdraw { account: id, amount: b.amount })?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OrderReq {
    market: String,
    side: Side,
    #[serde(rename = "type", default)]
    kind: OrderType,
    size: Dec,
    #[serde(default, deserialize_with = "field::dec")]
    price: Option<Dec>,
    #[serde(default, deserialize_with = "field::num")]
    leverage: Option<f64>,
    #[serde(default)]
    reduce_only: bool,
    tif: Option<Tif>,
    #[serde(default, deserialize_with = "field::num")]
    slippage: Option<f64>,
}

pub(super) async fn place_order(State(app): State<App>, User(id): User, Body(b): Body<OrderReq>) -> ApiResult {
    let order = OrderInput {
        market: b.market,
        side: b.side,
        kind: b.kind,
        size: b.size,
        price: b.price,
        leverage: b.leverage,
        reduce_only: b.reduce_only,
        tif: b.tif,
        slippage: b.slippage,
    };
    let mut node = app.lock();
    let r = node.submit(PlaceOrder { account: id.clone(), order })?;
    order_reply(&node.core.x, &id, r, true)
}

pub(super) async fn cancel(State(app): State<App>, User(id): User, Path(order): Path<String>) -> ApiResult {
    app.lock().submit(Cancel { account: id, order })?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub(super) struct CancelAllReq {
    #[serde(default, deserialize_with = "field::text")]
    market: Option<String>,
}

pub(super) async fn cancel_all(State(app): State<App>, User(id): User, Body(b): Body<CancelAllReq>) -> ApiResult {
    let n = app.lock().submit(CancelAll { account: id, market: b.market })?;
    ok(json!({ "cancelled": n }))
}

#[derive(Deserialize)]
pub(super) struct CloseReq {
    market: String,
    #[serde(default, deserialize_with = "field::num")]
    slippage: Option<f64>,
}

pub(super) async fn close_position(State(app): State<App>, User(id): User, Body(b): Body<CloseReq>) -> ApiResult {
    let cmd = ClosePosition { account: id.clone(), market: b.market, slippage: b.slippage.unwrap_or(0.1) };
    let mut node = app.lock();
    let r = node.submit(cmd)?;
    order_reply(&node.core.x, &id, r, false)
}

#[derive(Deserialize)]
pub(super) struct MarginReq {
    market: String,
    amount: Dec,
}

pub(super) async fn margin(State(app): State<App>, User(id): User, Body(b): Body<MarginReq>) -> ApiResult {
    app.lock().submit(Margin { account: id, market: b.market, amount: b.amount })?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub(super) struct UsdcReq {
    market: String,
    usdc: Amount,
}

pub(super) async fn spot_buy(State(app): State<App>, User(id): User, Body(b): Body<UsdcReq>) -> ApiResult {
    app.lock().submit(SpotBuy { account: id, market: b.market, usdc: b.usdc })?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub(super) struct SellReq {
    market: String,
    tokens: Tokens,
}

pub(super) async fn spot_sell(State(app): State<App>, User(id): User, Body(b): Body<SellReq>) -> ApiResult {
    app.lock().submit(SpotSell { account: id, market: b.market, tokens: b.tokens })?;
    ok(json!({ "ok": true }))
}

/// How long a new creator coin takes bids before its curve opens.
const SNIPE_SECONDS: i64 = 60;

/// A creator coin for a handle: an attention market that opens after a snipe window.
pub(super) fn coin_spec(raw: &str, window: f64, adl: &str, creator: &str) -> Result<MarketSpec, ExError> {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CoinReq {
    handle: String,
    #[serde(default, deserialize_with = "field::num")]
    oracle_window: Option<f64>,
    #[serde(default, deserialize_with = "field::text")]
    adl: Option<String>,
}

/// Permissionless listing, Mirror's pitch: anyone can launch an attention market for a handle.
pub(super) async fn attention(State(app): State<App>, User(id): User, Body(b): Body<CoinReq>) -> ApiResult {
    let adl = if b.adl.as_deref() == Some("size") { "size" } else { "pnl" };
    let spec = coin_spec(&b.handle, b.oracle_window.unwrap_or(600.0), adl, &id)?;
    list(&app, spec)
}

pub(super) async fn snipe(State(app): State<App>, User(id): User, Body(b): Body<UsdcReq>) -> ApiResult {
    app.lock().submit(Snipe { account: id, market: b.market, usdc: b.usdc })?;
    ok(json!({ "ok": true }))
}
