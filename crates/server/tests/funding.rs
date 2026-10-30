// Funding after an oracle gap, ported from the TypeScript funding.test.ts (impulse-research: tests/http/): the premium reads
// the order book's mid, so once the book is re-quoted around the new mark, funding stays near the base rate
// instead of riding a stale last trade to its cap.

mod common;
use common::*;
use serde_json::{json, Value};

const BASE: f64 = 0.0005; // 0.05%/h at tier 0
const NEAR: f64 = 0.0002; // premium allowance: a mid within a 0.2% spread of the mark gives at most 0.025%/h

async fn funding(v: &Venue, id: &str) -> f64 {
    v.market(id).await["market"]["funding"]["ratePerHour"].as_f64().unwrap()
}

/// Two-sided quotes 0.1% either side of `mid`.
async fn quote(v: &Venue, maker: &User, market: &str, mid: f64) {
    ok(v.as_(maker, "POST", "/api/orders/cancel-all", json!({ "market": market })).await);
    ok(v.order(maker, json!({ "market": market, "side": "buy", "price": format!("{:.3}", mid * 0.999), "size": "10" })).await);
    ok(v.order(maker, json!({ "market": market, "side": "sell", "price": format!("{:.3}", mid * 1.001), "size": "10" })).await);
}

async fn traded(v: &Venue, market: &str, s: &str) -> User {
    let maker = v.user(&format!("mk{s}"), 100_000).await;
    let taker = v.user(&format!("tk{s}"), 100_000).await;
    quote(v, &maker, market, 100.0).await;
    ok(v.order(&taker, json!({ "market": market, "side": "buy", "type": "market", "size": "1", "leverage": 1 })).await); // last trade 100.1
    v.advance(2000).await;
    assert!((funding(v, market).await - BASE).abs() < NEAR); // before the gap: mid 100, mark 100
    maker
}

#[tokio::test]
async fn stays_near_the_base_rate_after_a_50pct_crash_once_the_book_is_re_quoted() {
    let (v, _g) = shared();
    let s = uid();
    let x = format!("F{s}");
    ok(v.admin("POST", "/api/test/market", json!({ "id": x, "kind": "perp", "price": "100", "szDecimals": 2 })).await);
    let maker = traded(&v, &x, &s).await;
    ok(v.admin("POST", "/api/admin/price", json!({ "market": x, "price": "50", "holdSeconds": 0 })).await);
    quote(&v, &maker, &x, 50.0).await;
    v.advance(2000).await;
    let rate = funding(&v, &x).await;
    assert!((rate - BASE).abs() < NEAR, "{rate}"); // the last trade (100.1) would have pinned it at 4.05%/h
    assert_eq!(v.invariants().await, Vec::<Value>::new());
}

#[tokio::test]
async fn stays_near_the_base_rate_after_an_ipo_gap_once_the_book_is_re_quoted() {
    let (v, _g) = shared();
    let s = uid();
    let p = format!("G{s}");
    ok(v.admin("POST", "/api/admin/preipo", json!({ "id": p, "name": "Funding Co (pre-IPO)", "price": "100" })).await);
    let maker = traded(&v, &p, &s).await;
    ok(v.admin("POST", "/api/admin/ipo", json!({ "market": p, "price": "50" })).await);
    quote(&v, &maker, &p, 50.0).await;
    v.advance(2000).await;
    let rate = funding(&v, &p).await;
    assert!((rate - BASE).abs() < NEAR, "{rate}");
    assert_eq!(v.invariants().await, Vec::<Value>::new());
}
