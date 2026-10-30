// The journal, snapshots and recovery, end to end against the server binary: a bots-on session replays to the
// same state hash from seq 1 and from a snapshot plus its tail; kill -9 loses nothing acknowledged; refused
// commands aren't journaled; the read tables match the exchange's history and the journal; a legacy JSON
// snapshot imports with the same state; and the time each command takes, with synchronous=FULL.
//
// Each test runs its own server; one at a time (they're heavier than the API tests).

mod common;
use common::*;
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

/// Bots on, timers 25× faster, the test clock.
const BUSY: &[(&str, &str)] = &[("BOTS", "1"), ("TIMER_SPEEDUP", "25")];

fn bin() -> std::process::Command {
    std::process::Command::new(env!("CARGO_BIN_EXE_impulse-server"))
}

/// `impulse-server replay …` on a data dir: {seq, hash, replayed, fills, risk}.
fn replay(dir: &Path, args: &[&str]) -> Value {
    let out = bin().arg("replay").args(args).env("DATA_DIR", dir).output().unwrap();
    assert!(out.status.success(), "replay {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    serde_json::from_slice(&out.stdout).unwrap()
}

fn db(dir: &Path) -> rusqlite::Connection {
    rusqlite::Connection::open_with_flags(dir.join("impulse.db"), rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn count(dir: &Path, sql: &str) -> i64 {
    db(dir).query_row(sql, [], |r| r.get(0)).unwrap()
}

async fn hash(v: &Venue) -> (u64, String) {
    let h = ok(v.admin("GET", "/api/test/hash", Value::Null).await);
    (h["seq"].as_u64().unwrap(), h["hash"].as_str().unwrap().to_string())
}

/// Drive a session until the journal passes `target` commands: the bots trade, and the test adds launches, a
/// pre-IPO market with an IPO, gaps and clock steps (funding, opens) on top.
async fn busy_session(v: &Venue, target: u64) {
    let s = uid();
    let u = v.user(&format!("dr{s}"), 50_000).await;
    let coin = ok(v.admin("POST", "/api/admin/demo-coin", json!({ "handle": format!("d{s}") })).await)["id"].as_str().unwrap().to_string();
    ok(v.as_(&u, "POST", "/api/snipe", json!({ "market": coin, "usdc": "500" })).await);
    let pre = format!("P{s}");
    ok(v.admin("POST", "/api/admin/preipo", json!({ "id": pre, "name": "Durable Co", "price": "50" })).await);
    let started = Instant::now();
    let mut i = 0;
    loop {
        // engine time moves: funding, TWAPs, the coin's open after 60 s
        let seq = v.advance(2_000).await["seq"].as_u64().unwrap();
        if seq >= target {
            break;
        }
        assert!(started.elapsed() < Duration::from_secs(150), "session stalled at seq {seq}");
        match i % 40 {
            5 => {
                let _ = v.order(&u, json!({ "market": coin, "side": "buy", "type": "market", "size": "100000", "leverage": 2 })).await;
            }
            10 => {
                let _ = v.order(&u, json!({ "market": pre, "side": "buy", "type": "market", "size": "5", "leverage": 3 })).await;
            }
            20 => {
                let _ = v.admin("POST", "/api/admin/price", json!({ "market": "SIM-ELECTION", "price": "0.2", "holdSeconds": 4 })).await;
            }
            30 if i == 30 => {
                let _ = v.admin("POST", "/api/admin/ipo", json!({ "market": pre, "price": "35" })).await;
            }
            _ => {}
        }
        i += 1;
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn determinism_a_bots_on_session_replayed_from_seq_1_reaches_the_live_state_hash() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("determinism");
    let mut server = spawn(dir.clone(), BUSY);
    let v = Venue::new(&server.base);
    busy_session(&v, 3_000).await;
    let (seq, live) = hash(&v).await;
    let full = replay(&dir, &["--full", "--until", &seq.to_string()]);
    assert_eq!(full["seq"], seq);
    assert_eq!(full["replayed"], seq, "a full replay starts at seq 1");
    assert_eq!(full["hash"], live.as_str(), "replay from seq 1 reaches the live state");
    let kinds = count(&dir, "SELECT COUNT(DISTINCT kind) FROM commands");
    assert!(kinds >= 10, "the session should exercise many command kinds, got {kinds}");
    server.child.kill().unwrap();
}

#[tokio::test]
async fn a_snapshot_plus_its_tail_reaches_the_same_hash_as_a_full_replay() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("snapshot");
    let mut server = spawn(dir.clone(), BUSY);
    let v = Venue::new(&server.base);
    busy_session(&v, 1_300).await;
    let (seq, live) = hash(&v).await;
    let snap: i64 = count(&dir, &format!("SELECT MAX(seq) FROM snapshots WHERE seq <= {seq}"));
    assert!(snap > 0 && (snap as u64) < seq, "a snapshot between the start and seq {seq}: {snap}");
    let tail = replay(&dir, &["--until", &seq.to_string()]);
    assert_eq!(tail["replayed"].as_u64().unwrap(), seq - snap as u64, "replayed only the tail after snapshot {snap}");
    let full = replay(&dir, &["--full", "--until", &seq.to_string()]);
    assert_eq!(tail["hash"], full["hash"]);
    assert_eq!(full["hash"], live.as_str());
    server.child.kill().unwrap();
}

#[tokio::test]
async fn kill_9_mid_trading_loses_nothing_acknowledged_and_restarts_at_the_journals_hash() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("crash");
    let mut server = spawn(dir.clone(), BUSY);
    let v = Venue::new(&server.base);
    tokio::time::sleep(Duration::from_millis(500)).await; // the maker quotes every market
    let s = uid();
    let resting = v.user(&format!("rs{s}"), 10_000).await;
    let taker = v.user(&format!("tk{s}"), 100_000).await;
    let mark = num(&v.market("BTC-PERP").await["market"]["mark"]);
    let mut orders = vec![];
    let mut fills = vec![];
    for i in 0..30 {
        // far below the market: these rest until someone cancels them
        let price = format!("{}", (mark * 0.5).floor() as i64 - i);
        let r = ok(v.order(&resting, json!({ "market": "BTC-PERP", "side": "buy", "price": price, "size": "0.001", "leverage": 1 })).await);
        orders.push(r["order"]["id"].as_u64().unwrap());
        let (status, r) = v.order(&taker, json!({ "market": "SOL-PERP", "side": if i % 2 == 0 { "buy" } else { "sell" }, "type": "market", "size": "1" })).await;
        if status == 200 {
            fills.extend(r["fills"].as_array().unwrap().iter().map(|f| f["id"].as_u64().unwrap()));
        }
    }
    assert!(!fills.is_empty(), "the taker should have traded with the maker");
    server.child.kill().unwrap(); // SIGKILL, mid-trading: the bots were still submitting
    server.child.wait().unwrap();

    let server = spawn(dir.clone(), BUSY);
    let v = Venue::new(&server.base);
    let after = v.account(&resting).await; // the API keys survived
    let have: Vec<u64> = after["orders"].as_array().unwrap().iter().map(|o| o["id"].as_u64().unwrap()).collect();
    for id in &orders {
        assert!(have.contains(id), "acknowledged order {id} is gone after the restart");
    }
    let taker_fills: Vec<u64> = v.account(&taker).await["fills"].as_array().unwrap().iter().map(|f| f["id"].as_u64().unwrap()).collect();
    for id in &fills {
        assert!(taker_fills.contains(id), "acknowledged fill {id} is gone after the restart");
    }
    let (seq, live) = hash(&v).await;
    assert_eq!(replay(&dir, &["--full", "--until", &seq.to_string()])["hash"], live.as_str(), "the restarted state is the journal's");
    drop(server);
}

#[tokio::test]
async fn a_refused_command_writes_no_journal_row() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("reject");
    let server = spawn(dir.clone(), &[]);
    let v = Venue::new(&server.base);
    let u = v.user(&format!("rj{}", uid()), 1000).await;
    // The random walk keeps journaling ticks; nothing else should appear.
    let others = || count(&dir, "SELECT COUNT(*) FROM commands WHERE kind NOT IN ('ticks', 'clock')");
    let before = others();
    fails(v.order(&u, json!({ "market": "BTC-PERP", "side": "buy", "price": "80000.5", "size": "0.01" })).await, "tick"); // off the tick
    fails(v.order(&u, json!({ "market": "BTC-PERP", "side": "buy", "price": "80000", "size": "10", "leverage": 1 })).await, "insufficient");
    fails(v.as_(&u, "POST", "/api/withdraw", json!({ "amount": "5000" })).await, "exceeds");
    assert_eq!(v.admin("POST", "/api/test/tick", json!({ "market": "NOPE", "price": "1" })).await.0, 404);
    assert_eq!(others(), before, "refused commands were journaled");
    let mine = count(&dir, &format!("SELECT COUNT(*) FROM commands WHERE kind = 'placeOrder' AND payload LIKE '%\"{}\"%'", u.id));
    assert_eq!(mine, 0);
    drop(server);
}

#[tokio::test]
async fn the_read_tables_match_the_in_memory_history_and_the_journals_effects() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("tables");
    let mut server = spawn(dir.clone(), BUSY);
    let v = Venue::new(&server.base);
    busy_session(&v, 600).await;
    server.child.kill().unwrap(); // freeze the history (the database already has everything committed)
    server.child.wait().unwrap();
    let server = spawn(dir.clone(), &[]); // a quiet server on the same data: recovery, no bots
    let v = Venue::new(&server.base);

    // Within the in-memory caps the two histories agree exactly.
    let memory = ok(v.get("/api/feed").await);
    let stored = ok(v.get("/api/feed?limit=200").await);
    let n = memory.as_array().unwrap().len().min(stored.as_array().unwrap().len());
    assert!(n > 10, "risk events: {n}");
    assert_eq!(memory.as_array().unwrap()[..n], stored.as_array().unwrap()[..n]);
    let markets = ok(v.get("/api/markets").await);
    let mut traded = 0;
    for m in markets.as_array().unwrap() {
        let id = encode(m["id"].as_str().unwrap());
        let memory = ok(v.get(&format!("/api/markets/{id}/trades")).await);
        let stored = ok(v.get(&format!("/api/markets/{id}/trades?limit=60")).await);
        let n = memory.as_array().unwrap().len();
        let strip = |f: &Value| json!({ "id": f["id"], "time": f["time"], "market": f["market"], "kind": f["kind"], "price": f["price"], "size": f["size"], "notional": f["notional"], "side": f["side"], "taker": f["taker"], "maker": f["maker"] });
        let memory: Vec<Value> = memory.as_array().unwrap().iter().map(strip).collect();
        assert_eq!(memory, stored.as_array().unwrap()[..n], "{id} trades");
        traded += n;
    }
    assert!(traded > 0);

    // Every fill and risk event the journal produces is a row, and nothing else is.
    let (seq, _) = hash(&v).await;
    let r = replay(&dir, &["--full", "--until", &seq.to_string()]);
    assert_eq!(r["fills"].as_i64().unwrap(), count(&dir, &format!("SELECT COUNT(*) FROM fills WHERE seq <= {seq}")));
    assert_eq!(r["risk"].as_i64().unwrap(), count(&dir, &format!("SELECT COUNT(*) FROM risk_events WHERE seq <= {seq}")));
    assert_eq!(count(&dir, "SELECT COUNT(*) FROM accounts"), ok(v.get("/api/leaderboard").await).as_array().unwrap().len() as i64);
    drop(server);
}

#[tokio::test]
async fn a_legacy_json_snapshot_alone_in_data_dir_comes_up_with_the_same_state() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let a = temp_dir("legacy-a");
    let mut server = spawn(a.clone(), &[]);
    let v = Venue::new(&server.base);
    let s = uid();
    // A manual-oracle market: the offline random walk never moves it, so nothing changes after the reads below.
    let x = format!("L{s}");
    ok(v.admin("POST", "/api/test/market", json!({ "id": x, "kind": "perp", "price": "2500", "szDecimals": 2 })).await);
    let maker = v.user(&format!("mk{s}"), 100_000).await;
    let user = v.user(&format!("us{s}"), 10_000).await;
    ok(v.order(&maker, json!({ "market": x, "side": "sell", "price": "2500", "size": "10" })).await);
    ok(v.order(&user, json!({ "market": x, "side": "buy", "price": "2500", "size": "1", "leverage": 2 })).await);
    ok(v.order(&user, json!({ "market": x, "side": "buy", "price": "1000", "size": "1" })).await);
    let account = v.account(&user).await;
    let book = v.market(&x).await["book"].clone();
    server.child.kill().unwrap();
    server.child.wait().unwrap();
    let hash_a = replay(&a, &[])["hash"].clone();

    // The legacy format, alone in a new data dir.
    let b = temp_dir("legacy-b");
    let out = bin().arg("export-json").arg(&b).env("DATA_DIR", &a).output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(b.join("snapshot.json").exists() && !b.join("impulse.db").exists());

    let server = spawn(b.clone(), &[]);
    let v = Venue::new(&server.base);
    assert!(b.join("snapshot.json").exists(), "the JSON file is kept");
    assert_eq!(replay(&b, &["--until", "0"])["hash"], hash_a, "snapshot 0 is the imported state, exactly");
    assert_eq!(v.account(&user).await, account);
    assert_eq!(v.market(&x).await["book"], book);
    assert!(count(&b, "SELECT COUNT(*) FROM fills") >= 1, "the import's history went into the read tables");
    drop(server);
}

#[tokio::test]
async fn throughput_with_bots_on_and_synchronous_full() {
    let _g = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let dir = temp_dir("throughput");
    let mut server = spawn(dir.clone(), BUSY);
    let v = Venue::new(&server.base);
    let started = Instant::now();
    busy_session(&v, 1_500).await;
    // A burst from one user on top of the bots: 150 orders that rest, each cancelled right after (300 commands).
    let u = v.user(&format!("tp{}", uid()), 100_000).await;
    let burst = Instant::now();
    for i in 0..150 {
        let id = ok(v.order(&u, json!({ "market": "BTC-PERP", "side": "buy", "price": format!("{}", 30_000 + i), "size": "0.001" })).await)["order"]["id"].clone();
        ok(v.as_(&u, "DELETE", &format!("/api/orders/{id}"), Value::Null).await);
    }
    let burst_s = burst.elapsed().as_secs_f64();
    let stats = ok(v.admin("GET", "/api/admin/stats", Value::Null).await);
    let elapsed = started.elapsed().as_secs_f64();
    let seq = stats["seq"].as_f64().unwrap();
    let mean = stats["mean_us"].as_f64().unwrap();
    eprintln!(
        "throughput: {seq} commands in {elapsed:.1} s ({:.0}/s, bots on, timers 25×); per command p50 {} µs, p99 {} µs, max {} µs, mean {mean} µs \
         (≈ {:.0} commands/s of capacity); a burst of 300 HTTP orders and cancels took {burst_s:.2} s ({:.0}/s, client round trips included)",
        seq / elapsed,
        stats["p50_us"],
        stats["p99_us"],
        stats["max_us"],
        1e6 / mean.max(1.0),
        300.0 / burst_s,
    );
    assert!(stats["p99_us"].as_u64().unwrap() < 250_000, "p99 per command over 250 ms: {stats}");
    server.child.kill().unwrap();
}
