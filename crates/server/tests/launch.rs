// Creator-coin launches through the API, ported from the TypeScript launch.test.ts (impulse-research: tests/http/): snipe
// window, the open on the exchange clock, launch reserve, pump, and the new fields on the websocket channels.

mod common;
use common::*;
use serde_json::{json, Value};

fn spot_tokens(acct: &Value, market: &str) -> Vec<Value> {
    acct["spot"].as_array().unwrap().iter().filter(|s| s["market"] == market).map(|s| s["tokens"].clone()).collect()
}

#[tokio::test]
async fn bids_of_100k_open_at_0_000125_for_800m_tokens_with_the_rest_held_as_the_launch_reserve() {
    let (v, _g) = shared();
    let s = uid();
    let c = format!("@c{s}");
    ok(v.admin("POST", "/api/test/market", json!({ "id": c, "kind": "attention", "source": { "kind": "curve" }, "feeBps": 0, "snipeSeconds": 60 })).await);
    let a = v.user(&format!("sa{s}"), 100_000).await;
    let b = v.user(&format!("sb{s}"), 100_000).await;
    ok(v.as_(&a, "POST", "/api/snipe", json!({ "market": c, "usdc": "75000" })).await);
    ok(v.as_(&b, "POST", "/api/snipe", json!({ "market": c, "usdc": "25000" })).await);
    let before = v.market(&c).await["market"].clone();
    assert_eq!((&before["snipe"]["total"], &before["snipe"]["snipers"], &before["snipe"]["projectedOpenPrice"]), (&json!("100000.00"), &json!(2), &json!("0.000125")));
    assert_eq!(before["snipe"]["top"], json!([{ "account": a.id, "usdc": "75000.00" }, { "account": b.id, "usdc": "25000.00" }]));
    assert_eq!(before["launch"], Value::Null);

    let effects = v.advance(60_000).await["effects"].clone();
    assert!(effects.as_array().unwrap().contains(&json!("open")));
    let after = v.market(&c).await["market"].clone();
    assert_eq!(after["snipe"], Value::Null);
    for (k, want) in [("openPrice", "0.000125"), ("sniped", "100000.00"), ("tokensSold", "800000000"), ("reserve", "80000.00")] {
        assert_eq!(after["launch"][k], want, "launch.{k}");
    }
    assert_eq!(after["mark"], "0.000125");
    assert_eq!((&after["curve"]["usdcIn"], &after["curve"]["tokensSold"]), (&json!("20000.00"), &json!("800000000")));
    assert_eq!(spot_tokens(&v.account(&a).await, &c), [json!("600000000")]);
    assert_eq!(spot_tokens(&v.account(&b).await, &c), [json!("200000000")]);
    assert_eq!(v.invariants().await, Vec::<Value>::new()); // the $80,000 reserve is inside conservation

    let feed = ok(v.get(&format!("/api/feed?market={}", encode(&c))).await);
    let open = feed.as_array().unwrap().iter().find(|r| r["kind"] == "open").unwrap().clone();
    assert_eq!(open["price"], "0.000125");
    let mut accounts: Vec<String> = open["accounts"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    accounts.sort();
    let mut want = vec![a.id.clone(), b.id.clone()];
    want.sort();
    assert_eq!(accounts, want);
}

#[tokio::test]
async fn holds_bids_in_the_window_rejects_trading_until_the_open_and_bids_after_it() {
    let (v, _g) = shared();
    let s = uid();
    let u = v.user(&format!("sn{s}"), 10_000).await;
    let coin = ok(v.as_(&u, "POST", "/api/attention", json!({ "handle": format!("w{s}") })).await);
    let c = coin["id"].as_str().unwrap().to_string();
    assert_eq!((&coin["snipe"]["total"], &coin["snipe"]["snipers"], &coin["snipe"]["recent"], &coin["snipe"]["top"]), (&json!("0.00"), &json!(0), &json!([]), &json!([])));
    ok(v.as_(&u, "POST", "/api/snipe", json!({ "market": c, "usdc": "1000" })).await);
    let acct = v.account(&u).await;
    assert_eq!(acct["wallet"], "9000.00");
    assert_eq!(acct["snipes"].as_array().unwrap().len(), 1);
    assert_eq!((&acct["snipes"][0]["market"], &acct["snipes"][0]["usdc"]), (&json!(c), &json!("1000.00")));
    assert!(acct["snipes"][0]["time"].is_number());
    let m = v.market(&c).await["market"].clone();
    assert_eq!((&m["snipe"]["recent"][0]["account"], &m["snipe"]["recent"][0]["usdc"]), (&json!(u.id), &json!("1000.00")));

    fails(v.as_(&u, "POST", "/api/spot/buy", json!({ "market": c, "usdc": "10" })).await, "snipe window");
    fails(v.order(&u, json!({ "market": c, "side": "buy", "type": "market", "size": "1000" })).await, "snipe window");
    assert_eq!(v.invariants().await, Vec::<Value>::new()); // the bid (net of its 1% fee) is held by the launch

    v.advance(61_000).await;
    fails(v.as_(&u, "POST", "/api/snipe", json!({ "market": c, "usdc": "10" })).await, "closed");
    assert_eq!(v.account(&u).await["snipes"], json!([]));
    assert_eq!(v.market(&c).await["market"]["launch"]["sniped"], "990.00"); // the 1% spot fee applies to snipes
    ok(v.as_(&u, "POST", "/api/spot/buy", json!({ "market": c, "usdc": "10" })).await);
    assert_eq!(v.invariants().await, Vec::<Value>::new());
}

#[tokio::test]
async fn lists_a_demo_coin_and_pumps_it_from_the_house_account() {
    let (v, _g) = shared();
    let coin = ok(v.admin("POST", "/api/admin/demo-coin", json!({})).await);
    let id = coin["id"].as_str().unwrap().to_string();
    assert!(id.starts_with("@demo_"), "{id}");
    assert_ne!(coin["snipe"], Value::Null);
    assert_eq!(v.admin("POST", "/api/admin/pump", json!({ "market": id, "usdc": "100" })).await.0, 400); // not open yet
    v.advance(61_000).await;
    let opened = v.market(&id).await["market"].clone();
    assert_eq!((&opened["launch"]["sniped"], &opened["launch"]["tokensSold"], &opened["launch"]["openPrice"]), (&json!("0.00"), &json!("0"), &json!("0.000005")));

    let up = ok(v.admin("POST", "/api/admin/pump", json!({ "market": id, "usdc": "5000" })).await);
    assert!(up["effects"].as_array().unwrap().contains(&json!("spot")));
    let pumped = num(&v.market(&id).await["market"]["curve"]["price"]);
    assert!(pumped > 0.000019, "{pumped}"); // spot ∝ x²: $5k into a $5k curve ≈ 4×
    let down = ok(v.admin("POST", "/api/admin/pump", json!({ "market": id, "usdc": "-2000" })).await);
    assert!(down["effects"].as_array().unwrap().contains(&json!("spot")));
    assert!(num(&v.market(&id).await["market"]["curve"]["price"]) < pumped);
    fails(v.admin("POST", "/api/admin/pump", json!({ "market": "BTC-PERP", "usdc": "100" })).await, "admin/price");
    assert_eq!(v.invariants().await, Vec::<Value>::new());
}

#[tokio::test]
async fn reports_every_markets_settings_flagging_the_ones_mirror_doesnt_publish() {
    let (v, _g) = shared();
    let coin = ok(v.admin("POST", "/api/admin/demo-coin", json!({ "handle": format!("set{}", uid()) })).await);
    let setting = |label: &str| coin["settings"].as_array().unwrap().iter().find(|x| x["label"] == label).cloned().unwrap_or_else(|| panic!("no {label}"));
    assert_eq!(setting("Perp oracle"), json!({ "label": "Perp oracle", "value": "10-minute TWAP of spot", "ours": true }));
    assert_eq!((setting("Spot fee")["value"].clone(), setting("Spot fee")["ours"].clone()), (json!("1%, also on snipes"), json!(true)));
    assert_eq!(setting("Start leverage")["value"], "3×");
    assert_eq!((setting("ADL")["value"].clone(), setting("ADL")["ours"].clone()), (json!("pro-rata on profit first, then principal"), json!(true)));
    assert_eq!(setting("Snipe window")["value"], "60 s");
}

#[tokio::test]
async fn streams_the_new_fields_on_the_existing_channels_markets_account_and_feed() {
    let (v, _g) = shared();
    let s = uid();
    let u = v.user(&format!("ws{s}"), 10_000).await;
    let coin = ok(v.as_(&u, "POST", "/api/attention", json!({ "handle": format!("ws{s}") })).await);
    let c = coin["id"].as_str().unwrap().to_string();
    ok(v.as_(&u, "POST", "/api/snipe", json!({ "market": c, "usdc": "50" })).await);
    let mut msgs = vec![json!({ "op": "auth", "key": u.key })];
    for ch in ["markets", "feed", "account"] {
        msgs.push(json!({ "op": "sub", "ch": ch }));
    }
    let got = ws_collect(&v.ws_url(), &msgs, |g| g.contains_key("markets") && g.contains_key("feed") && g.get("account").is_some_and(|a| a["id"] == u.id)).await;
    let m = got["markets"].as_array().unwrap().iter().find(|x| x["id"] == c.as_str()).unwrap().clone();
    assert_eq!((&m["snipe"]["total"], &m["snipe"]["snipers"]), (&json!("50.00"), &json!(1)));
    assert_eq!(m["launch"], Value::Null);
    assert_eq!(m["preipo"], Value::Null);
    assert!(m["settings"].is_array());
    let snipes = got["account"]["snipes"].as_array().unwrap();
    assert_eq!((snipes.len(), &snipes[0]["market"], &snipes[0]["usdc"]), (1, &json!(c), &json!("50.00")));
    assert!(got["feed"][0].as_object().unwrap().contains_key("price"));
}
