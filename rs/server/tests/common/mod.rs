// Shared harness for the HTTP tests: one server process per test binary (debug build, TEST_CLOCK=1, OFFLINE=1,
// BOTS=0, a fresh temp DATA_DIR), driven over HTTP and websocket. Tests in a binary run one at a time, because
// they share that server and some of them move its clock. The server exits when the test process does (its
// stdin closes).

#![allow(dead_code)]

use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};

pub const ADMIN: &str = "t";

/// A started server: its base URL, and the handles that keep it alive.
pub struct Server {
    pub base: String,
    pub data_dir: PathBuf,
    pub child: Child,
    _stdin: ChildStdin,
}

/// A fresh temp directory (never deleted: the OS cleans its temp dir).
pub fn temp_dir(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("impulse-{tag}-{}-{nanos}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Start a server on `data_dir` with extra env vars, and wait until it listens.
pub fn spawn(data_dir: PathBuf, env: &[(&str, &str)]) -> Server {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_impulse-server"));
    cmd.env("PORT", "0")
        .env("OFFLINE", "1")
        .env("BOTS", "0")
        .env("TEST_CLOCK", "1")
        .env("ADMIN_TOKEN", ADMIN)
        .env("WEB_DIR", "-")
        .env("EXIT_WITH_STDIN", "1")
        .env("DATA_DIR", &data_dir);
    for (k, v) in env {
        cmd.env(k, v);
    }
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().expect("start impulse-server");
    let stdin = child.stdin.take().unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut seen = String::new();
    let base = loop {
        let mut line = String::new();
        if out.read_line(&mut line).unwrap() == 0 {
            panic!("impulse-server exited before listening:\n{seen}");
        }
        seen.push_str(&line);
        if let Some(i) = line.find("listening on http://localhost:") {
            let port: String = line[i + "listening on http://localhost:".len()..].chars().take_while(|c| c.is_ascii_digit()).collect();
            break format!("http://127.0.0.1:{port}");
        }
    };
    // Keep draining stdout so the server never blocks on a full pipe.
    std::thread::spawn(move || for _ in out.lines() {});
    Server { base, data_dir, child, _stdin: stdin }
}

/// The binary's shared server, and a lock that runs its tests one at a time.
pub fn shared() -> (Venue, MutexGuard<'static, ()>) {
    static SERVER: OnceLock<Server> = OnceLock::new();
    static LOCK: Mutex<()> = Mutex::new(());
    let guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let server = SERVER.get_or_init(|| spawn(temp_dir("http"), &[]));
    (Venue::new(&server.base), guard)
}

#[derive(Clone, Debug)]
pub struct User {
    pub id: String,
    pub key: String,
}

pub struct Venue {
    pub base: String,
    http: reqwest::Client,
}

impl Venue {
    pub fn new(base: &str) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        Venue { base: base.into(), http: reqwest::Client::new() }
    }

    pub async fn call(&self, method: &str, path: &str, body: Option<Value>, headers: &[(&str, &str)]) -> (u16, Value) {
        let mut req = self.http.request(method.parse().unwrap(), format!("{}{path}", self.base)).header("content-type", "application/json");
        for (k, v) in headers {
            req = req.header(*k, *v);
        }
        if let Some(b) = body {
            req = req.body(b.to_string());
        }
        let res = req.send().await.unwrap_or_else(|e| panic!("{method} {path}: {e}"));
        let status = res.status().as_u16();
        let text = res.text().await.unwrap();
        (status, serde_json::from_str(&text).unwrap_or(Value::Null))
    }

    pub async fn get(&self, path: &str) -> (u16, Value) {
        self.call("GET", path, None, &[]).await
    }

    pub async fn post(&self, path: &str, body: Value) -> (u16, Value) {
        self.call("POST", path, Some(body), &[]).await
    }

    pub async fn admin(&self, method: &str, path: &str, body: Value) -> (u16, Value) {
        let body = (method != "GET").then_some(body);
        self.call(method, path, body, &[("x-admin-token", ADMIN)]).await
    }

    pub async fn as_(&self, u: &User, method: &str, path: &str, body: Value) -> (u16, Value) {
        let auth = format!("Bearer {}", u.key);
        let body = (method != "GET" && method != "DELETE").then_some(body);
        self.call(method, path, body, &[("authorization", &auth)]).await
    }

    /// A signed-up account holding `wallet` USD (sign-up pays $10k; the rest is withdrawn or deposited).
    pub async fn user(&self, name: &str, wallet: i64) -> User {
        let r = ok(self.post("/api/accounts", json!({ "name": name })).await);
        let u = User { id: r["id"].as_str().unwrap().into(), key: r["apiKey"].as_str().unwrap().into() };
        let diff = wallet - 10_000;
        if diff < 0 {
            ok(self.as_(&u, "POST", "/api/withdraw", json!({ "amount": (-diff).to_string() })).await);
        }
        if diff > 0 {
            ok(self.admin("POST", "/api/admin/deposit", json!({ "account": u.id, "amount": diff.to_string() })).await);
        }
        u
    }

    /// POST /api/orders with type "limit" unless given.
    pub async fn order(&self, u: &User, body: Value) -> (u16, Value) {
        let mut b = json!({ "type": "limit" });
        b.as_object_mut().unwrap().extend(body.as_object().unwrap().clone());
        self.as_(u, "POST", "/api/orders", b).await
    }

    pub async fn account(&self, u: &User) -> Value {
        ok(self.as_(u, "GET", "/api/account", Value::Null).await)
    }

    pub async fn market(&self, id: &str) -> Value {
        ok(self.get(&format!("/api/markets/{}", encode(id))).await)
    }

    pub async fn invariants(&self) -> Vec<Value> {
        ok(self.admin("GET", "/api/test/invariants", Value::Null).await).as_array().unwrap().clone()
    }

    pub async fn advance(&self, ms: i64) -> Value {
        ok(self.admin("POST", "/api/test/advance", json!({ "ms": ms })).await)
    }

    pub fn ws_url(&self) -> String {
        format!("{}/ws", self.base.replace("http", "ws"))
    }
}

/// The body of a 200, or a panic with the server's message.
pub fn ok((status, data): (u16, Value)) -> Value {
    assert_eq!(status, 200, "HTTP {status}: {}", data["error"]);
    data
}

/// A 400 whose error matches `needle`.
pub fn fails((status, data): (u16, Value), needle: &str) {
    assert_eq!(status, 400, "expected a 400, got {status}: {data}");
    let err = data["error"].as_str().unwrap_or("");
    assert!(err.contains(needle), "error {err:?} doesn't mention {needle:?}");
}

/// A short name no other test (or earlier run against the same server) has used.
pub fn uid() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    let ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as u64;
    let n = N.fetch_add(1, Ordering::Relaxed);
    let b36 = |mut v: u64| {
        let digits = b"0123456789abcdefghijklmnopqrstuvwxyz";
        let mut s = vec![];
        loop {
            s.push(digits[(v % 36) as usize]);
            v /= 36;
            if v == 0 {
                break;
            }
        }
        s.reverse();
        String::from_utf8(s).unwrap()
    };
    format!("{}{}{}", b36(ms % 1_000_000), b36(n), b36(std::process::id() as u64 % 1296))
}

pub fn encode(id: &str) -> String {
    id.replace('@', "%40")
}

/// Exact decimal string → nano-USD.
pub fn nano(s: &str) -> i128 {
    impulse_engine::fixed::parse_fixed(s).unwrap()
}

/// Numbers in JSON views are strings; read one as f64 for comparisons.
pub fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => s.parse().unwrap(),
        other => other.as_f64().unwrap(),
    }
}

/// Connect a websocket, send `msgs`, and collect channel payloads until `done` holds (3 s timeout).
pub async fn ws_collect(url: &str, msgs: &[Value], done: impl Fn(&std::collections::HashMap<String, Value>) -> bool) -> std::collections::HashMap<String, Value> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.expect("websocket connect");
    for m in msgs {
        ws.send(Message::Text(m.to_string().into())).await.unwrap();
    }
    let mut got = std::collections::HashMap::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(3);
    while !done(&got) {
        let msg = tokio::time::timeout_at(deadline, ws.next()).await.unwrap_or_else(|_| panic!("websocket timeout; got {:?}", got.keys().collect::<Vec<_>>()));
        let Some(Ok(Message::Text(t))) = msg else { continue };
        let v: Value = serde_json::from_str(t.as_str()).unwrap();
        got.insert(v["ch"].as_str().unwrap().to_string(), v["data"].clone());
    }
    let _ = ws.close(None).await;
    got
}
