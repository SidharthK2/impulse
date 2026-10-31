// Test hooks (TEST_CLOCK=1): a clock only tests move, and views into the core.

use super::*;

#[derive(Deserialize)]
pub(super) struct AdvanceReq {
    #[serde(default, deserialize_with = "field::num")]
    ms: Option<f64>,
}

pub(super) async fn advance(State(app): State<App>, _: Admin, Body(b): Body<AdvanceReq>) -> ApiResult {
    let mut node = app.lock();
    node.intake.clock.advance(b.ms.unwrap_or(0.0) as i64);
    let r = node.submit(Clock {})?;
    ok(json!({ "effects": kinds(&r), "now": node.intake.clock.now(), "seq": node.core.seq }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct TestMarketReq {
    id: String,
    kind: Kind,
    source: Option<Source>,
    #[serde(default, deserialize_with = "field::dec")]
    price: Option<Dec>,
    #[serde(default, deserialize_with = "field::num")]
    sz_decimals: Option<f64>,
    #[serde(default, deserialize_with = "field::num")]
    oracle_window: Option<f64>,
    #[serde(default, deserialize_with = "field::num")]
    fee_bps: Option<f64>,
    #[serde(default, deserialize_with = "field::text")]
    adl: Option<String>,
    #[serde(default, deserialize_with = "field::num")]
    snipe_seconds: Option<f64>,
}

pub(super) async fn market(State(app): State<App>, _: Admin, Body(b): Body<TestMarketReq>) -> ApiResult {
    let spec = MarketSpec {
        price: b.price,
        sz_decimals: b.sz_decimals.map(|v| v as u32),
        oracle_window: b.oracle_window,
        fee_bps: b.fee_bps,
        adl: b.adl,
        snipe_seconds: b.snipe_seconds.map(|v| v as i64),
        ..MarketSpec::new(b.id, b.kind, b.source.unwrap_or(Source::Manual))
    };
    list(&app, spec)
}

#[derive(Deserialize)]
pub(super) struct TickReq {
    market: String,
    price: Dec,
}

pub(super) async fn tick(State(app): State<App>, _: Admin, Body(b): Body<TickReq>) -> ApiResult {
    let effects = app.lock().submit(FeedTick { tick: Tick { market: b.market, price: b.price.nano() } })?;
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
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReloadReq {
    #[serde(default, deserialize_with = "field::num")]
    down_ms: Option<f64>,
}

pub(super) async fn reload(State(app): State<App>, _: Admin, Body(b): Body<ReloadReq>) -> ApiResult {
    let down = b.down_ms.unwrap_or(0.0) as i64;
    let mut node = app.lock();
    node.intake.clock.advance(down);
    let Reloaded { identical, effects } = node.submit(TestReload { down_ms: down })?;
    ok(json!({ "identical": identical, "effects": kinds(&effects) }))
}
