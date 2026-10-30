// JSON views of exchange state for the API and websocket. Money and prices go out as exact decimal strings
// (USD, USD per coin) and sizes in coins; the engine's lots and nano units never leave the server.

use crate::book::{Order, Side, Tif};
use crate::exchange::{Exchange, Fill, FillKind, Kind, MarketMeta, RiskEvent, Source};
use crate::units::{coin_price, coins_from_lots, fmt, pow10, tick_decimals, usd};
use impulse_engine::{
    depth, equity, initial_margin, leverage_now, maintenance_margin, open_interest, releasable, spot_price, taper_progress, unrealized, AdlPolicy, Market, Position,
    Status, FUNDING_BASE_PPB, GRADUATION, PPB,
};
use serde::Serialize;

const DAY: i64 = 86_400_000;

fn px(meta: &MarketMeta, lot: Option<i128>) -> Option<String> {
    lot.map(|l| fmt(coin_price(meta.sz_decimals, l), 0))
}

fn signed_coins(meta: &MarketMeta, lots: i128) -> String {
    format!("{}{}", if lots < 0 { "-" } else { "" }, coins_from_lots(meta.sz_decimals, lots.abs()))
}

fn ratio(v: i128) -> f64 {
    v as f64 / PPB as f64
}

pub fn source_label(meta: &MarketMeta) -> String {
    match &meta.source {
        Source::Hyperliquid { coin, .. } => format!("Hyperliquid mid {coin}"),
        Source::Polymarket { outcome, .. } => format!("Polymarket midpoint ({outcome})"),
        Source::Curve => "own xy=k spot curve".into(),
        Source::Sim { .. } => "simulated random walk".into(),
        Source::Manual => "admin-set".into(),
    }
}

#[derive(Serialize)]
pub struct SourceView<'a> {
    #[serde(flatten)]
    source: &'a Source,
    label: String,
}

#[derive(Serialize)]
pub struct TierView {
    leverage: i128,
    volume: String,
    depth: String,
}

#[derive(Serialize)]
pub struct GraduationView {
    next: Option<TierView>,
    volume: String,
    depth: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FundingView {
    enabled: bool,
    rate_per_hour: f64, // positive: longs pay shorts
    base_rate_per_hour: f64,
}

#[derive(Serialize)]
pub struct TaperView {
    seconds: i128,
    progress: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurveView {
    price: Option<String>,
    usdc_in: String,
    tokens_sold: String,
    supply: String,
    fee_bps: i128,
    oracle_window: i128,
    market_cap: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketView<'a> {
    id: &'a str,
    name: &'a str,
    kind: Kind,
    base: &'a str,
    description: &'a str,
    url: &'a Option<String>,
    creator: &'a Option<String>,
    source: SourceView<'a>,
    status: Status,
    sz_decimals: u32,
    tick: String,
    price_decimals: u32,
    bounds: [Option<String>; 2],
    mark: Option<String>,
    last: Option<String>,
    open24h: Option<String>,
    best_bid: Option<String>,
    best_ask: Option<String>,
    volume24h: String,
    volume: String,
    open_interest: String,
    open_interest_usd: String,
    max_leverage: i128,
    maintenance_leverage: i128,
    tier: usize,
    graduation: Option<GraduationView>,
    funding: FundingView,
    adl: AdlPolicy,
    resolvable: bool,
    resolves_at: Option<i64>,
    taper: Option<TaperView>,
    curve: Option<CurveView>,
    held_until: Option<i64>,
    created_at: i64,
    positions: usize,
}

pub fn market_view<'a>(x: &'a Exchange, id: &str) -> MarketView<'a> {
    let meta = &x.markets[id];
    let m = &x.state.markets[id];
    let now = x.now();
    let (max_lev, maint_lev) = leverage_now(m);
    let oi = open_interest(m);
    let candles = x.candles.get(id).map(|c| c.as_slice()).unwrap_or(&[]);
    let day_ago = candles.iter().find(|c| c.t >= now - DAY);
    let volume24h: i128 = candles.iter().filter(|c| c.t >= now - DAY).map(|c| c.v).sum();
    let book = &x.books[id];
    let last = x.fills.iter().rev().find(|f| f.market == id && f.kind == FillKind::Perp);
    MarketView {
        id: &meta.id,
        name: &meta.name,
        kind: meta.kind,
        base: &meta.base,
        description: &meta.description,
        url: &meta.url,
        creator: &meta.creator,
        source: SourceView { source: &meta.source, label: source_label(meta) },
        status: m.status,
        sz_decimals: meta.sz_decimals,
        tick: fmt(meta.tick, 0),
        price_decimals: tick_decimals(meta.tick),
        bounds: [px(meta, Some(m.config.lower)), px(meta, m.config.upper)],
        mark: px(meta, m.mark),
        last: last.and_then(|f| px(meta, Some(f.price))),
        open24h: day_ago.and_then(|c| px(meta, Some(c.o))),
        best_bid: book.best(Side::Buy).and_then(|o| px(meta, Some(o.price))),
        best_ask: book.best(Side::Sell).and_then(|o| px(meta, Some(o.price))),
        volume24h: usd(volume24h),
        volume: usd(m.volume),
        open_interest: coins_from_lots(meta.sz_decimals, oi),
        open_interest_usd: usd(oi * m.mark.unwrap_or(0)),
        max_leverage: max_lev,
        maintenance_leverage: maint_lev,
        tier: m.tier,
        graduation: m.config.graduation.then(|| GraduationView {
            next: GRADUATION.get(m.tier).map(|t| TierView { leverage: t.leverage, volume: usd(t.volume), depth: usd(t.depth) }),
            volume: usd(m.volume),
            depth: usd(depth(m)),
        }),
        funding: FundingView {
            enabled: m.config.funding,
            rate_per_hour: ratio(m.funding_rate),
            base_rate_per_hour: if m.config.funding { ratio(FUNDING_BASE_PPB[m.tier]) } else { 0.0 },
        },
        adl: m.config.adl,
        resolvable: m.config.resolvable,
        resolves_at: meta.resolves_at_ms,
        taper: (m.config.taper_seconds > 0).then(|| TaperView { seconds: m.config.taper_seconds, progress: ratio(taper_progress(m)) }),
        curve: m.curve.as_ref().map(|c| CurveView {
            price: px(meta, Some(spot_price(c))),
            usdc_in: usd(c.x - c.x0),
            tokens_sold: (c.y0 - c.y).to_string(),
            supply: c.y0.to_string(),
            fee_bps: c.fee_bps,
            oracle_window: m.oracle.as_ref().map_or(0, |o| o.window),
            market_cap: usd(spot_price(c) * c.y0),
        }),
        held_until: meta.held_until,
        created_at: meta.created_at,
        positions: m.positions.values().filter(|p| p.size != 0).count(),
    }
}

pub fn markets_view(x: &Exchange) -> Vec<MarketView<'_>> {
    x.markets.keys().map(|id| market_view(x, id)).collect()
}

#[derive(Serialize)]
pub struct LevelView {
    price: String,
    size: String,
    orders: usize,
}

#[derive(Serialize)]
pub struct BookView<'a> {
    market: &'a str,
    bids: Vec<LevelView>,
    asks: Vec<LevelView>,
    mark: Option<String>,
}

pub fn book_view<'a>(x: &'a Exchange, id: &str, depth_levels: usize) -> BookView<'a> {
    let meta = &x.markets[id];
    let book = &x.books[id];
    let side = |s: Side| {
        book.levels(s, depth_levels)
            .into_iter()
            .map(|l| LevelView { price: fmt(coin_price(meta.sz_decimals, l.price), 0), size: coins_from_lots(meta.sz_decimals, l.size), orders: l.orders })
            .collect()
    };
    BookView { market: &meta.id, bids: side(Side::Buy), asks: side(Side::Sell), mark: px(meta, x.state.markets[id].mark) }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FillView<'a> {
    id: u64,
    time: i64,
    market: &'a str,
    kind: FillKind,
    price: String,
    size: String,
    notional: String,
    side: Side,
    taker: &'a str,
    maker: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    my_side: Option<Side>,
    #[serde(skip_serializing_if = "Option::is_none")]
    liquidity: Option<&'static str>,
}

pub fn fill_view<'a>(x: &Exchange, f: &'a Fill, viewer: Option<&str>) -> FillView<'a> {
    let meta = &x.markets[&f.market];
    let taker = viewer.map(|v| f.taker == v);
    FillView {
        id: f.id,
        time: f.time,
        market: &f.market,
        kind: f.kind,
        price: fmt(coin_price(meta.sz_decimals, f.price), 0),
        size: coins_from_lots(meta.sz_decimals, f.size),
        notional: usd(f.price * f.size),
        side: f.side,
        taker: &f.taker,
        maker: &f.maker,
        my_side: taker.map(|t| if t { f.side } else { f.side.opposite() }),
        liquidity: taker.map(|t| if t { "taker" } else { "maker" }),
    }
}

pub fn trades_view<'a>(x: &'a Exchange, id: &str, limit: usize) -> Vec<FillView<'a>> {
    x.fills.iter().rev().filter(|f| f.market == id).take(limit).map(|f| fill_view(x, f, None)).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderView<'a> {
    id: u64,
    market: &'a str,
    side: Side,
    price: String,
    size: String,
    filled: String,
    leverage: i128,
    reduce_only: bool,
    tif: Tif,
    time: i64,
}

pub fn order_view<'a>(x: &Exchange, o: &'a Order) -> OrderView<'a> {
    let sz = x.markets[&o.market].sz_decimals;
    OrderView {
        id: o.id,
        market: &o.market,
        side: o.side,
        price: fmt(coin_price(sz, o.price), 0),
        size: coins_from_lots(sz, o.size),
        filled: coins_from_lots(sz, o.filled),
        leverage: o.leverage,
        reduce_only: o.reduce_only,
        tif: o.tif,
        time: o.time,
    }
}

#[derive(Serialize)]
pub struct CandleView {
    t: i64,
    o: f64,
    h: f64,
    l: f64,
    c: f64,
    v: f64,
}

pub fn candles_view(x: &Exchange, id: &str) -> Vec<CandleView> {
    let sz = x.markets[id].sz_decimals;
    let n = |lot: i128| coin_price(sz, lot) as f64 / 1e9;
    x.candles.get(id).map_or(vec![], |cs| cs.iter().map(|c| CandleView { t: c.t, o: n(c.o), h: n(c.h), l: n(c.l), c: n(c.c), v: c.v as f64 / 1e9 }).collect())
}

/// Price at which equity meets a requirement of |size|·P / L (maintenance) or 0 (bankruptcy), ignoring the
/// max-loss cap and any taper. Solves C + q·P − B = |q|·P/L for P, in nano-USD per lot.
fn price_where_equity(p: &Position, lev: Option<i128>) -> Option<i128> {
    let q = p.size;
    if q == 0 {
        return None;
    }
    let num = p.basis - p.collateral;
    // q·P − |q|·P/L = num  →  P = num·L / (q·L − |q|)
    let den = match lev {
        None => q,
        Some(l) => q * l - q.abs(),
    };
    if den == 0 {
        return None;
    }
    // BigInt division truncates toward zero, like Rust's.
    let price = match lev {
        None => num / q,
        Some(l) => (num * l) / den,
    };
    (price > 0).then_some(price)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionView<'a> {
    market: &'a str,
    kind: Kind,
    size: String,
    side: &'static str,
    entry: Option<String>,
    mark: Option<String>,
    notional: String,
    collateral: String,
    equity: String,
    unrealized: String,
    realized: String,
    funding: String,
    adl: String, // − haircuts paid as absorber, + shortfall covered as bankrupt
    allocated: String,
    pnl: String, // everything since the bucket opened: trading, funding and ADL
    initial_margin: String,
    maintenance_margin: String,
    leverage: Option<f64>,
    liquidation_price: Option<String>,
    bankruptcy_price: Option<String>,
    releasable: String,
}

pub fn position_view<'a>(meta: &'a MarketMeta, m: &Market, p: &Position) -> PositionView<'a> {
    let mark = m.mark;
    let eq = if mark.is_none() && p.size != 0 { 0 } else { equity(p, mark) };
    let notional = mark.map_or(0, |mk| p.size.abs() * mk);
    let (_, maint) = leverage_now(m);
    let entry = (p.size != 0).then(|| (p.basis.abs() * pow10(meta.sz_decimals)) / p.size.abs());
    let open = p.size != 0;
    PositionView {
        market: &meta.id,
        kind: meta.kind,
        size: signed_coins(meta, p.size),
        side: if p.size > 0 {
            "long"
        } else if p.size < 0 {
            "short"
        } else {
            "flat"
        },
        entry: entry.map(|e| fmt(e, 0)),
        mark: px(meta, mark),
        notional: usd(notional),
        collateral: usd(p.collateral),
        equity: usd(eq),
        unrealized: usd(if open { unrealized(p, mark) } else { 0 }),
        realized: usd(p.realized),
        funding: usd(p.funding),
        adl: usd(p.adl_transfer),
        allocated: usd(p.allocated),
        pnl: usd(eq - p.allocated),
        initial_margin: usd(if open { initial_margin(m, p) } else { 0 }),
        maintenance_margin: usd(if open { maintenance_margin(m, p) } else { 0 }),
        leverage: (eq > 0).then(|| ((notional * 100) / eq) as f64 / 100.0),
        liquidation_price: px(meta, price_where_equity(p, Some(maint))),
        bankruptcy_price: px(meta, price_where_equity(p, None)),
        releasable: usd(if open { releasable(m, p) } else { 0 }),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerView {
    realized: String,
    funding: String,
    adl_paid: String,
    adl_covered: String,
}

#[derive(Serialize)]
pub struct SpotView<'a> {
    market: &'a str,
    tokens: String,
    value: String,
    price: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountView<'a> {
    id: &'a str,
    bot: bool,
    created_at: i64,
    next_faucet: i64,
    wallet: String,
    deposited: String,
    withdrawn: String,
    equity: String,
    pnl: String,
    positions: Vec<PositionView<'a>>,
    ledger: LedgerView,
    spot: Vec<SpotView<'a>>,
    orders: Vec<OrderView<'a>>,
    fills: Vec<FillView<'a>>,
    risk: Vec<&'a RiskEvent>,
}

pub fn account_view<'a>(x: &'a Exchange, id: &'a str) -> AccountView<'a> {
    let meta = &x.accounts[id];
    let a = x.state.accounts.get(id);
    let wallet = a.map_or(0, |a| a.wallet);
    let mut total = wallet;
    let mut positions = vec![];
    // Lifetime ledger across every market the account ever touched, including ones it has left.
    let (mut realized, mut funding, mut adl_paid, mut adl_covered) = (0, 0, 0, 0);
    let mut ids: Vec<&String> = x.markets.keys().collect();
    ids.sort();
    for mid in ids {
        let m = &x.state.markets[mid];
        let Some(p) = m.positions.get(id) else { continue };
        realized += p.realized;
        funding += p.funding;
        if p.adl_transfer < 0 {
            adl_paid -= p.adl_transfer;
        } else {
            adl_covered += p.adl_transfer;
        }
        if p.size == 0 && p.collateral == 0 {
            continue;
        }
        positions.push(position_view(&x.markets[mid], m, p));
        total += equity(p, m.mark);
    }
    let mut spot = vec![];
    for (mid, &tokens) in a.map(|a| &a.spot).into_iter().flatten() {
        let Some(c) = x.state.markets.get(mid).and_then(|m| m.curve.as_ref()) else { continue };
        if tokens == 0 {
            continue;
        }
        let value = tokens * spot_price(c);
        total += value;
        spot.push(SpotView { market: mid, tokens: tokens.to_string(), value: usd(value), price: px(&x.markets[mid], Some(spot_price(c))) });
    }
    let fills = x.fills.iter().rev().filter(|f| f.taker == id || f.maker == id).take(100).map(|f| fill_view(x, f, Some(id))).collect();
    let mut risk: Vec<&RiskEvent> = x.risk.iter().filter(|r| r.accounts.iter().any(|a| a == id)).collect();
    risk = risk.split_off(risk.len().saturating_sub(100));
    risk.reverse();
    let deposited = a.map_or(0, |a| a.deposited);
    let withdrawn = a.map_or(0, |a| a.withdrawn);
    AccountView {
        id: &meta.id,
        bot: meta.bot,
        created_at: meta.created_at,
        next_faucet: meta.last_faucet + 60_000,
        wallet: usd(wallet),
        deposited: usd(deposited),
        withdrawn: usd(withdrawn),
        equity: usd(total),
        pnl: usd(total - (deposited - withdrawn)),
        positions,
        ledger: LedgerView { realized: usd(realized), funding: usd(funding), adl_paid: usd(adl_paid), adl_covered: usd(adl_covered) },
        spot,
        orders: x.orders_of(id, None).map(|o| order_view(x, o)).collect(),
        fills,
        risk,
    }
}

#[derive(Serialize)]
pub struct LeaderRow<'a> {
    id: &'a str,
    bot: bool,
    equity: String,
    pnl: String,
    haircuts: String,
    open: usize,
}

pub fn leaderboard_view(x: &Exchange) -> Vec<LeaderRow<'_>> {
    let mut rows: Vec<(&str, bool, i128, i128, i128, usize)> = x
        .accounts
        .values()
        .map(|meta| {
            let a = x.state.accounts.get(&meta.id);
            let mut total = a.map_or(0, |a| a.wallet);
            let (mut haircuts, mut open) = (0, 0);
            for m in x.state.markets.values() {
                let Some(p) = m.positions.get(&meta.id) else { continue };
                total += equity(p, m.mark);
                if p.adl_transfer < 0 {
                    haircuts -= p.adl_transfer;
                }
                if p.size != 0 {
                    open += 1;
                }
            }
            for (mid, tokens) in a.map(|a| &a.spot).into_iter().flatten() {
                if let Some(c) = x.state.markets.get(mid).and_then(|m| m.curve.as_ref()) {
                    total += tokens * spot_price(c);
                }
            }
            let net_in = a.map_or(0, |a| a.deposited - a.withdrawn);
            (meta.id.as_str(), meta.bot, total, total - net_in, haircuts, open)
        })
        .collect();
    rows.sort_by(|a, b| b.3.cmp(&a.3)); // stable, like Array.prototype.sort
    rows.into_iter().map(|(id, bot, eq, pnl, h, open)| LeaderRow { id, bot, equity: usd(eq), pnl: usd(pnl), haircuts: usd(h), open }).collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    genesis: i64,
    graduation: Vec<TierView>,
    funding_base_per_hour: Vec<f64>,
}

pub fn config_view(x: &Exchange) -> ConfigView {
    ConfigView {
        genesis: x.genesis,
        graduation: GRADUATION.iter().map(|t| TierView { leverage: t.leverage, volume: usd(t.volume), depth: usd(t.depth) }).collect(),
        funding_base_per_hour: FUNDING_BASE_PPB.iter().map(|r| ratio(*r)).collect(),
    }
}

#[derive(Serialize)]
pub struct PublicPosition<'a> {
    account: &'a str,
    size: String,
    collateral: String,
    adl: String,
}

/// The whole market is public, like an on-chain venue: who holds what, and who would absorb a shortfall.
pub fn public_positions<'a>(x: &'a Exchange, id: &str) -> Vec<PublicPosition<'a>> {
    let meta = &x.markets[id];
    x.state.markets[id]
        .positions
        .values()
        .filter(|p| p.size != 0)
        .map(|p| PublicPosition { account: &p.account, size: signed_coins(meta, p.size), collateral: usd(p.collateral), adl: usd(p.adl_transfer) })
        .collect()
}
