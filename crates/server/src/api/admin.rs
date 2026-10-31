// Admin: price overrides and holds, resolution, listings, the demo coin, pump, pre-IPO and IPO, deposits, bots.

use super::*;

/// After a gap the book is still quoted around the old price; have the bot maker re-quote that market now
/// (rather than on its next turn), so the book, and the funding premium read from it, follow the new mark.
fn requote(node: &mut Node, market: &str) {
    let cmd: Command = if node.intake.bots.is_some() && node.core.x.bots_enabled {
        BotQuote {
            market: market.into(),
        }
        .into()
    } else {
        Clock {}.into()
    };
    if let Err(e) = node.submit(cmd) {
        log(&format!("requote {market}: {}", e.message()));
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PriceReq {
    market: String,
    price: Dec,
    #[serde(default, deserialize_with = "field::num")]
    hold_seconds: Option<f64>,
}

pub(super) async fn price(State(app): State<App>, _: Admin, Body(b): Body<PriceReq>) -> ApiResult {
    let mut node = app.lock();
    let r = node.submit(AdminPrice {
        market: b.market.clone(),
        price: b.price,
        hold_seconds: b.hold_seconds.unwrap_or(60.0),
    })?;
    requote(&mut node, &b.market);
    ok(json!({ "effects": kinds(&r) }))
}

#[derive(Deserialize)]
pub(super) struct MarketReq {
    market: String,
}

pub(super) async fn release(
    State(app): State<App>,
    _: Admin,
    Body(b): Body<MarketReq>,
) -> ApiResult {
    app.lock().submit(ReleaseHold { market: b.market })?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub(super) struct MarketPriceReq {
    market: String,
    price: Dec,
}

pub(super) async fn resolve(
    State(app): State<App>,
    _: Admin,
    Body(b): Body<MarketPriceReq>,
) -> ApiResult {
    app.lock().submit(Resolve {
        market: b.market,
        price: b.price,
    })?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ListReq {
    id: String,
    #[serde(default)]
    kind: Option<Kind>,
    #[serde(default, deserialize_with = "field::text")]
    name: Option<String>,
    price: Dec,
    #[serde(default, deserialize_with = "field::text")]
    base: Option<String>,
    #[serde(default, deserialize_with = "field::num")]
    sz_decimals: Option<f64>,
    #[serde(default, deserialize_with = "field::text")]
    adl: Option<String>,
    #[serde(default, deserialize_with = "field::text")]
    description: Option<String>,
    #[serde(default, deserialize_with = "field::num")]
    resolves_in_minutes: Option<f64>,
    #[serde(default, deserialize_with = "field::num")]
    taper_minutes: Option<f64>,
    #[serde(default, deserialize_with = "field::num")]
    initial_leverage: Option<f64>,
    #[serde(default, deserialize_with = "field::num")]
    maintenance_leverage: Option<f64>,
    #[serde(default, deserialize_with = "field::num")]
    vol_bps: Option<f64>,
}

pub(super) async fn market(State(app): State<App>, _: Admin, Body(b): Body<ListReq>) -> ApiResult {
    let kind = b.kind.unwrap_or(Kind::Binary);
    let now = app.lock().intake.clock.now();
    let sz = match b.sz_decimals {
        None => None,
        Some(v) if v.fract() == 0.0 && (0.0..=9.0).contains(&v) => Some(v as u32),
        Some(_) => return Err(ExError::bad("szDecimals must be a whole number 0–9").into()),
    };
    // Admin perps get a random-walk oracle so they move on their own; admin binaries move only when told to.
    let source = if kind == Kind::Perp {
        Source::Sim {
            vol_bps: b.vol_bps.filter(|v| *v > 0.0).unwrap_or(20.0),
        }
    } else {
        Source::Manual
    };
    // 0 minutes means none, as the admin form sends it.
    let positive = |v: Option<f64>| v.filter(|v| *v != 0.0);
    let spec = MarketSpec {
        name: Some(b.name.unwrap_or_else(|| b.id.clone())),
        price: Some(b.price),
        base: b.base,
        sz_decimals: sz,
        adl: b.adl,
        description: b.description,
        resolves_at_ms: positive(b.resolves_in_minutes).map(|m| (now as f64 + m * 60_000.0) as i64),
        taper_seconds: positive(b.taper_minutes).map(|m| (m * 60.0).round()),
        initial_leverage: positive(b.initial_leverage),
        maintenance_leverage: positive(b.maintenance_leverage),
        creator: Some("admin".into()),
        ..MarketSpec::new(b.id, kind, source)
    };
    list(&app, spec)
}

// Listing from live venues fetches the venue's metadata first, outside the lock.

#[derive(Deserialize)]
pub(super) struct PolymarketReq {
    #[serde(rename = "ref")]
    reference: String,
}

pub(super) async fn polymarket(
    State(app): State<App>,
    _: Admin,
    Body(b): Body<PolymarketReq>,
) -> ApiResult {
    let id = feeds::list_polymarket(&app, &b.reference).await?;
    ok(views::market_view(&app.lock().core.x, &id))
}

#[derive(Deserialize)]
pub(super) struct HyperliquidReq {
    coin: String,
}

pub(super) async fn hyperliquid(
    State(app): State<App>,
    _: Admin,
    Body(b): Body<HyperliquidReq>,
) -> ApiResult {
    let id = feeds::list_hyperliquid(&app, &b.coin).await?;
    ok(views::market_view(&app.lock().core.x, &id))
}

#[derive(Deserialize)]
pub(super) struct DemoCoinReq {
    #[serde(default, deserialize_with = "field::text")]
    handle: Option<String>,
}

/// A creator coin for the demo, listed by admin (a random handle if none is given).
pub(super) async fn demo_coin(
    State(app): State<App>,
    _: Admin,
    Body(b): Body<DemoCoinReq>,
) -> ApiResult {
    let handle = b.handle.unwrap_or_else(|| {
        let mut rng = Rng::from_time();
        let tag: String = (0..5)
            .map(|_| b"abcdefghijkmnpqrstuvwxyz23456789"[rng.below(32)] as char)
            .collect();
        format!("demo_{tag}")
    });
    list(
        &app,
        super::trading::coin_spec(&handle, 600.0, "pnl", "admin")?,
    )
}

#[derive(Deserialize)]
pub(super) struct PumpReq {
    market: String,
    usdc: Dec,
}

pub(super) async fn pump(State(app): State<App>, _: Admin, Body(b): Body<PumpReq>) -> ApiResult {
    let r = app.lock().submit(Pump {
        market: b.market,
        usdc: b.usdc,
        house_key: api_key(),
    })?;
    ok(json!({ "effects": kinds(&r) }))
}

#[derive(Deserialize)]
pub(super) struct PreipoReq {
    id: String,
    #[serde(default, deserialize_with = "field::text")]
    name: Option<String>,
    price: Dec,
    #[serde(default, deserialize_with = "field::text")]
    description: Option<String>,
}

/// A pre-IPO perp: no outside price, the mark is the market's own book until the admin IPO.
pub(super) async fn preipo(
    State(app): State<App>,
    _: Admin,
    Body(b): Body<PreipoReq>,
) -> ApiResult {
    let seed = b.price.nano() as f64 / 1e9;
    let spec = MarketSpec {
        name: Some(b.name.unwrap_or_else(|| b.id.clone())),
        price: Some(b.price),
        sz_decimals: Some(if seed > 1000.0 {
            4
        } else if seed > 10.0 {
            2
        } else {
            0
        }),
        description: b.description,
        creator: Some("admin".into()),
        ..MarketSpec::new(b.id, Kind::Preipo, Source::Book)
    };
    list(&app, spec)
}

pub(super) async fn ipo(
    State(app): State<App>,
    _: Admin,
    Body(b): Body<MarketPriceReq>,
) -> ApiResult {
    let mut node = app.lock();
    let r = node.submit(Ipo {
        market: b.market.clone(),
        price: b.price,
    })?;
    requote(&mut node, &b.market);
    ok(json!({ "effects": kinds(&r) }))
}

#[derive(Deserialize)]
pub(super) struct DepositReq {
    account: String,
    amount: Dec,
}

pub(super) async fn deposit(
    State(app): State<App>,
    _: Admin,
    Body(b): Body<DepositReq>,
) -> ApiResult {
    app.lock().submit(Deposit {
        account: b.account,
        amount: b.amount,
    })?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub(super) struct BotsReq {
    #[serde(default)]
    enabled: bool,
}

pub(super) async fn bots(State(app): State<App>, _: Admin, Body(b): Body<BotsReq>) -> ApiResult {
    let mut node = app.lock();
    if node.intake.bots.is_none() {
        return Err(ExError::bad("bots are not running (BOTS=0)").into());
    }
    node.submit(SetBots { enabled: b.enabled })?;
    ok(json!({ "enabled": b.enabled }))
}

pub(super) async fn status(State(app): State<App>, _: Admin) -> ApiResult {
    let node = app.lock();
    let bots = node.intake.bots.as_ref().map(
        |_| json!({ "enabled": node.core.x.bots_enabled, "accounts": Bots::summary(&node.core.x) }),
    );
    ok(json!({ "bots": bots }))
}

/// The journal's position and the time each journaled command took (apply + journal commit), since the start.
pub(super) async fn stats(State(app): State<App>, _: Admin) -> ApiResult {
    let node = app.lock();
    let mut us: Vec<u64> = node
        .core
        .timings
        .iter()
        .map(|d| d.as_micros() as u64)
        .collect();
    us.sort_unstable();
    let at = |q: f64| {
        us.get(((us.len() as f64 - 1.0) * q).round() as usize)
            .copied()
            .unwrap_or(0)
    };
    let mean = if us.is_empty() {
        0
    } else {
        us.iter().sum::<u64>() / us.len() as u64
    };
    ok(
        json!({ "seq": node.core.seq, "n": us.len(), "p50_us": at(0.5), "p99_us": at(0.99), "max_us": us.last().copied().unwrap_or(0), "mean_us": mean }),
    )
}
