// Pre-IPO markets through the API, ported from the TypeScript preipo.test.ts (impulse-research: tests/http/): the mark is the
// market's own book until the admin IPO gaps it to a public price.

mod common;
use common::*;
use serde_json::{json, Value};

async fn mark(v: &Venue, id: &str) -> String {
    v.market(id).await["market"]["mark"].as_str().unwrap().into()
}

#[tokio::test]
async fn seeds_stripe_pre_at_91_50_on_its_own_order_book() {
    let (v, _g) = shared();
    let m = v.market("STRIPE-PRE").await["market"].clone();
    assert_eq!(m["kind"], "preipo");
    assert_eq!(m["source"], json!({ "kind": "book", "label": "own order book" }));
    assert_eq!(m["preipo"], json!({ "seedPrice": "91.5", "impliedValuation": "91500000000.00", "status": "private", "ipoAt": null, "ipoPrice": null }));
    assert_eq!(m["mark"], "91.5");
}

#[tokio::test]
async fn marks_to_median_of_best_bid_best_ask_and_last_trade_the_last_trade_with_a_side_empty_else_the_seed() {
    let (v, _g) = shared();
    let s = uid();
    let p = format!("PRE{s}");
    let created = ok(v.admin("POST", "/api/admin/preipo", json!({ "id": p, "name": "Test Co (pre-IPO)", "price": "50" })).await);
    assert_eq!(created["mark"], "50");
    let alice = v.user(&format!("al{s}"), 10_000).await;
    let bob = v.user(&format!("bo{s}"), 10_000).await;
    let carol = v.user(&format!("ca{s}"), 10_000).await;

    ok(v.order(&alice, json!({ "market": p, "side": "buy", "price": "48", "size": "10" })).await);
    assert_eq!(mark(&v, &p).await, "50"); // one side, no trade yet: the seed
    ok(v.order(&bob, json!({ "market": p, "side": "sell", "price": "53", "size": "5" })).await);
    assert_eq!(mark(&v, &p).await, "50"); // median(48, 53, seed 50)
    assert_eq!(ok(v.order(&carol, json!({ "market": p, "side": "buy", "price": "53", "size": "5" })).await)["status"], "filled");
    assert_eq!(mark(&v, &p).await, "53"); // the ask is gone: last trade
    ok(v.order(&bob, json!({ "market": p, "side": "sell", "price": "60", "size": "1" })).await);
    assert_eq!(mark(&v, &p).await, "53"); // median(48, 60, 53)
    let bid = ok(v.order(&alice, json!({ "market": p, "side": "buy", "price": "55", "size": "1" })).await);
    assert_eq!(mark(&v, &p).await, "55"); // median(55, 60, 53)
    ok(v.as_(&alice, "DELETE", &format!("/api/orders/{}", bid["order"]["id"]), Value::Null).await);
    assert_eq!(mark(&v, &p).await, "53"); // the cancel moved it back
    assert_eq!(v.invariants().await, Vec::<Value>::new());
}

#[tokio::test]
async fn an_ipo_gaps_the_mark_to_the_public_price_and_charges_the_shortfall_to_the_other_side() {
    let (v, _g) = shared();
    let s = uid();
    let p = format!("IPO{s}");
    ok(v.admin("POST", "/api/admin/preipo", json!({ "id": p, "name": "Gap Co (pre-IPO)", "price": "100", "description": "test" })).await);
    let alice = v.user(&format!("al{s}"), 10_000).await;
    let bob = v.user(&format!("bo{s}"), 10_000).await;
    let carol = v.user(&format!("ca{s}"), 10_000).await;
    ok(v.order(&alice, json!({ "market": p, "side": "buy", "price": "100", "size": "20", "leverage": 3 })).await); // $2,000 long at 3×: $666.67
    ok(v.order(&bob, json!({ "market": p, "side": "sell", "price": "100", "size": "10" })).await);
    ok(v.order(&carol, json!({ "market": p, "side": "sell", "price": "100", "size": "10" })).await);
    assert_eq!(mark(&v, &p).await, "100");

    assert_eq!(v.admin("POST", "/api/admin/price", json!({ "market": p, "price": "80" })).await.0, 400); // book-priced until the IPO
    let effects = ok(v.admin("POST", "/api/admin/ipo", json!({ "market": p, "price": "50" })).await)["effects"].clone();
    assert!(effects.as_array().unwrap().contains(&json!("bankrupt")) && effects.as_array().unwrap().contains(&json!("haircut")));
    let m = v.market(&p).await["market"].clone();
    assert_eq!(m["mark"], "50");
    assert_eq!(m["source"], json!({ "kind": "manual", "label": "admin-set public price" }));
    assert_eq!((&m["preipo"]["status"], &m["preipo"]["ipoPrice"], &m["preipo"]["impliedValuation"]), (&json!("public"), &json!("50"), &json!("50000000000.00")));
    assert!(m["preipo"]["ipoAt"].is_number());

    // alice loses her $666.67; the $333.33 shortfall comes out of bob's and carol's profit, and the feed says so
    let feed = ok(v.get(&format!("/api/feed?market={p}")).await);
    let rows = feed.as_array().unwrap();
    let ipo = rows.iter().find(|r| r["kind"] == "ipo").unwrap();
    assert_eq!((&ipo["amount"], &ipo["price"]), (&json!("333.333333333"), &json!("50")));
    let sorted = |v: &Value| {
        let mut a: Vec<String> = v.as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        a.sort();
        a
    };
    let mut hit = vec![alice.id.clone(), bob.id.clone(), carol.id.clone()];
    hit.sort();
    assert_eq!(sorted(&ipo["accounts"]), hit);
    let haircuts: Vec<&Value> = rows.iter().filter(|r| r["kind"] == "haircut").collect();
    let mut payers: Vec<String> = haircuts.iter().map(|r| r["accounts"][0].as_str().unwrap().to_string()).collect();
    payers.sort();
    let mut want = vec![bob.id.clone(), carol.id.clone()];
    want.sort();
    assert_eq!(payers, want);
    assert!(haircuts.iter().all(|r| r["price"] == "50"));
    assert_eq!(v.account(&bob).await["ledger"]["adlPaid"], "166.666666667");
    assert_eq!(v.invariants().await, Vec::<Value>::new());

    assert_eq!(v.admin("POST", "/api/admin/ipo", json!({ "market": p, "price": "60" })).await.0, 400); // once only
    ok(v.admin("POST", "/api/admin/price", json!({ "market": p, "price": "55", "holdSeconds": 0 })).await); // an ordinary admin-priced perp now
    assert_eq!(mark(&v, &p).await, "55");
}
