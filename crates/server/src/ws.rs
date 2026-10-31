// Websocket hub. Channels: markets, feed, leaderboard, book:<id>, trades:<id>, candles:<id>, account (after
// {op:"auth"}). Every 500 ms, if the exchange changed, each client gets the channels whose payload changed since
// the last send. A payload is serialized once per tick and shared: `Utf8Bytes` clones are reference-counted, so
// every client that gets it (and its record of what it last sent) holds the same buffer.

use crate::api::{App, Node};
use crate::exchange::Exchange;
use crate::views;
use axum::extract::ws::{Message, Utf8Bytes, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::mpsc;

/// How many unsent messages a slow client may queue before pushes skip it (the TS hub's bufferedAmount check).
const QUEUE: usize = 64;

struct Client {
    subs: Vec<String>, // in subscription order
    out: Outbox,
}

/// Where a client's messages go, and what it was last sent on each channel.
struct Outbox {
    account: Option<String>,
    sent: HashMap<String, Utf8Bytes>,
    tx: mpsc::Sender<Utf8Bytes>,
}

/// Payloads already built this tick, by channel (and viewer, for `account`). None: no such channel.
type Cache = HashMap<String, Option<Utf8Bytes>>;

#[derive(Default)]
pub struct Hub {
    clients: HashMap<u64, Client>,
    next: u64,
    last_version: Option<u64>,
}

#[derive(Serialize)]
struct Msg<'a, T> {
    ch: &'a str,
    data: T,
}

fn text<T: Serialize>(ch: &str, data: T) -> Utf8Bytes {
    serde_json::to_string(&Msg { ch, data })
        .expect("view serializes")
        .into()
}

/// The channel's message, or None for a channel that doesn't exist.
fn payload(x: &Exchange, ch: &str, account: Option<&str>) -> Option<Utf8Bytes> {
    match ch {
        "markets" => return Some(text(ch, views::markets_view(x))),
        "feed" => return Some(text(ch, x.risk.iter().rev().take(60).collect::<Vec<_>>())),
        "leaderboard" => return Some(text(ch, views::leaderboard_view(x))),
        "account" => return Some(text(ch, account.map(|a| views::account_view(x, a)))),
        _ => {}
    }
    let (kind, id) = ch.split_once(':')?;
    if !x.markets.contains_key(id) {
        return None;
    }
    match kind {
        "book" => Some(text(ch, views::book_view(x, id, 20))),
        "trades" => Some(text(ch, views::trades_view(x, id, 40))),
        "candles" => Some(text(ch, views::recent_candles_view(x, id, 2))),
        _ => None,
    }
}

impl Outbox {
    /// Send one channel if its payload changed since this client's last send of it.
    fn push(&mut self, x: &Exchange, ch: &str, cache: &mut Cache) {
        if self.tx.capacity() == 0 {
            return;
        }
        let key = if ch == "account" {
            format!("account:{}", self.account.as_deref().unwrap_or("null"))
        } else {
            ch.to_string()
        };
        let msg = cache
            .entry(key)
            .or_insert_with(|| payload(x, ch, self.account.as_deref()));
        let Some(msg) = msg else { return };
        if self.sent.get(ch) == Some(msg) {
            return;
        }
        if self.tx.try_send(msg.clone()).is_ok() {
            self.sent.insert(ch.to_string(), msg.clone());
        }
    }
}

impl Hub {
    /// The 500 ms tick.
    pub fn tick(node: &mut Node) {
        let Node { core, hub, .. } = node;
        let x = &core.x;
        if hub.last_version == Some(x.version) {
            return;
        }
        hub.last_version = Some(x.version);
        let mut cache = Cache::new();
        for c in hub.clients.values_mut() {
            for ch in &c.subs {
                c.out.push(x, ch, &mut cache);
            }
        }
    }

    fn on_message(node: &mut Node, id: u64, raw: &str) {
        let Ok(msg) = serde_json::from_str::<Value>(raw) else {
            return;
        };
        let Node { core, hub, .. } = node;
        let x = &core.x;
        let Some(c) = hub.clients.get_mut(&id) else {
            return;
        };
        let ch = msg["ch"].as_str();
        match (msg["op"].as_str(), ch) {
            (Some("sub"), Some(ch)) => {
                if !c.subs.iter().any(|s| s == ch) {
                    c.subs.push(ch.to_string());
                }
                c.out.push(x, ch, &mut Cache::new());
            }
            (Some("unsub"), Some(ch)) => {
                c.subs.retain(|s| s != ch);
                c.out.sent.remove(ch);
            }
            (Some("auth"), _) => {
                let out = &mut c.out;
                out.account = msg["key"]
                    .as_str()
                    .filter(|k| !k.is_empty())
                    .and_then(|k| x.account_by_key(k))
                    .map(|a| a.id.clone());
                out.sent.remove("account");
                let reply = json!({ "ch": "auth", "data": { "account": out.account } });
                let _ = out.tx.try_send(reply.to_string().into());
                if c.subs.iter().any(|s| s == "account") {
                    out.push(x, "account", &mut Cache::new());
                }
            }
            _ => {}
        }
    }
}

pub async fn upgrade(State(app): State<App>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| serve(socket, app))
}

async fn serve(socket: WebSocket, app: App) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Utf8Bytes>(QUEUE);
    let id = {
        let mut node = app.lock();
        let hub = &mut node.hub;
        hub.next += 1;
        let out = Outbox {
            account: None,
            sent: HashMap::new(),
            tx,
        };
        hub.clients.insert(hub.next, Client { subs: vec![], out });
        hub.next
    };
    let writer = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => Hub::on_message(&mut app.lock(), id, t.as_str()),
            Message::Close(_) => break,
            _ => {}
        }
    }
    app.lock().hub.clients.remove(&id);
    writer.abort();
}
