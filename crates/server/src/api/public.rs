// Public reads (markets, books, candles, the risk feed, the leaderboard) and sign-up.

use super::*;

pub(super) async fn health(State(app): State<App>) -> ApiResult {
    let node = app.lock();
    ok(json!({ "ok": true, "version": node.core.x.version, "time": node.core.x.now(), "engineTime": node.core.x.state.time as i64 }))
}

pub(super) async fn config(State(app): State<App>) -> ApiResult {
    ok(views::config_view(&app.lock().core.x))
}

pub(super) async fn markets(State(app): State<App>) -> ApiResult {
    ok(views::markets_view(&app.lock().core.x))
}

pub(super) async fn market(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let node = app.lock();
    node.core.x.market(&id)?;
    ok(json!({ "market": views::market_view(&node.core.x, &id), "book": views::book_view(&node.core.x, &id, 20), "trades": views::trades_view(&node.core.x, &id, 60) }))
}

pub(super) async fn candles(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let node = app.lock();
    node.core.x.market(&id)?;
    ok(views::candles_view(&node.core.x, &id))
}

pub(super) async fn positions(State(app): State<App>, Path(id): Path<String>) -> ApiResult {
    let node = app.lock();
    node.core.x.market(&id)?;
    ok(views::public_positions(&node.core.x, &id))
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

pub(super) async fn feed(State(app): State<App>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let node = app.lock();
    let market = q.get("market").filter(|m| !m.is_empty());
    if let (Some((before, limit)), Some(store)) = (page(&q), node.core.store()) {
        return ok(store.risk_page(market.map(String::as_str), before, limit).map_err(ExError::Internal)?);
    }
    let mut rows: Vec<_> = node.core.x.risk.iter().filter(|r| market.is_none_or(|m| *m == r.market)).collect();
    rows = rows.split_off(rows.len().saturating_sub(200));
    rows.reverse();
    ok(rows)
}

/// A market's trades, newest first: the latest 60 from memory, or pages of the full history (`before`, `limit`).
pub(super) async fn trades(State(app): State<App>, Path(id): Path<String>, Query(q): Query<HashMap<String, String>>) -> ApiResult {
    let node = app.lock();
    node.core.x.market(&id)?;
    if let (Some((before, limit)), Some(store)) = (page(&q), node.core.store()) {
        return ok(store.fills_page(&id, before, limit).map_err(ExError::Internal)?);
    }
    ok(views::trades_view(&node.core.x, &id, 60))
}

pub(super) async fn leaderboard(State(app): State<App>) -> ApiResult {
    ok(views::leaderboard_view(&app.lock().core.x))
}

#[derive(Deserialize)]
pub(super) struct SignupReq {
    name: String,
}

pub(super) async fn signup(State(app): State<App>, Body(b): Body<SignupReq>) -> ApiResult {
    let meta = app.lock().submit(Signup { name: b.name, api_key: api_key() })?;
    log(&format!("new account {}", meta.id));
    ok(json!({ "id": meta.id, "apiKey": meta.api_key }))
}
