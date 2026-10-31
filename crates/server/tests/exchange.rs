// Matching, margin, risk and persistence through the HTTP API, ported from the TypeScript exchange.test.ts
// (impulse-research: tests/http/). Each test gets its own market and accounts.

mod common;
use common::*;
use serde_json::{json, Value};

struct Setup {
    x: String,
    s: String,
    alice: User,
    bob: User,
    carol: User,
}

/// A manual-oracle perp at $100 (0.01-coin lots) and three accounts with $1,000 each.
async fn setup(v: &Venue) -> Setup {
    setup_with(v, json!({})).await
}

/// No trading fees: for tests whose exact numbers are about something else (ADL, settlement).
fn fee_free(mut spec: Value) -> Value {
    spec["takerFeePpm"] = json!(0);
    spec["makerFeePpm"] = json!(0);
    spec
}

/// A $100 perp (`extra` merged into its listing) and three users with $1,000 each.
async fn setup_with(v: &Venue, extra: Value) -> Setup {
    let s = uid();
    let x = format!("X{s}");
    let mut spec = json!({ "id": x, "kind": "perp", "price": "100", "szDecimals": 2 });
    for (k, val) in extra.as_object().unwrap() {
        spec[k] = val.clone();
    }
    ok(v.admin("POST", "/api/test/market", spec).await);
    let alice = v.user(&format!("al{s}"), 1000).await;
    let bob = v.user(&format!("bo{s}"), 1000).await;
    let carol = v.user(&format!("ca{s}"), 1000).await;
    Setup {
        x,
        s,
        alice,
        bob,
        carol,
    }
}

async fn wallet(v: &Venue, u: &User) -> String {
    v.account(u).await["wallet"].as_str().unwrap().into()
}

async fn position(v: &Venue, u: &User, market: &str) -> Option<Value> {
    v.account(u).await["positions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["market"] == market)
        .cloned()
}

async fn size(v: &Venue, u: &User, market: &str) -> String {
    position(v, u, market)
        .await
        .map_or("0".into(), |p| p["size"].as_str().unwrap().to_string())
}

async fn collateral(v: &Venue, u: &User, market: &str) -> Option<String> {
    let rows = ok(v
        .get(&format!("/api/markets/{}/positions", encode(market)))
        .await);
    rows.as_array()
        .unwrap()
        .iter()
        .find(|p| p["account"] == u.id.as_str())
        .map(|p| p["collateral"].as_str().unwrap().to_string())
}

async fn book(v: &Venue, market: &str) -> Value {
    v.market(market).await["book"].clone()
}

/// Everything the venue holds equals deposits minus withdrawals (the engine asserts it; double-check here).
async fn conserved(v: &Venue) {
    assert_eq!(v.invariants().await, Vec::<Value>::new());
}

#[tokio::test]
async fn fills_a_market_order_against_resting_liquidity_with_auto_margin() {
    let (v, _g) = shared().await;
    let Setup { x, alice, bob, .. } = setup(&v).await;
    let rest = ok(v
        .order(
            &bob,
            json!({ "market": x, "side": "sell", "price": "100", "size": "10" }),
        )
        .await);
    assert_eq!(rest["status"], "resting");
    let r = ok(v
        .order(
            &alice,
            json!({ "market": x, "side": "buy", "type": "market", "size": "4", "leverage": 2 }),
        )
        .await);
    assert_eq!(r["status"], "filled");
    assert_eq!(r["fills"].as_array().unwrap().len(), 1);
    assert_eq!(size(&v, &alice, &x).await, "4");
    assert_eq!(size(&v, &bob, &x).await, "-4");
    // alice posted $400 / 2× = $200, plus her 0.045% taker fee ($0.18). bob's resting order defaults to the market
    // max (3×): $133.34, plus his 0.015% maker fee ($0.06), which leaves the bucket again as it's paid.
    assert_eq!(wallet(&v, &alice).await, "799.82");
    let mine = &v.account(&alice).await["fills"][0];
    assert_eq!(
        (&mine["liquidity"], &mine["fee"]),
        (&json!("taker"), &json!("0.18"))
    );
    assert_eq!(v.account(&bob).await["fills"][0]["fee"], "0.06");
    assert_eq!(position(&v, &alice, &x).await.unwrap()["fees"], "0.18");
    assert_eq!(
        collateral(&v, &bob, &x).await.as_deref(),
        Some("133.333333334")
    );
    assert_eq!(
        book(&v, &x).await["asks"],
        json!([{ "price": "100", "size": "6", "orders": 1 }])
    );
    conserved(&v).await;
}

#[tokio::test]
async fn walks_the_book_and_rests_the_remainder_of_a_limit_order() {
    let (v, _g) = shared().await;
    let Setup {
        x,
        alice,
        bob,
        carol,
        ..
    } = setup(&v).await;
    ok(v.order(
        &bob,
        json!({ "market": x, "side": "sell", "price": "100", "size": "1" }),
    )
    .await);
    ok(v.order(
        &carol,
        json!({ "market": x, "side": "sell", "price": "101", "size": "1" }),
    )
    .await);
    let r = ok(v
        .order(
            &alice,
            json!({ "market": x, "side": "buy", "price": "101", "size": "3" }),
        )
        .await);
    assert_eq!(r["status"], "partial");
    let prices: Vec<&Value> = r["fills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| &f["price"])
        .collect();
    assert_eq!(prices, [&json!("100"), &json!("101")]);
    assert_eq!(
        book(&v, &x).await["bids"],
        json!([{ "price": "101", "size": "1", "orders": 1 }])
    );
}

#[tokio::test]
async fn rejects_off_tick_prices_post_only_crosses_and_unaffordable_orders() {
    let (v, _g) = shared().await;
    let Setup { x, alice, bob, .. } = setup(&v).await;
    ok(v.order(
        &bob,
        json!({ "market": x, "side": "sell", "price": "100", "size": "1" }),
    )
    .await);
    fails(
        v.order(
            &alice,
            json!({ "market": x, "side": "buy", "price": "100.0001", "size": "1" }),
        )
        .await,
        "tick",
    );
    fails(
        v.order(
            &alice,
            json!({ "market": x, "side": "buy", "price": "100", "size": "1", "tif": "alo" }),
        )
        .await,
        "post-only",
    );
    assert_eq!(
        ok(v.order(
            &alice,
            json!({ "market": x, "side": "buy", "price": "99", "size": "1", "tif": "alo" })
        )
        .await)["status"],
        "resting"
    );
    fails(
        v.order(
            &alice,
            json!({ "market": x, "side": "buy", "price": "99", "size": "100", "leverage": 1 }),
        )
        .await,
        "insufficient",
    );
}

#[tokio::test]
async fn cancels_the_resting_side_on_a_self_trade_and_a_maker_that_cant_afford_its_fill() {
    let (v, _g) = shared().await;
    let Setup { x, alice, bob, .. } = setup(&v).await;
    ok(v.order(
        &alice,
        json!({ "market": x, "side": "sell", "price": "100", "size": "1" }),
    )
    .await);
    let selfie = ok(v
        .order(
            &alice,
            json!({ "market": x, "side": "buy", "price": "100", "size": "1" }),
        )
        .await);
    assert_eq!(selfie["fills"].as_array().unwrap().len(), 0);
    assert_eq!(book(&v, &x).await["asks"], json!([]));
    assert_eq!(selfie["status"], "resting");

    ok(v.as_(&alice, "POST", "/api/orders/cancel-all", json!({}))
        .await);
    ok(v.order(
        &bob,
        json!({ "market": x, "side": "sell", "price": "100", "size": "25", "leverage": 3 }),
    )
    .await); // needs ~$834
    ok(
        v.as_(&bob, "POST", "/api/withdraw", json!({ "amount": "900" }))
            .await,
    ); // now bob can't post it
    let r = ok(v
        .order(
            &alice,
            json!({ "market": x, "side": "buy", "type": "market", "size": "25" }),
        )
        .await);
    assert_eq!(r["status"], "cancelled");
    assert_eq!(r["fills"].as_array().unwrap().len(), 0);
    assert_eq!(v.account(&bob).await["orders"], json!([])); // the maker that couldn't post margin lost its order
    assert_eq!(wallet(&v, &bob).await, "100.00"); // and its failed allocation never committed
}

#[tokio::test]
async fn closes_with_reduce_only_and_returns_collateral_to_the_wallet() {
    let (v, _g) = shared().await;
    let Setup {
        x,
        alice,
        bob,
        carol,
        ..
    } = setup(&v).await;
    ok(v.order(
        &bob,
        json!({ "market": x, "side": "sell", "price": "100", "size": "5" }),
    )
    .await);
    ok(v.order(
        &alice,
        json!({ "market": x, "side": "buy", "type": "market", "size": "2" }),
    )
    .await);
    fails(v.order(&alice, json!({ "market": x, "side": "buy", "type": "market", "size": "1", "reduceOnly": true })).await, "reduce");
    ok(v.order(
        &carol,
        json!({ "market": x, "side": "buy", "price": "100", "size": "5" }),
    )
    .await);
    let r = ok(v.order(&alice, json!({ "market": x, "side": "sell", "type": "market", "size": "9", "reduceOnly": true })).await);
    let filled: f64 = r["fills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| num(&f["size"]))
        .sum();
    assert_eq!(filled, 2.0); // capped at the position
    assert_eq!(size(&v, &alice, &x).await, "0");
    assert_eq!(collateral(&v, &alice, &x).await, None); // flat, and the bucket is empty
    assert_eq!(wallet(&v, &alice).await, "999.82"); // $200 in and out at $100, less 0.045% each way
    conserved(&v).await;
}

#[tokio::test]
async fn a_gap_bankrupts_the_long_charges_the_shorts_and_records_who_paid() {
    let (v, _g) = shared().await;
    let Setup {
        x,
        alice,
        bob,
        carol,
        ..
    } = setup_with(&v, fee_free(json!({}))).await;
    ok(v.order(
        &bob,
        json!({ "market": x, "side": "sell", "price": "100", "size": "10" }),
    )
    .await);
    ok(v.order(
        &carol,
        json!({ "market": x, "side": "sell", "price": "100", "size": "10" }),
    )
    .await);
    ok(v.order(
        &alice,
        json!({ "market": x, "side": "buy", "type": "market", "size": "20", "leverage": 3 }),
    )
    .await); // $2,000 at 3×: $666.67
    ok(v.order(
        &alice,
        json!({ "market": x, "side": "buy", "price": "90", "size": "1" }),
    )
    .await); // resting order, cancelled on bankruptcy

    let effects = ok(v
        .admin(
            "POST",
            "/api/admin/price",
            json!({ "market": x, "price": "50", "holdSeconds": 0 }),
        )
        .await)["effects"]
        .clone();
    assert!(effects.as_array().unwrap().contains(&json!("bankrupt")));
    assert!(effects.as_array().unwrap().contains(&json!("haircut")));
    assert_eq!(size(&v, &alice, &x).await, "0");
    assert_eq!(size(&v, &bob, &x).await, "0");
    assert_eq!(v.account(&alice).await["orders"], json!([]));

    // alice loses her $666.67 bucket; the $333.33 shortfall comes out of the shorts' $1,000 profit
    let feed = ok(v.get(&format!("/api/feed?market={x}")).await);
    let kinds: Vec<&str> = feed
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["kind"].as_str().unwrap())
        .collect();
    for k in ["bankrupt", "haircut", "adl", "gap"] {
        assert!(kinds.contains(&k), "no {k} in {kinds:?}");
    }
    assert_eq!(
        feed.as_array()
            .unwrap()
            .iter()
            .find(|r| r["kind"] == "bankrupt")
            .unwrap()["amount"],
        "333.333333333"
    );
    let risk = v.account(&bob).await["risk"].clone();
    let bob_kinds: Vec<&str> = risk
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["kind"].as_str().unwrap())
        .collect();
    assert!(bob_kinds.contains(&"haircut") && bob_kinds.contains(&"adl"));
    // Everyone is flat, so all collateral is back in wallets and conservation is exact.
    let mut total = 0;
    for u in [&alice, &bob, &carol] {
        total += nano(&wallet(&v, u).await);
    }
    assert_eq!(total, nano("3000"));
    conserved(&v).await;
}

#[tokio::test]
async fn holds_the_feed_during_an_admin_override_then_lets_it_back_in() {
    let (v, _g) = shared().await;
    let Setup { x, .. } = setup(&v).await;
    ok(v.admin(
        "POST",
        "/api/admin/price",
        json!({ "market": x, "price": "120", "holdSeconds": 30 }),
    )
    .await);
    assert_eq!(
        ok(v.admin(
            "POST",
            "/api/test/tick",
            json!({ "market": x, "price": "100" })
        )
        .await)["effects"],
        Value::Null
    );
    assert_eq!(v.market(&x).await["market"]["mark"], "120");
    v.advance(31_000).await;
    ok(v.admin(
        "POST",
        "/api/test/tick",
        json!({ "market": x, "price": "100" }),
    )
    .await);
    assert_eq!(v.market(&x).await["market"]["mark"], "100");
}

#[tokio::test]
async fn the_clock_accrues_funding_and_an_attention_curve_moves_its_own_mark() {
    let (v, _g) = shared().await;
    let Setup {
        x,
        s,
        alice,
        bob,
        carol,
    } = setup(&v).await;
    let p = format!("@p{s}");
    let m = ok(v
        .admin(
            "POST",
            "/api/test/market",
            json!({ "id": p, "kind": "attention", "source": { "kind": "curve" } }),
        )
        .await);
    assert_eq!(m["mark"], "0.000005");
    ok(v.as_(
        &carol,
        "POST",
        "/api/spot/buy",
        json!({ "market": p, "usdc": "500" }),
    )
    .await);
    let after = v.market(&p).await;
    assert!(num(&after["market"]["mark"]) > 0.000005);
    assert_eq!(after["trades"][0]["kind"], "spot");

    ok(v.order(
        &bob,
        json!({ "market": x, "side": "sell", "price": "100", "size": "5" }),
    )
    .await);
    ok(v.order(
        &alice,
        json!({ "market": x, "side": "buy", "type": "market", "size": "5" }),
    )
    .await);
    v.advance(3_600_000).await;
    assert!(num(&position(&v, &alice, &x).await.unwrap()["funding"]) < 0.0); // longs pay the launch base rate
    assert!(num(&position(&v, &bob, &x).await.unwrap()["funding"]) > 0.0);
    conserved(&v).await;
}

#[tokio::test]
async fn resolves_a_binary_and_settles_every_position() {
    let (v, _g) = shared().await;
    let Setup { s, alice, bob, .. } = setup(&v).await;
    let b = format!("B{s}");
    ok(v.admin(
        "POST",
        "/api/test/market",
        fee_free(json!({ "id": b, "kind": "binary", "price": "0.4" })),
    )
    .await);
    ok(v.order(
        &bob,
        json!({ "market": b, "side": "sell", "price": "0.4", "size": "100" }),
    )
    .await);
    ok(v.order(
        &alice,
        json!({ "market": b, "side": "buy", "type": "market", "size": "100", "leverage": 1 }),
    )
    .await);
    assert_eq!(collateral(&v, &alice, &b).await.as_deref(), Some("42.00")); // 1× on a long = its full max loss, plus a 5% buffer
    ok(v.admin(
        "POST",
        "/api/admin/resolve",
        json!({ "market": b, "price": "0" }),
    )
    .await);
    let after = v.market(&b).await;
    assert_eq!(after["market"]["status"], "resolved");
    assert_eq!(wallet(&v, &alice).await, "960.00"); // bought at 0.40, settled at 0
    assert_eq!(wallet(&v, &bob).await, "1040.00");
    assert_eq!(after["book"]["asks"], json!([]));
    conserved(&v).await;
}

#[tokio::test]
async fn snapshot_round_trips_the_whole_exchange() {
    let (v, _g) = shared().await;
    let Setup {
        x,
        alice,
        bob,
        carol,
        ..
    } = setup(&v).await;
    ok(v.order(
        &bob,
        json!({ "market": x, "side": "sell", "price": "101", "size": "3" }),
    )
    .await);
    ok(v.order(
        &carol,
        json!({ "market": x, "side": "sell", "price": "100", "size": "3" }),
    )
    .await);
    ok(v.order(
        &alice,
        json!({ "market": x, "side": "buy", "type": "market", "size": "1" }),
    )
    .await);
    let book_before = book(&v, &x).await;
    let acct_before = v.account(&alice).await;
    let hash = |v: Value| v["hash"].as_str().unwrap().to_string();
    // A reload is stamped with the intake clock, which an earlier clock step that changed nothing can leave ahead
    // of the exchange's own clock; one reload first brings the two together.
    ok(v.admin("POST", "/api/test/reload", json!({ "downMs": 0 }))
        .await);
    let hash_before = hash(ok(v.admin("GET", "/api/test/hash", Value::Null).await));
    assert_eq!(
        ok(v.admin("POST", "/api/test/reload", json!({ "downMs": 0 }))
            .await)["identical"],
        true
    );
    assert_eq!(
        hash(ok(v.admin("GET", "/api/test/hash", Value::Null).await)),
        hash_before
    ); // the whole exchange, hashed
    assert_eq!(book(&v, &x).await, book_before);
    assert_eq!(v.account(&alice).await, acct_before); // and the API key still works
                                                      // downtime is a pause: engine time resumes where it stopped
    let t0 = ok(v.get("/api/health").await)["engineTime"]
        .as_i64()
        .unwrap();
    assert_eq!(
        ok(
            v.admin("POST", "/api/test/reload", json!({ "downMs": 3_600_000 }))
                .await
        )["effects"],
        json!([])
    );
    v.advance(5_000).await;
    assert_eq!(
        ok(v.get("/api/health").await)["engineTime"]
            .as_i64()
            .unwrap(),
        t0 + 5
    );
    // and it still trades
    ok(v.order(
        &alice,
        json!({ "market": x, "side": "buy", "type": "market", "size": "2" }),
    )
    .await);
    assert_eq!(size(&v, &alice, &x).await, "3");
}
