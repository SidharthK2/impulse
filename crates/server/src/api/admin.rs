// Admin: price overrides and holds, resolution, listings, the demo coin, pump, pre-IPO and IPO, deposits, bots.

use super::*;

/// After a gap the book is still quoted around the old price; have the bot maker re-quote that market now
/// (rather than on its next turn), so the book, and the funding premium read from it, follow the new mark.
fn requote(node: &mut Node, market: &str) {
    let cmd = if node.intake.bots.is_some() && node.core.x.bots_enabled { Command::BotQuote { market: market.into() } } else { Command::Clock };
    if let Err(e) = node.submit(cmd) {
        log(&format!("requote {market}: {}", e.message()));
    }
}

pub(super) async fn price(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let market = b.str("market")?;
    let mut node = app.lock();
    let r = node.submit(Command::AdminPrice { market: market.clone(), price: b.dec("price")?, hold_seconds: b.num("holdSeconds").unwrap_or(60.0) })?;
    requote(&mut node, &market);
    ok(json!({ "effects": effects_of(r) }))
}

pub(super) async fn release(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    app.lock().submit(Command::ReleaseHold { market: b.str("market")? })?;
    ok(json!({ "ok": true }))
}

pub(super) async fn resolve(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    app.lock().submit(Command::Resolve { market: b.str("market")?, price: b.dec("price")? })?;
    ok(json!({ "ok": true }))
}

pub(super) async fn market(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let id = b.str("id")?;
    let kind = parse_kind(&b.opt_str("kind").unwrap_or_else(|| "binary".into()))?;
    let now = app.lock().intake.clock.now();
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
        price: Some(b.dec("price")?),
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

pub(super) async fn polymarket(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let id = feeds::list_polymarket(&app, &b.str("ref")?).await?;
    ok(views::market_view(&app.lock().core.x, &id))
}

pub(super) async fn hyperliquid(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let id = feeds::list_hyperliquid(&app, &b.str("coin")?).await?;
    ok(views::market_view(&app.lock().core.x, &id))
}

/// A creator coin for the demo, listed by admin (a random handle if none is given).
pub(super) async fn demo_coin(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let handle = match b.opt_str("handle") {
        Some(h) => h,
        None => {
            let mut rng = Rng::from_time();
            let tag: String = (0..5).map(|_| b"abcdefghijkmnpqrstuvwxyz23456789"[rng.below(32)] as char).collect();
            format!("demo_{tag}")
        }
    };
    list(&app, super::trading::coin_spec(&handle, 600.0, "pnl", "admin")?)
}

pub(super) async fn pump(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let r = app.lock().submit(Command::Pump { market: b.str("market")?, usdc: b.dec("usdc")?, house_key: api_key() })?;
    ok(json!({ "effects": effects_of(r) }))
}

/// A pre-IPO perp: no outside price, the mark is the market's own book until the admin IPO.
pub(super) async fn preipo(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let id = b.str("id")?;
    let price = b.dec("price")?;
    let seed = price.nano() as f64 / 1e9;
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

pub(super) async fn ipo(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let market = b.str("market")?;
    let mut node = app.lock();
    let r = node.submit(Command::Ipo { market: market.clone(), price: b.dec("price")? })?;
    requote(&mut node, &market);
    ok(json!({ "effects": effects_of(r) }))
}

pub(super) async fn deposit(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    app.lock().submit(Command::Deposit { account: b.str("account")?, amount: b.dec("amount")? })?;
    ok(json!({ "ok": true }))
}

pub(super) async fn bots(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let mut node = app.lock();
    if node.intake.bots.is_none() {
        return Err(ExError::bad("bots are not running (BOTS=0)").into());
    }
    let enabled = b.truthy("enabled");
    node.submit(Command::SetBots { enabled })?;
    ok(json!({ "enabled": enabled }))
}

pub(super) async fn status(State(app): State<App>, _: Admin) -> ApiResult {
    let node = app.lock();
    let bots = node.intake.bots.as_ref().map(|_| json!({ "enabled": node.core.x.bots_enabled, "accounts": Bots::summary(&node.core.x) }));
    ok(json!({ "bots": bots }))
}

/// The journal's position and the time each journaled command took (apply + journal commit), since the start.
pub(super) async fn stats(State(app): State<App>, _: Admin) -> ApiResult {
    let node = app.lock();
    let mut us: Vec<u64> = node.core.timings.iter().map(|d| d.as_micros() as u64).collect();
    us.sort_unstable();
    let at = |q: f64| us.get(((us.len() as f64 - 1.0) * q).round() as usize).copied().unwrap_or(0);
    let mean = if us.is_empty() { 0 } else { us.iter().sum::<u64>() / us.len() as u64 };
    ok(json!({ "seq": node.core.seq, "n": us.len(), "p50_us": at(0.5), "p99_us": at(0.99), "max_us": us.last().copied().unwrap_or(0), "mean_us": mean }))
}
