// Price feeds. Hyperliquid mids for crypto, memecoins and HIP-3 equities; Polymarket midpoints for binary
// outcomes (and their resolution); a seeded random walk when offline. Feeds only ever call Exchange::tick, so
// every price change runs liquidation and ADL atomically, and an admin hold makes the feed stand aside.

use crate::api::{App, Node};
use crate::logging::log;
use crate::command::{Bar, History, ListMarket, Resolve, Ticks, Tick};
use crate::money::Dec;
use crate::exchange::{Exchange, ExError, Kind, MarketSpec, Source};
use crate::intake::wall_ms;
use crate::units::{nano_from_f64, nano_from_feed};
use impulse_engine::Status;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const HL: &str = "https://api.hyperliquid.xyz/info";
const PM_CLOB: &str = "https://clob.polymarket.com";
const PM_GAMMA: &str = "https://gamma-api.polymarket.com";

pub fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(Duration::from_secs(8)).build().expect("http client")
}

async fn send(req: reqwest::RequestBuilder, url: &str) -> Result<Value, String> {
    let res = req.send().await.map_err(|e| format!("{url}: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("{url}: HTTP {}", res.status().as_u16()));
    }
    res.json::<Value>().await.map_err(|e| format!("{url}: {e}"))
}

async fn get_json(http: &reqwest::Client, url: &str) -> Result<Value, String> {
    send(http.get(url), url).await
}

async fn post_json(http: &reqwest::Client, url: &str, body: Value) -> Result<Value, String> {
    send(http.post(url).json(&body), url).await
}

async fn hl(http: &reqwest::Client, mut body: Value, dex: Option<&str>) -> Result<Value, String> {
    if let Some(d) = dex {
        body["dex"] = json!(d);
    }
    post_json(http, HL, body).await
}

pub struct HlInfo {
    sz_decimals: u32,
}

pub async fn hl_meta(http: &reqwest::Client, dex: Option<&str>) -> Result<HashMap<String, HlInfo>, String> {
    let meta = hl(http, json!({ "type": "meta" }), dex).await?;
    let universe = meta["universe"].as_array().ok_or("hyperliquid meta: no universe")?;
    Ok(universe
        .iter()
        .filter(|u| u["isDelisted"] != json!(true))
        .filter_map(|u| Some((u["name"].as_str()?.to_string(), HlInfo { sz_decimals: u["szDecimals"].as_u64()? as u32 })))
        .collect())
}

pub async fn hl_mids(http: &reqwest::Client, dex: Option<&str>) -> Result<HashMap<String, Value>, String> {
    let mids = hl(http, json!({ "type": "allMids" }), dex).await?;
    Ok(mids.as_object().ok_or("hyperliquid allMids: not an object")?.clone().into_iter().collect())
}

async fn hl_candles(http: &reqwest::Client, coin: &str, minutes: i64) -> Result<Vec<Value>, String> {
    let end = wall_ms();
    let r = hl(http, json!({ "type": "candleSnapshot", "req": { "coin": coin, "interval": "1m", "startTime": end - minutes * 60_000, "endTime": end } }), None).await?;
    Ok(r.as_array().cloned().unwrap_or_default())
}

pub struct PmMarket {
    id: String,
    question: String,
    slug: String,
    end_date: String,
    outcomes: Vec<String>,
    prices: Vec<f64>,
    tokens: Vec<String>,
    closed: bool,
}

fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn parse_pm(raw: &Value) -> PmMarket {
    // Gamma returns these arrays as JSON-encoded strings.
    let arr = |v: &Value| -> Vec<Value> {
        match v {
            Value::String(s) => serde_json::from_str::<Vec<Value>>(s).unwrap_or_default(),
            Value::Array(a) => a.clone(),
            _ => vec![],
        }
    };
    PmMarket {
        id: text(&raw["id"]),
        question: text(&raw["question"]),
        slug: text(&raw["slug"]),
        end_date: text(&raw["endDate"]),
        outcomes: arr(&raw["outcomes"]).iter().map(text).collect(),
        prices: arr(&raw["outcomePrices"]).iter().map(|p| text(p).trim().parse().unwrap_or(f64::NAN)).collect(),
        tokens: arr(&raw["clobTokenIds"]).iter().map(text).collect(),
        closed: raw["closed"] == json!(true),
    }
}

/// Liquid, undecided markets that don't end for a while: the ones a leveraged mirror makes sense on.
async fn pick_polymarkets(http: &reqwest::Client, n: usize) -> Result<Vec<PmMarket>, String> {
    let min_end = format!("{}Z", iso_utc(wall_ms() + 3 * 86_400_000));
    let url = format!("{PM_GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=60&end_date_min={min_end}");
    let raw = get_json(http, &url).await?;
    Ok(raw
        .as_array()
        .map(|a| a.iter().map(parse_pm).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .filter(|m| m.tokens.len() == 2 && m.prices.first().is_some_and(|p| (0.08..=0.92).contains(p)))
        .take(n)
        .collect())
}

async fn pm_market(http: &reqwest::Client, id: &str) -> Result<PmMarket, String> {
    Ok(parse_pm(&get_json(http, &format!("{PM_GAMMA}/markets/{id}")).await?))
}

async fn pm_midpoints(http: &reqwest::Client, tokens: &[String]) -> Result<HashMap<String, Value>, String> {
    let body = Value::Array(tokens.iter().map(|t| json!({ "token_id": t })).collect());
    let r = post_json(http, &format!("{PM_CLOB}/midpoints"), body).await?;
    Ok(r.as_object().cloned().unwrap_or_default().into_iter().collect())
}

async fn pm_history(http: &reqwest::Client, token: &str) -> Result<Vec<(i64, f64)>, String> {
    let r = get_json(http, &format!("{PM_CLOB}/prices-history?market={token}&interval=1d&fidelity=1")).await?;
    Ok(r["history"].as_array().map_or(vec![], |h| h.iter().filter_map(|p| Some((p["t"].as_i64()?, p["p"].as_f64()?))).collect()))
}

/// A feed price, string or JSON number, as nano-USD.
fn feed_nano(v: &Value) -> Result<i128, String> {
    match v {
        Value::String(s) => nano_from_feed(s),
        Value::Number(n) => nano_from_f64(n.as_f64().unwrap_or(f64::NAN)),
        other => Err(format!("bad feed price {other}")),
    }
}

fn price3(p: f64) -> String {
    format!("{:.3}", (p * 1000.0).round() / 1000.0)
}

// ---------- default listings ----------

struct HlListing {
    coin: &'static str,
    dex: Option<&'static str>,
    id: &'static str,
    name: &'static str,
    base: &'static str,
    fallback: &'static str,
}

const HL_LISTINGS: [HlListing; 7] = [
    HlListing { coin: "BTC", dex: None, id: "BTC-PERP", name: "Bitcoin", base: "BTC", fallback: "80000" },
    HlListing { coin: "ETH", dex: None, id: "ETH-PERP", name: "Ether", base: "ETH", fallback: "2400" },
    HlListing { coin: "SOL", dex: None, id: "SOL-PERP", name: "Solana", base: "SOL", fallback: "100" },
    HlListing { coin: "HYPE", dex: None, id: "HYPE-PERP", name: "Hyperliquid", base: "HYPE", fallback: "75" },
    HlListing { coin: "kPEPE", dex: None, id: "kPEPE-PERP", name: "1000 PEPE (memecoin)", base: "kPEPE", fallback: "0.0044" },
    HlListing { coin: "FARTCOIN", dex: None, id: "FARTCOIN-PERP", name: "Fartcoin (memecoin)", base: "FARTCOIN", fallback: "0.13" },
    HlListing { coin: "xyz:AAPL", dex: Some("xyz"), id: "AAPL-PERP", name: "Apple (HIP-3 equity perp)", base: "AAPL", fallback: "345" },
];

const ATTENTION: [(&str, &str); 2] = [
    ("@moonboy", "Attention token for a fictional degen influencer. Spot trades on Mirror's xy=k curve; the perp's oracle is that spot price (10-minute TWAP)."),
    ("@anon_dev", "Attention token with an instant oracle: the perp marks to the curve's spot price with no smoothing, the configuration the pump-attack sweep shows is exploitable."),
];

fn pm_spec(pm: &PmMarket, price: f64) -> MarketSpec {
    let outcome = pm.outcomes.first().cloned();
    MarketSpec {
        name: Some(pm.question.clone()),
        base: Some(outcome.clone().unwrap_or_else(|| "YES".into())),
        price: Dec::parse(&price3(price)).ok(),
        description: Some(format!(
            "Leveraged mirror of a Polymarket outcome: the oracle is Polymarket's midpoint for \"{}\", and it settles when Polymarket resolves. Polymarket ends {}.",
            outcome.clone().unwrap_or_else(|| "undefined".into()),
            pm.end_date.chars().take(10).collect::<String>()
        )),
        url: (!pm.slug.is_empty()).then(|| format!("https://polymarket.com/market/{}", pm.slug)),
        ..MarketSpec::new(
            format!("PM-{}", pm.id),
            Kind::Binary,
            Source::Polymarket { market_id: pm.id.clone(), token_id: pm.tokens[0].clone(), outcome: outcome.unwrap_or_else(|| "Yes".into()) },
        )
    }
}

/// List the default markets on a fresh exchange. Falls back to simulated prices for anything unreachable.
pub async fn list_defaults(app: &App, offline: bool) {
    let mut metas: HashMap<&str, HashMap<String, HlInfo>> = HashMap::new();
    let mut mids: HashMap<&str, HashMap<String, Value>> = HashMap::new();
    if !offline {
        for dex in [None, Some("xyz")] {
            let got = async { Ok::<_, String>((hl_meta(&app.http, dex).await?, hl_mids(&app.http, dex).await?)) }.await;
            match got {
                Ok((meta, mid)) => {
                    metas.insert(dex.unwrap_or(""), meta);
                    mids.insert(dex.unwrap_or(""), mid);
                }
                Err(e) => log(&format!("hyperliquid{} unreachable, using simulated prices: {e}", dex.map(|d| format!(" ({d})")).unwrap_or_default())),
            }
        }
    }
    let mut specs = vec![];
    for l in &HL_LISTINGS {
        let dex = l.dex.unwrap_or("");
        let info = metas.get(dex).and_then(|m| m.get(l.coin));
        let mid = mids.get(dex).and_then(|m| m.get(l.coin)).map(text);
        let live = info.is_some() && mid.is_some();
        let fallback: f64 = l.fallback.parse().unwrap_or(0.0);
        specs.push(MarketSpec {
            name: Some(l.name.into()),
            base: Some(l.base.into()),
            sz_decimals: Some(info.map_or(
                if fallback > 1000.0 {
                    4
                } else if fallback > 10.0 {
                    2
                } else {
                    0
                },
                |i| i.sz_decimals,
            )),
            price: Dec::parse(if live { mid.as_deref().unwrap_or_default() } else { l.fallback }).ok(),
            description: Some(if live {
                format!("Mirrors Hyperliquid's {} mid price as the oracle. Liquidity comes from Impulse's own order book.", l.coin)
            } else {
                "Simulated price (Hyperliquid was unreachable at listing).".into()
            }),
            url: live.then(|| format!("https://app.hyperliquid.xyz/trade/{}", l.coin)),
            ..MarketSpec::new(
                l.id,
                Kind::Perp,
                if live { Source::Hyperliquid { coin: l.coin.into(), dex: l.dex.map(Into::into) } } else { Source::Sim { vol_bps: 15.0 } },
            )
        });
    }

    let mut pms = vec![];
    if !offline {
        match pick_polymarkets(&app.http, 4).await {
            Ok(p) => pms = p,
            Err(e) => log(&format!("polymarket unreachable, using a simulated binary: {e}")),
        }
    }
    for pm in &pms {
        specs.push(pm_spec(pm, pm.prices[0]));
    }
    if pms.is_empty() {
        specs.push(MarketSpec {
            name: Some("Simulated election (binary)".into()),
            base: Some("YES".into()),
            price: Dec::parse("0.5").ok(),
            ..MarketSpec::new("SIM-ELECTION", Kind::Binary, Source::Sim { vol_bps: 40.0 })
        });
    }
    specs.push(MarketSpec {
        name: Some("Stripe (pre-IPO)".into()),
        base: Some("STRIPE".into()),
        sz_decimals: Some(2),
        price: Dec::parse("91.50").ok(),
        description: Some(
            "Pre-IPO perp on Stripe. There is no outside price: the mark is the median of this market's own best bid, best ask and last trade. Seeded at $91.50 a share, about a $91.5B valuation at 1B shares. At the IPO the admin sets the public price and the mark gaps to it."
                .into(),
        ),
        ..MarketSpec::new("STRIPE-PRE", Kind::Preipo, Source::Book)
    });
    for (handle, description) in ATTENTION {
        specs.push(MarketSpec {
            name: Some(format!("{handle} attention token")),
            base: Some(handle.into()),
            oracle_window: Some(if handle == "@moonboy" { 600.0 } else { 0.0 }),
            description: Some(description.into()),
            ..MarketSpec::new(handle, Kind::Attention, Source::Curve)
        });
    }

    {
        let mut node = app.lock();
        for spec in specs {
            let id = spec.id.clone();
            if let Err(e) = node.submit(ListMarket { spec: Box::new(spec) }) {
                log(&format!("could not list {id}: {}", e.message()));
            }
        }
    }
    // Chart history is cosmetic: fetch it in the background so the server starts listening right away.
    if !offline {
        tokio::spawn(backfill(app.clone(), None));
    }
}

fn to_ex(e: String) -> ExError {
    ExError::bad(e)
}

/// Mirror one Polymarket market by URL, slug or numeric id. The perp tracks the first outcome ("Yes").
pub async fn list_polymarket(app: &App, reference: &str) -> Result<String, ExError> {
    let mut slug = reference.trim();
    for prefix in ["http://", "https://"] {
        if let Some(rest) = slug.strip_prefix(prefix) {
            // strip the host and the /event/ or /market/ segment
            if let Some((_, path)) = rest.split_once('/') {
                if let Some(p) = path.strip_prefix("event/").or_else(|| path.strip_prefix("market/")) {
                    slug = p;
                }
            }
        }
    }
    let slug = slug.split(['/', '?', '#']).next().unwrap_or("").to_string();
    let pm = if !slug.is_empty() && slug.bytes().all(|b| b.is_ascii_digit()) {
        pm_market(&app.http, &slug).await.map_err(to_ex)?
    } else {
        let found = get_json(&app.http, &format!("{PM_GAMMA}/markets?slug={}", encode_uri_component(&slug))).await.map_err(to_ex)?;
        match found.as_array().and_then(|a| a.first()) {
            Some(raw) => parse_pm(raw),
            None => return Err(ExError::bad(format!("no Polymarket market with slug \"{slug}\" (event pages hold several markets: use a market's own URL or id)"))),
        }
    };
    if pm.closed {
        return Err(ExError::bad(format!("Polymarket market {} is already closed", pm.id)));
    }
    if pm.tokens.len() != 2 {
        return Err(ExError::bad(format!("Polymarket market {} isn't a two-outcome market", pm.id)));
    }
    let mids = pm_midpoints(&app.http, &pm.tokens[..1]).await.map_err(to_ex)?;
    let mid = mids.get(&pm.tokens[0]).map(|v| text(v).parse::<f64>().unwrap_or(f64::NAN)).unwrap_or_else(|| pm.prices.first().copied().unwrap_or(f64::NAN));
    let spec = MarketSpec { creator: Some("admin".into()), ..pm_spec(&pm, mid) };
    let id = app.lock().submit(ListMarket { spec: Box::new(spec) })?;
    tokio::spawn(backfill(app.clone(), Some(vec![id.clone()])));
    Ok(id)
}

/// Mirror one Hyperliquid perp (e.g. "DOGE", or "xyz:TSLA" for a HIP-3 market).
pub async fn list_hyperliquid(app: &App, coin: &str) -> Result<String, ExError> {
    let dex = coin.split_once(':').map(|(d, _)| d.to_string());
    let (meta, mids) = tokio::try_join!(hl_meta(&app.http, dex.as_deref()), hl_mids(&app.http, dex.as_deref())).map_err(to_ex)?;
    let (Some(info), Some(mid)) = (meta.get(coin), mids.get(coin)) else {
        return Err(ExError::bad(format!("Hyperliquid has no live perp \"{coin}\"")));
    };
    let base = coin.rsplit_once(':').map_or(coin, |(_, b)| b).to_string();
    let spec = MarketSpec {
        name: Some(format!("{base}{}", dex.as_ref().map(|d| format!(" (HIP-3, {d})")).unwrap_or_default())),
        base: Some(base.clone()),
        sz_decimals: Some(info.sz_decimals),
        price: Dec::parse(&text(mid)).ok(),
        description: Some(format!("Mirrors Hyperliquid's {coin} mid price as the oracle. Liquidity comes from Impulse's own order book.")),
        url: Some(format!("https://app.hyperliquid.xyz/trade/{coin}")),
        creator: Some("admin".into()),
        ..MarketSpec::new(format!("{base}-PERP"), Kind::Perp, Source::Hyperliquid { coin: coin.into(), dex })
    };
    let id = app.lock().submit(ListMarket { spec: Box::new(spec) })?;
    tokio::spawn(backfill(app.clone(), Some(vec![id.clone()])));
    Ok(id)
}

/// Seed charts with recent real history so they aren't empty on day one.
async fn backfill(app: App, only: Option<Vec<String>>) {
    let targets: Vec<(String, Source)> = {
        let node = app.lock();
        node.core.x.markets.values().filter(|m| only.as_ref().is_none_or(|o| o.contains(&m.id))).map(|m| (m.id.clone(), m.source.clone())).collect()
    };
    for (id, source) in targets {
        let points: Result<Vec<(i64, i128, i128, i128, i128)>, String> = match &source {
            Source::Hyperliquid { coin, .. } => hl_candles(&app.http, coin, 360).await.map(|cs| {
                cs.iter()
                    .filter_map(|c| Some((c["t"].as_i64()?, feed_nano(&c["o"]).ok()?, feed_nano(&c["h"]).ok()?, feed_nano(&c["l"]).ok()?, feed_nano(&c["c"]).ok()?)))
                    .collect()
            }),
            Source::Polymarket { token_id, .. } => pm_history(&app.http, token_id)
                .await
                .map(|h| h.iter().filter_map(|&(t, p)| nano_from_f64(p).ok().map(|n| (t * 1000, n, n, n, n))).collect()),
            _ => continue,
        };
        match points {
            Ok(pts) => {
                let bars = pts.into_iter().map(|(t, o, h, l, c)| Bar { t, o, h, l, c }).collect();
                if let Err(e) = app.lock().submit(History { market: id.clone(), bars }) {
                    log(&format!("history for {id}: {}", e.message()));
                }
            }
            Err(e) => log(&format!("no history for {id}: {e}")),
        }
    }
}

// ---------- the runner ----------

/// One warning per source per minute, so a dead feed doesn't flood the log.
#[derive(Clone, Default)]
pub struct Warn(Arc<Mutex<HashMap<String, Instant>>>);

impl Warn {
    pub fn warn(&self, source: &str, msg: &str) {
        let mut last = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if last.get(source).is_some_and(|t| t.elapsed() < Duration::from_secs(60)) {
            return;
        }
        last.insert(source.into(), Instant::now());
        log(&format!("{source}: {msg}"));
    }
}

fn open_markets(x: &Exchange, pred: impl Fn(&Source) -> bool) -> Vec<(String, Source)> {
    x.markets.values().filter(|m| pred(&m.source) && x.state.markets[&m.id].status == Status::Open).map(|m| (m.id.clone(), m.source.clone())).collect()
}

/// Submit a feed poll's prices as one Ticks command; warn about any the feed sent badly or the exchange refused.
fn submit_ticks(node: &mut Node, warn: &Warn, prices: Vec<(String, &Value)>) {
    let mut ticks = vec![];
    for (id, price) in prices {
        match feed_nano(price) {
            Ok(price) => ticks.push(Tick { market: id, price }),
            Err(e) => warn.warn(&format!("tick {id}"), &e),
        }
    }
    if ticks.is_empty() {
        return;
    }
    match node.submit(Ticks { ticks }) {
        Ok(refused) => {
            for (id, e) in refused {
                warn.warn(&format!("tick {id}"), e.message());
            }
        }
        Err(e) => warn.warn("ticks", e.message()),
    }
}

async fn poll_hyperliquid(app: &App, warn: &Warn) -> Result<(), String> {
    let markets = open_markets(&app.lock().core.x, |s| matches!(s, Source::Hyperliquid { .. }));
    let dexes: BTreeSet<Option<String>> = markets.iter().map(|(_, s)| if let Source::Hyperliquid { dex, .. } = s { dex.clone() } else { None }).collect();
    for dex in dexes {
        let mids = hl_mids(&app.http, dex.as_deref()).await?;
        let prices = markets
            .iter()
            .filter_map(|(id, source)| match source {
                Source::Hyperliquid { coin, dex: d } if *d == dex => mids.get(coin).map(|mid| (id.clone(), mid)),
                _ => None,
            })
            .collect();
        submit_ticks(&mut app.lock(), warn, prices);
    }
    Ok(())
}

async fn poll_polymarket(app: &App, warn: &Warn) -> Result<(), String> {
    let markets = open_markets(&app.lock().core.x, |s| matches!(s, Source::Polymarket { .. }));
    if markets.is_empty() {
        return Ok(());
    }
    let tokens: Vec<String> = markets.iter().map(|(_, s)| if let Source::Polymarket { token_id, .. } = s { token_id.clone() } else { String::new() }).collect();
    let mids = pm_midpoints(&app.http, &tokens).await?;
    let prices = markets.iter().zip(&tokens).filter_map(|((id, _), token)| mids.get(token).map(|mid| (id.clone(), mid))).collect();
    submit_ticks(&mut app.lock(), warn, prices);
    Ok(())
}

/// Settle a mirrored binary when Polymarket resolves it (outcome price exactly 0, 0.5 or 1).
async fn check_resolutions(app: &App) -> Result<(), String> {
    let markets = open_markets(&app.lock().core.x, |s| matches!(s, Source::Polymarket { .. }));
    for (id, source) in markets {
        let Source::Polymarket { market_id, .. } = source else { continue };
        let pm = pm_market(&app.http, &market_id).await?;
        let Some(&p) = pm.prices.first() else { continue };
        if !pm.closed || ![0.0, 0.5, 1.0].contains(&p) {
            continue;
        }
        let price = Dec::parse(&p.to_string())?;
        app.lock().submit(Resolve { market: id.clone(), price }).map_err(|e| e.message().to_string())?;
        log(&format!("{id} resolved at {p} (Polymarket closed)"));
    }
    Ok(())
}

/// Offline markets: a log-normal walk for perps, a walk in log-odds for binaries. When the server runs offline,
/// markets that mirror Hyperliquid or Polymarket (say, restored from a snapshot taken online) walk too, so their
/// prices don't freeze. The walk's randomness is drawn here, at intake; the prices go in as one Ticks command.
pub fn step_sim(node: &mut Node, warn: &Warn, offline: bool) {
    let (x, rng) = (&node.core.x, &mut node.intake.sim);
    let mut prices = vec![];
    let walking = open_markets(x, |s| match s {
        Source::Sim { .. } => true,
        Source::Hyperliquid { .. } | Source::Polymarket { .. } => offline,
        _ => false,
    });
    for (id, source) in walking {
        let vol_bps = match source {
            Source::Sim { vol_bps } => vol_bps,
            Source::Polymarket { .. } => 40.0, // what a fresh offline exchange gives its simulated binary
            _ => 15.0,                          // and its simulated perps
        };
        let meta = &x.markets[&id];
        let Some(mark) = x.state.markets[&id].mark else { continue };
        let cur = mark as f64 * 10f64.powi(meta.sz_decimals as i32) / 1e9; // coin price
        let u = rng.next();
        let z = (-2.0 * (if u == 0.0 { 1e-9 } else { u }).ln()).sqrt() * (2.0 * std::f64::consts::PI * rng.next()).cos();
        let step = (vol_bps / 10_000.0) * z;
        let next = if meta.kind == Kind::Binary {
            let p = cur.clamp(0.01, 0.99);
            let logit = (p / (1.0 - p)).ln() + step * 4.0;
            (1.0 / (1.0 + (-logit).exp())).clamp(0.01, 0.99)
        } else {
            cur * step.exp()
        };
        prices.push((id, json!(format!("{next:.9}"))));
    }
    submit_ticks(node, warn, prices.iter().map(|(id, p)| (id.clone(), p)).collect());
}

/// Network feeds; the random walk runs separately (it also runs offline).
pub fn start(app: &App, warn: &Warn) {
    fn every<F, Fut>(ms: u64, app: App, warn: Warn, name: &'static str, f: F)
    where
        F: Fn(App, Warn) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<(), String>> + Send,
    {
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_millis(ms));
            iv.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                iv.tick().await;
                if let Err(e) = f(app.clone(), warn.clone()).await {
                    warn.warn(name, &e);
                }
            }
        });
    }
    every(3000, app.clone(), warn.clone(), "pollHyperliquid", |a, w| async move { poll_hyperliquid(&a, &w).await });
    every(5000, app.clone(), warn.clone(), "pollPolymarket", |a, w| async move { poll_polymarket(&a, &w).await });
    every(60_000, app.clone(), warn.clone(), "checkResolutions", |a, _| async move { check_resolutions(&a).await });
}

// ---------- small formatting helpers ----------

/// "YYYY-MM-DDTHH:MM:SS" in UTC.
pub fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}", sod / 3600, sod % 3600 / 60, sod % 60)
}

fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn iso() {
        assert_eq!(super::iso_utc(0), "1970-01-01T00:00:00");
        assert_eq!(super::iso_utc(1_793_000_000_000), "2026-10-26T07:33:20");
    }
}
