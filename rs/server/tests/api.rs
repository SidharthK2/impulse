// HTTP and websocket API, ported from the TypeScript api.test.ts (archive/tests/http/).

mod common;
use common::*;
use serde_json::json;

/// A manual perp quoted 99 / 101 by a maker, and a signed-up trader.
async fn setup(v: &Venue) -> (String, User) {
    let s = uid();
    let x = format!("API{s}");
    ok(v.admin("POST", "/api/test/market", json!({ "id": x, "kind": "perp", "price": "100", "szDecimals": 2 })).await);
    let maker = v.user(&format!("mk{s}"), 100_000).await;
    ok(v.order(&maker, json!({ "market": x, "side": "sell", "price": "101", "size": "50" })).await);
    ok(v.order(&maker, json!({ "market": x, "side": "buy", "price": "99", "size": "50" })).await);
    let trader = v.user(&format!("tr{s}"), 10_000).await;
    (x, trader)
}

#[tokio::test]
async fn signs_up_with_a_paper_deposit_and_rejects_bad_or_taken_names() {
    let (v, _g) = shared();
    let s = uid();
    let (status, r) = v.post("/api/accounts", json!({ "name": format!("tr{s}") })).await;
    assert_eq!(status, 200);
    let trader = User { id: r["id"].as_str().unwrap().into(), key: r["apiKey"].as_str().unwrap().into() };
    assert_eq!(v.post("/api/accounts", json!({ "name": format!("TR{s}") })).await.0, 409);
    assert_eq!(v.post("/api/accounts", json!({ "name": "x" })).await.0, 400);
    assert_eq!(v.account(&trader).await["wallet"], "10000.00");
}

#[tokio::test]
async fn requires_auth_to_trade_and_admin_token_for_admin() {
    let (v, _g) = shared();
    let (x, _) = setup(&v).await;
    assert_eq!(v.get("/api/account").await.0, 401);
    assert_eq!(v.post("/api/admin/price", json!({ "market": x, "price": "50" })).await.0, 403);
    assert_eq!(v.get("/api/nope").await.0, 404);
}

#[tokio::test]
async fn trades_reports_fills_in_coins_and_closes() {
    let (v, _g) = shared();
    let (x, trader) = setup(&v).await;
    let r = ok(v.order(&trader, json!({ "market": x, "side": "buy", "type": "market", "size": "2.5", "leverage": 2 })).await);
    assert_eq!(r["status"], "filled");
    assert_eq!((&r["fills"][0]["price"], &r["fills"][0]["size"]), (&json!("101"), &json!("2.5")));
    fails(v.order(&trader, json!({ "market": x, "side": "buy", "type": "limit", "price": "100.001", "size": "1" })).await, "tick");
    let acct = v.account(&trader).await;
    assert_eq!((&acct["positions"][0]["size"], &acct["positions"][0]["side"]), (&json!("2.5"), &json!("long")));
    let close = ok(v.as_(&trader, "POST", "/api/positions/close", json!({ "market": x })).await);
    assert_eq!(close["status"], "filled");
}

#[tokio::test]
async fn lets_the_admin_force_a_gap_and_lists_it_in_the_feed() {
    let (v, _g) = shared();
    let (x, _) = setup(&v).await;
    ok(v.admin("POST", "/api/admin/price", json!({ "market": x, "price": "90", "holdSeconds": 0 })).await);
    let feed = ok(v.get(&format!("/api/feed?market={x}")).await);
    assert!(feed.as_array().unwrap().iter().any(|e| e["kind"] == "gap"));
}

#[tokio::test]
async fn lists_attention_markets_permissionlessly() {
    let (v, _g) = shared();
    let (_, trader) = setup(&v).await;
    let s = uid();
    let r = ok(v.as_(&trader, "POST", "/api/attention", json!({ "handle": format!("t{s}"), "oracleWindow": 0 })).await);
    assert_eq!(r["id"], format!("@t{s}"));
    assert_eq!(v.as_(&trader, "POST", "/api/attention", json!({ "handle": format!("t{s}") })).await.0, 409);
}

#[tokio::test]
async fn websocket_streams_subscribed_channels_and_the_authed_account() {
    let (v, _g) = shared();
    let (x, trader) = setup(&v).await;
    let book = format!("book:{x}");
    let mut msgs = vec![json!({ "op": "auth", "key": trader.key })];
    for ch in ["markets", book.as_str(), "account"] {
        msgs.push(json!({ "op": "sub", "ch": ch }));
    }
    let got = ws_collect(&v.ws_url(), &msgs, |g| g.contains_key("markets") && g.contains_key(&book) && g.get("account").is_some_and(|a| a["id"] == trader.id)).await;
    assert!(!got[&book]["asks"].as_array().unwrap().is_empty());
}
