// HTTP + WebSocket API. Every handler locks the one exchange node and runs synchronously against it, so each
// request is one atomic step of the single-threaded node (Mirror's "one monolithic node", in miniature).
//
// Auth: `Authorization: Bearer <apiKey>` (issued at signup) for trading; `x-admin-token` for admin.

mod admin;
mod extract;
mod public;
mod test_hooks;
mod trading;
mod web;

use extract::*;

use crate::book::{Side, Tif};
use crate::bots::Bots;
use crate::command::*;
pub use crate::sequencer::Node;
use crate::exchange::{ExError, Exchange, Kind, MarketSpec, OrderInput, OrderResult, OrderType, Source};
use crate::intake::api_key;
use crate::logging::log;
use crate::feeds;
use crate::rng::Rng;
use crate::units::usd;
use crate::views;
use axum::extract::{FromRequest, FromRequestParts, Path, Query, Request, State};
use axum::http::{header, request::Parts, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use impulse_engine::{check_invariants, Effect};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Component, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

pub struct Inner {
    node: Mutex<Node>,
    pub admin_token: String,
    pub web_dir: Option<PathBuf>,
    pub http: reqwest::Client,
    pub test_hooks: bool,
}

#[derive(Clone)]
pub struct App(Arc<Inner>);

impl std::ops::Deref for App {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl App {
    pub fn new(node: Node, admin_token: String, web_dir: Option<PathBuf>, test_hooks: bool) -> Self {
        App(Arc::new(Inner { node: Mutex::new(node), admin_token, web_dir, http: feeds::client(), test_hooks }))
    }

    pub fn lock(&self) -> MutexGuard<'_, Node> {
        // A panicking handler poisons the lock; the node is still consistent at engine-commit granularity.
        self.node.lock().unwrap_or_else(|e| e.into_inner())
    }
}

type ApiResult = Result<Response, ApiError>;

fn ok<T: Serialize>(v: T) -> ApiResult {
    Ok(Json(v).into_response())
}

fn kinds(effects: &[Effect]) -> Vec<&'static str> {
    effects.iter().map(Effect::kind).collect()
}

fn parse_side(s: &str) -> Result<Side, ExError> {
    match s {
        "buy" => Ok(Side::Buy),
        "sell" => Ok(Side::Sell),
        _ => Err(ExError::bad("side must be buy or sell")),
    }
}

fn parse_kind(s: &str) -> Result<Kind, ExError> {
    match s {
        "perp" => Ok(Kind::Perp),
        "binary" => Ok(Kind::Binary),
        "attention" => Ok(Kind::Attention),
        "preipo" => Ok(Kind::Preipo),
        _ => Err(ExError::bad("kind must be perp, binary, attention or preipo")),
    }
}

fn order_reply(x: &Exchange, id: &str, r: OrderResult, with_order: bool) -> ApiResult {
    let fills: Vec<_> = r.fills.iter().map(|f| views::fill_view(x, f, Some(id))).collect();
    if with_order {
        ok(json!({ "status": r.status, "reason": r.reason, "order": views::order_view(x, &r.order), "fills": fills }))
    } else {
        ok(json!({ "status": r.status, "reason": r.reason, "fills": fills }))
    }
}

/// List a market and reply with its view.
fn list(app: &App, spec: MarketSpec) -> ApiResult {
    let mut node = app.lock();
    let id = node.submit(ListMarket { spec: Box::new(spec) })?;
    ok(views::market_view(&node.core.x, &id))
}

pub fn router(app: App) -> Router {
    let mut r = Router::new()
        .route("/api/health", get(public::health))
        .route("/api/config", get(public::config))
        .route("/api/markets", get(public::markets))
        .route("/api/markets/{id}", get(public::market))
        .route("/api/markets/{id}/candles", get(public::candles))
        .route("/api/markets/{id}/positions", get(public::positions))
        .route("/api/markets/{id}/trades", get(public::trades))
        .route("/api/feed", get(public::feed))
        .route("/api/leaderboard", get(public::leaderboard))
        .route("/api/accounts", post(public::signup))
        .route("/api/account", get(trading::account))
        .route("/api/faucet", post(trading::faucet))
        .route("/api/withdraw", post(trading::withdraw))
        .route("/api/orders", post(trading::place_order))
        .route("/api/orders/cancel-all", post(trading::cancel_all))
        .route("/api/orders/{id}", delete(trading::cancel))
        .route("/api/positions/close", post(trading::close_position))
        .route("/api/margin", post(trading::margin))
        .route("/api/spot/buy", post(trading::spot_buy))
        .route("/api/spot/sell", post(trading::spot_sell))
        .route("/api/attention", post(trading::attention))
        .route("/api/snipe", post(trading::snipe))
        .route("/api/admin/price", post(admin::price))
        .route("/api/admin/release", post(admin::release))
        .route("/api/admin/resolve", post(admin::resolve))
        .route("/api/admin/market", post(admin::market))
        .route("/api/admin/polymarket", post(admin::polymarket))
        .route("/api/admin/hyperliquid", post(admin::hyperliquid))
        .route("/api/admin/deposit", post(admin::deposit))
        .route("/api/admin/demo-coin", post(admin::demo_coin))
        .route("/api/admin/pump", post(admin::pump))
        .route("/api/admin/preipo", post(admin::preipo))
        .route("/api/admin/ipo", post(admin::ipo))
        .route("/api/admin/bots", post(admin::bots))
        .route("/api/admin/status", get(admin::status))
        .route("/api/admin/stats", get(admin::stats))
        .route("/ws", get(crate::ws::upgrade));
    if app.test_hooks {
        r = r
            .route("/api/test/advance", post(test_hooks::advance))
            .route("/api/test/market", post(test_hooks::market))
            .route("/api/test/tick", post(test_hooks::tick))
            .route("/api/test/invariants", get(test_hooks::invariants))
            .route("/api/test/hash", get(test_hooks::hash))
            .route("/api/test/reload", post(test_hooks::reload));
    }
    r.method_not_allowed_fallback(web::not_found).fallback(web::fallback).layer(axum::middleware::from_fn(web::cors)).with_state(app)
}
