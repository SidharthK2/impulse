// Endpoints the ported suites didn't cover: faucet limits, order ownership, margin, spot sells, malformed
// requests and CORS, the static fallback, config, leaderboard and candles.

mod common;
use common::*;
use serde_json::{json, Value};

async fn perp(v: &Venue) -> (String, String) {
    let s = uid();
    let x = format!("E{s}");
    ok(v.admin("POST", "/api/test/market", json!({ "id": x, "kind": "perp", "price": "100", "szDecimals": 2 })).await);
    (x, s)
}

#[tokio::test]
async fn the_faucet_pays_once_a_minute_up_to_a_100k_wallet() {
    let (v, _g) = shared();
    let u = v.user(&format!("fa{}", uid()), 10_000).await; // sign-up used the faucet
    let (status, r) = v.as_(&u, "POST", "/api/faucet", json!({})).await;
    assert_eq!(status, 429, "{r}");
    v.advance(60_001).await;
    assert_eq!(ok(v.as_(&u, "POST", "/api/faucet", json!({})).await)["amount"], "10000.00");
    assert_eq!(v.account(&u).await["wallet"], "20000.00");
    ok(v.admin("POST", "/api/admin/deposit", json!({ "account": u.id, "amount": "80000" })).await);
    v.advance(60_001).await;
    fails(v.as_(&u, "POST", "/api/faucet", json!({})).await, "faucet stops");
}

#[tokio::test]
async fn cancels_only_your_own_orders() {
    let (v, _g) = shared();
    let (x, s) = perp(&v).await;
    let alice = v.user(&format!("al{s}"), 10_000).await;
    let bob = v.user(&format!("bo{s}"), 10_000).await;
    let id = ok(v.order(&alice, json!({ "market": x, "side": "buy", "price": "90", "size": "1" })).await)["order"]["id"].clone();
    assert_eq!(v.as_(&bob, "DELETE", &format!("/api/orders/{id}"), Value::Null).await.0, 404);
    ok(v.as_(&alice, "DELETE", &format!("/api/orders/{id}"), Value::Null).await);
    assert_eq!(v.as_(&alice, "DELETE", &format!("/api/orders/{id}"), Value::Null).await.0, 404);
    assert_eq!(v.account(&alice).await["orders"], json!([]));
}

#[tokio::test]
async fn adds_and_removes_isolated_margin_on_an_open_position() {
    let (v, _g) = shared();
    let (x, s) = perp(&v).await;
    let alice = v.user(&format!("al{s}"), 10_000).await;
    let bob = v.user(&format!("bo{s}"), 10_000).await;
    fails(v.as_(&alice, "POST", "/api/margin", json!({ "market": x, "amount": "50" })).await, "no open position");
    ok(v.order(&bob, json!({ "market": x, "side": "sell", "price": "100", "size": "10" })).await);
    ok(v.order(&alice, json!({ "market": x, "side": "buy", "type": "market", "size": "10", "leverage": 2 })).await);
    let collateral = |a: Value| nano(a["positions"][0]["collateral"].as_str().unwrap());
    let before = collateral(v.account(&alice).await);
    ok(v.as_(&alice, "POST", "/api/margin", json!({ "market": x, "amount": "50" })).await);
    assert_eq!(collateral(v.account(&alice).await), before + nano("50"));
    ok(v.as_(&alice, "POST", "/api/margin", json!({ "market": x, "amount": "-50" })).await);
    assert_eq!(collateral(v.account(&alice).await), before);
    fails(v.as_(&alice, "POST", "/api/margin", json!({ "market": x, "amount": "0" })).await, "non-zero");
    assert_eq!(v.invariants().await, Vec::<Value>::new());
}

#[tokio::test]
async fn sells_spot_tokens_back_to_the_curve() {
    let (v, _g) = shared();
    let s = uid();
    let c = format!("@sp{s}");
    ok(v.admin("POST", "/api/test/market", json!({ "id": c, "kind": "attention", "source": { "kind": "curve" } })).await);
    let u = v.user(&format!("sp{s}"), 1000).await;
    ok(v.as_(&u, "POST", "/api/spot/buy", json!({ "market": c, "usdc": "100" })).await);
    assert_eq!(v.account(&u).await["spot"].as_array().unwrap().len(), 1);
    fails(v.as_(&u, "POST", "/api/spot/sell", json!({ "market": c, "tokens": "1.5" })).await, "whole number");
    ok(v.as_(&u, "POST", "/api/spot/sell", json!({ "market": c, "tokens": "all" })).await);
    let acct = v.account(&u).await;
    let w = num(&acct["wallet"]);
    assert!(w < 1000.0 && w > 997.0, "{w}"); // two 1% fees on $100, plus rounding in the curve's favour
    assert_eq!(acct["spot"], json!([]));
    assert_eq!(v.invariants().await, Vec::<Value>::new());
}

#[tokio::test]
async fn refuses_malformed_bodies_and_answers_cors_preflights() {
    let (v, _g) = shared();
    let http = reqwest::Client::new();
    let bad = http.post(format!("{}/api/accounts", v.base)).header("content-type", "application/json").body("{").send().await.unwrap();
    assert_eq!(bad.status().as_u16(), 400);
    assert_eq!(bad.json::<Value>().await.unwrap()["error"], "body must be JSON");
    let big = http.post(format!("{}/api/accounts", v.base)).body(vec![b' '; 70 * 1024]).send().await.unwrap();
    assert_eq!(big.status().as_u16(), 413);
    let pre = http.request(reqwest::Method::OPTIONS, format!("{}/api/orders", v.base)).send().await.unwrap();
    assert_eq!(pre.status().as_u16(), 204);
    assert_eq!(pre.headers()["access-control-allow-headers"], "content-type,authorization,x-admin-token");
    let health = http.get(format!("{}/api/health", v.base)).send().await.unwrap();
    assert_eq!(health.headers()["access-control-allow-origin"], "*");
}

#[tokio::test]
async fn serves_a_plain_text_page_when_the_web_app_isnt_built() {
    let (v, _g) = shared();
    let res = reqwest::get(format!("{}/some/page", v.base)).await.unwrap();
    assert_eq!(res.status().as_u16(), 200);
    assert_eq!(res.headers()["content-type"], "text/plain");
    assert!(res.text().await.unwrap().contains("Impulse API is running"));
}

#[tokio::test]
async fn reports_config_and_ranks_the_leaderboard_by_pnl() {
    let (v, _g) = shared();
    let config = ok(v.get("/api/config").await);
    assert_eq!(config["graduation"].as_array().unwrap().len(), 5);
    assert_eq!(config["fundingBasePerHour"].as_array().unwrap().len(), 6);
    assert_eq!(config["graduation"][0], json!({ "leverage": 5, "volume": "100000.00", "depth": "10000.00" }));
    let (x, s) = perp(&v).await;
    let alice = v.user(&format!("al{s}"), 10_000).await;
    let bob = v.user(&format!("bo{s}"), 10_000).await;
    ok(v.order(&bob, json!({ "market": x, "side": "sell", "price": "100", "size": "10" })).await);
    ok(v.order(&alice, json!({ "market": x, "side": "buy", "type": "market", "size": "10" })).await);
    ok(v.admin("POST", "/api/admin/price", json!({ "market": x, "price": "110", "holdSeconds": 0 })).await);
    let rows = ok(v.get("/api/leaderboard").await);
    let rows = rows.as_array().unwrap();
    let pnls: Vec<f64> = rows.iter().map(|r| num(&r["pnl"])).collect();
    assert!(pnls.windows(2).all(|w| w[0] >= w[1]), "not sorted: {pnls:?}");
    let at = |id: &str| rows.iter().position(|r| r["id"] == id).unwrap();
    assert!(at(&alice.id) < at(&bob.id));
}

#[tokio::test]
async fn builds_one_minute_candles_from_marks_and_trades() {
    let (v, _g) = shared();
    let (x, s) = perp(&v).await;
    let alice = v.user(&format!("al{s}"), 10_000).await;
    let bob = v.user(&format!("bo{s}"), 10_000).await;
    ok(v.order(&bob, json!({ "market": x, "side": "sell", "price": "100", "size": "1" })).await);
    ok(v.order(&alice, json!({ "market": x, "side": "buy", "type": "market", "size": "1" })).await);
    v.advance(60_000).await;
    ok(v.admin("POST", "/api/admin/price", json!({ "market": x, "price": "105", "holdSeconds": 0 })).await);
    let candles = ok(v.get(&format!("/api/markets/{x}/candles")).await);
    let cs = candles.as_array().unwrap();
    assert_eq!(cs.len(), 2, "{candles}");
    assert_eq!((cs[0]["c"].as_f64(), cs[0]["v"].as_f64()), (Some(100.0), Some(100.0)));
    assert_eq!((cs[1]["o"].as_f64(), cs[1]["c"].as_f64()), (Some(100.0), Some(105.0)));
    assert_eq!(cs[1]["t"].as_i64().unwrap() - cs[0]["t"].as_i64().unwrap(), 60_000);
}
