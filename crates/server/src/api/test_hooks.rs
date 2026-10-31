// Test hooks (TEST_CLOCK=1): a clock only tests move, and views into the node.

use super::*;

pub(super) async fn advance(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let mut node = app.lock();
    node.intake.clock.advance(b.num("ms").unwrap_or(0.0) as i64);
    let r = node.submit(Command::Clock)?;
    ok(json!({ "effects": effects_of(r), "now": node.intake.clock.now(), "seq": node.core.seq }))
}

pub(super) async fn market(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let source = match b.0.get("source") {
        Some(v) => serde_json::from_value::<Source>(v.clone()).map_err(|e| ExError::bad(format!("source: {e}")))?,
        None => Source::Manual,
    };
    let spec = MarketSpec {
        price: b.opt_str("price").map(|p| crate::money::Dec::parse(&p)).transpose().map_err(ExError::bad)?,
        sz_decimals: b.num("szDecimals").map(|v| v as u32),
        oracle_window: b.num("oracleWindow"),
        fee_bps: b.num("feeBps"),
        adl: b.opt_str("adl"),
        snipe_seconds: b.num("snipeSeconds").map(|v| v as i64),
        ..MarketSpec::new(b.str("id")?, parse_kind(&b.str("kind")?)?, source)
    };
    list(&app, spec)
}

pub(super) async fn tick(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let tick = Tick { market: b.str("market")?, price: crate::units::parse_fixed(&b.str("price")?).map_err(ExError::bad)? };
    let Reply::Tick(effects) = app.lock().submit(Command::Tick { tick })? else { unreachable!() };
    ok(json!({ "effects": effects.map(|e| kinds(&e)) }))
}

pub(super) async fn invariants(State(app): State<App>, _: Admin) -> ApiResult {
    ok(check_invariants(&app.lock().core.x.state))
}

pub(super) async fn hash(State(app): State<App>, _: Admin) -> ApiResult {
    let node = app.lock();
    ok(json!({ "hash": node.core.x.state_hash(), "seq": node.core.seq }))
}

/// Round-trip the whole exchange through a snapshot in place, then treat `downMs` as downtime.
pub(super) async fn reload(State(app): State<App>, _: Admin, b: Body) -> ApiResult {
    let down = b.num("downMs").unwrap_or(0.0) as i64;
    let mut node = app.lock();
    node.intake.clock.advance(down);
    let Reply::Reload { identical, effects } = node.submit(Command::TestReload { down_ms: down })? else { unreachable!() };
    ok(json!({ "identical": identical, "effects": kinds(&effects) }))
}
