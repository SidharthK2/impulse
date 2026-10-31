// Signed-in trading: orders, cancels, closes, margin, spot trades, creator-coin listing and snipes.

use super::*;

pub(super) async fn account(State(app): State<App>, User(id): User) -> ApiResult {
    ok(views::account_view(&app.lock().core.x, &id))
}

pub(super) async fn faucet(State(app): State<App>, User(id): User) -> ApiResult {
    let amount = app.lock().submit(Faucet { account: id })?;
    ok(json!({ "amount": usd(amount) }))
}

pub(super) async fn withdraw(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(Withdraw { account: id, amount: b.amount("amount")? })?;
    ok(json!({ "ok": true }))
}

pub(super) async fn place_order(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
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
        size: b.dec("size")?,
        price: match b.0.get("price") {
            None => None,
            Some(Value::String(s)) if s.is_empty() => None,
            _ => Some(b.dec("price")?),
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
    let mut node = app.lock();
    let r = node.submit(PlaceOrder { account: id.clone(), order: input })?;
    order_reply(&node.core.x, &id, r, true)
}

pub(super) async fn cancel(State(app): State<App>, User(id): User, Path(order): Path<String>) -> ApiResult {
    app.lock().submit(Cancel { account: id, order })?;
    ok(json!({ "ok": true }))
}

pub(super) async fn cancel_all(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    let market = match b.0.get("market") {
        Some(Value::String(m)) => Some(m.clone()),
        _ => None,
    };
    let n = app.lock().submit(CancelAll { account: id, market })?;
    ok(json!({ "cancelled": n }))
}

pub(super) async fn close_position(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    let cmd = ClosePosition { account: id.clone(), market: b.str("market")?, slippage: b.num("slippage").unwrap_or(0.1) };
    let mut node = app.lock();
    let r = node.submit(cmd)?;
    order_reply(&node.core.x, &id, r, false)
}

pub(super) async fn margin(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(Margin { account: id, market: b.str("market")?, amount: b.dec("amount")? })?;
    ok(json!({ "ok": true }))
}

pub(super) async fn spot_buy(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(SpotBuy { account: id, market: b.str("market")?, usdc: b.amount("usdc")? })?;
    ok(json!({ "ok": true }))
}

pub(super) async fn spot_sell(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(SpotSell { account: id, market: b.str("market")?, tokens: b.tokens("tokens")? })?;
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

/// Permissionless listing, Mirror's pitch: anyone can launch an attention market for a handle.
pub(super) async fn attention(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    let adl = if b.0.get("adl") == Some(&json!("size")) { "size" } else { "pnl" };
    let spec = coin_spec(&b.str("handle")?, b.num("oracleWindow").unwrap_or(600.0), adl, &id)?;
    list(&app, spec)
}

pub(super) async fn snipe(State(app): State<App>, User(id): User, b: Body) -> ApiResult {
    app.lock().submit(Snipe { account: id, market: b.str("market")?, usdc: b.amount("usdc")? })?;
    ok(json!({ "ok": true }))
}
