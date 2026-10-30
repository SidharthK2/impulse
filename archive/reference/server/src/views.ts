// JSON views of exchange state for the API and websocket. Money and prices go out as exact decimal strings
// (USD, USD per coin) and sizes in coins; the engine's lots and nano units never leave the server.

import {
  FUNDING_BASE_PPB,
  GRADUATION,
  type Market,
  type Position,
  depth,
  equity,
  initialMargin,
  leverageNow,
  maintenanceMargin,
  releasable,
  spotPrice,
  taperProgress,
  unrealized,
} from "../../engine/engine.js";
import { abs } from "../../engine/fixed.js";
import type { Order } from "./book.js";
import type { Exchange, Fill, MarketMeta } from "./exchange.js";
import { coinPrice, coinsFromLots, fmt, pow10, tickDecimals, usd } from "./units.js";

const DAY = 86_400_000;
const PPB = 1e9;

const px = (meta: MarketMeta, lot: bigint | null) => (lot === null ? null : fmt(coinPrice(meta, lot), 0));
const signedCoins = (meta: MarketMeta, lots: bigint) => (lots < 0n ? "-" : "") + coinsFromLots(meta, abs(lots));

function sourceLabel(meta: MarketMeta): string {
  const s = meta.source;
  switch (s.kind) {
    case "hyperliquid":
      return `Hyperliquid mid ${s.coin}`;
    case "polymarket":
      return `Polymarket midpoint (${s.outcome})`;
    case "curve":
      return "own xy=k spot curve";
    case "sim":
      return "simulated random walk";
    case "manual":
      return "admin-set";
  }
}

export function marketView(x: Exchange, id: string) {
  const meta = x.markets[id]!;
  const m = x.state.markets[id]!;
  const now = x.now();
  const lev = leverageNow(m);
  const next = m.config.graduation ? GRADUATION[m.tier] : undefined;
  const oi = Object.values(m.positions).reduce((s, p) => (p.size > 0n ? s + p.size : s), 0n);
  const candles = x.candles[id] ?? [];
  const dayAgo = candles.find((c) => c.t >= now - DAY);
  const volume24h = candles.reduce((s, c) => (c.t >= now - DAY ? s + c.v : s), 0n);
  const book = x.books[id]!;
  const bestBid = book.best("buy");
  const bestAsk = book.best("sell");
  let last: Fill | undefined;
  for (let i = x.fills.length - 1; i >= 0 && !last; i--) if (x.fills[i]!.market === id && x.fills[i]!.kind === "perp") last = x.fills[i];
  return {
    id,
    name: meta.name,
    kind: meta.kind,
    base: meta.base,
    description: meta.description,
    url: meta.url,
    creator: meta.creator,
    source: { ...meta.source, label: sourceLabel(meta) },
    status: m.status,
    szDecimals: meta.szDecimals,
    tick: fmt(meta.tick, 0),
    priceDecimals: tickDecimals(meta.tick),
    bounds: [px(meta, m.config.lower), px(meta, m.config.upper)],
    mark: px(meta, m.mark),
    last: last ? px(meta, last.price) : null,
    open24h: dayAgo ? px(meta, dayAgo.o) : null,
    bestBid: bestBid ? px(meta, bestBid.price) : null,
    bestAsk: bestAsk ? px(meta, bestAsk.price) : null,
    volume24h: usd(volume24h),
    volume: usd(m.volume),
    openInterest: coinsFromLots(meta, oi),
    openInterestUsd: usd(oi * (m.mark ?? 0n)),
    maxLeverage: Number(lev.initial),
    maintenanceLeverage: Number(lev.maintenance),
    tier: m.tier,
    graduation: m.config.graduation
      ? {
          next: next ? { leverage: Number(next.leverage), volume: usd(next.volume), depth: usd(next.depth) } : null,
          volume: usd(m.volume),
          depth: usd(depth(m)),
        }
      : null,
    funding: {
      enabled: m.config.funding,
      ratePerHour: Number(m.fundingRate) / PPB, // positive: longs pay shorts
      baseRatePerHour: m.config.funding ? Number(FUNDING_BASE_PPB[m.tier]!) / PPB : 0,
    },
    adl: m.config.adl,
    resolvable: m.config.resolvable,
    resolvesAt: meta.resolvesAtMs,
    taper: m.config.taperSeconds > 0n ? { seconds: Number(m.config.taperSeconds), progress: Number(taperProgress(m)) / PPB } : null,
    curve: m.curve
      ? {
          price: px(meta, spotPrice(m.curve)),
          usdcIn: usd(m.curve.x - m.curve.x0),
          tokensSold: (m.curve.y0 - m.curve.y).toString(),
          supply: m.curve.y0.toString(),
          feeBps: Number(m.curve.feeBps),
          oracleWindow: Number(m.oracle?.window ?? 0n),
          marketCap: usd(spotPrice(m.curve) * m.curve.y0),
        }
      : null,
    heldUntil: meta.heldUntil,
    createdAt: meta.createdAt,
    positions: Object.values(m.positions).filter((p) => p.size !== 0n).length,
  };
}

export function bookView(x: Exchange, id: string, depthLevels = 20) {
  const meta = x.markets[id]!;
  const book = x.books[id]!;
  const side = (s: "buy" | "sell") => book.levels(s, depthLevels).map((l) => ({ price: px(meta, l.price)!, size: coinsFromLots(meta, l.size), orders: l.orders }));
  return { market: id, bids: side("buy"), asks: side("sell"), mark: px(meta, x.state.markets[id]!.mark) };
}

export function fillView(x: Exchange, f: Fill, viewer?: string) {
  const meta = x.markets[f.market]!;
  return {
    id: f.id,
    time: f.time,
    market: f.market,
    kind: f.kind,
    price: px(meta, f.price)!,
    size: coinsFromLots(meta, f.size),
    notional: usd(f.price * f.size),
    side: f.side,
    taker: f.taker,
    maker: f.maker,
    ...(viewer && { mySide: f.taker === viewer ? f.side : f.side === "buy" ? "sell" : "buy", liquidity: f.taker === viewer ? "taker" : "maker" }),
  };
}

export function tradesView(x: Exchange, id: string, limit = 60) {
  const out = [];
  for (let i = x.fills.length - 1; i >= 0 && out.length < limit; i--) {
    const f = x.fills[i]!;
    if (f.market === id) out.push(fillView(x, f));
  }
  return out;
}

export function orderView(x: Exchange, o: Order) {
  const meta = x.markets[o.market]!;
  return {
    id: o.id,
    market: o.market,
    side: o.side,
    price: px(meta, o.price)!,
    size: coinsFromLots(meta, o.size),
    filled: coinsFromLots(meta, o.filled),
    leverage: Number(o.leverage),
    reduceOnly: o.reduceOnly,
    tif: o.tif,
    time: o.time,
  };
}

export function candlesView(x: Exchange, id: string) {
  const meta = x.markets[id]!;
  const n = (lot: bigint) => Number(coinPrice(meta, lot)) / 1e9;
  return (x.candles[id] ?? []).map((c) => ({ t: c.t, o: n(c.o), h: n(c.h), l: n(c.l), c: n(c.c), v: Number(c.v) / 1e9 }));
}

/**
 * Price at which equity meets a requirement of |size|·P / L (maintenance) or 0 (bankruptcy), ignoring the
 * max-loss cap and any taper. Solves C + q·P − B = |q|·P/L for P, in nano-USD per lot.
 */
function priceWhereEquity(p: Position, lev: bigint | null): bigint | null {
  const q = p.size;
  if (q === 0n) return null;
  const num = p.basis - p.collateral;
  // q·P − |q|·P/L = num  →  P = num·L / (q·L − |q|)
  const den = lev === null ? q : q * lev - abs(q);
  if (den === 0n) return null;
  const P = lev === null ? num / q : (num * lev) / den;
  return P > 0n ? P : null;
}

export function positionView(meta: MarketMeta, m: Market, p: Position) {
  const mark = m.mark;
  const eq = mark === null && p.size !== 0n ? 0n : equity(p, mark);
  const notional = mark === null ? 0n : abs(p.size) * mark;
  const lev = leverageNow(m);
  const entry = p.size === 0n ? null : (abs(p.basis) * pow10(meta.szDecimals)) / abs(p.size);
  return {
    market: meta.id,
    kind: meta.kind,
    size: signedCoins(meta, p.size),
    side: p.size > 0n ? "long" : p.size < 0n ? "short" : "flat",
    entry: entry === null ? null : fmt(entry, 0),
    mark: px(meta, mark),
    notional: usd(notional),
    collateral: usd(p.collateral),
    equity: usd(eq),
    unrealized: usd(p.size === 0n ? 0n : unrealized(p, mark)),
    realized: usd(p.realized),
    funding: usd(p.funding),
    adl: usd(p.adlTransfer), // − haircuts paid as absorber, + shortfall covered as bankrupt
    allocated: usd(p.allocated),
    pnl: usd(eq - p.allocated), // everything since the bucket opened: trading, funding and ADL
    initialMargin: usd(p.size === 0n ? 0n : initialMargin(m, p)),
    maintenanceMargin: usd(p.size === 0n ? 0n : maintenanceMargin(m, p)),
    leverage: eq > 0n ? Number((notional * 100n) / eq) / 100 : null,
    liquidationPrice: px(meta, priceWhereEquity(p, lev.maintenance)),
    bankruptcyPrice: px(meta, priceWhereEquity(p, null)),
    releasable: usd(p.size === 0n ? 0n : releasable(m, p)),
  };
}

export function accountView(x: Exchange, id: string) {
  const meta = x.accounts[id]!;
  const a = x.state.accounts[id];
  const wallet = a?.wallet ?? 0n;
  let total = wallet;
  const positions = [];
  // Lifetime ledger across every market the account ever touched, including ones it has left.
  const ledger = { realized: 0n, funding: 0n, adlPaid: 0n, adlCovered: 0n };
  for (const mid of Object.keys(x.markets).sort()) {
    const m = x.state.markets[mid]!;
    const p = m.positions[id];
    if (p) {
      ledger.realized += p.realized;
      ledger.funding += p.funding;
      if (p.adlTransfer < 0n) ledger.adlPaid -= p.adlTransfer;
      else ledger.adlCovered += p.adlTransfer;
    }
    if (!p || (p.size === 0n && p.collateral === 0n)) continue;
    const v = positionView(x.markets[mid]!, m, p);
    total += equity(p, m.mark);
    positions.push(v);
  }
  const spot = [];
  for (const [mid, tokens] of Object.entries(a?.spot ?? {})) {
    const m = x.state.markets[mid]!;
    if (tokens === 0n || !m.curve) continue;
    const value = tokens * spotPrice(m.curve);
    total += value;
    spot.push({ market: mid, tokens: tokens.toString(), value: usd(value), price: px(x.markets[mid]!, spotPrice(m.curve)) });
  }
  const fills = [];
  for (let i = x.fills.length - 1; i >= 0 && fills.length < 100; i--) {
    const f = x.fills[i]!;
    if (f.taker === id || f.maker === id) fills.push(fillView(x, f, id));
  }
  const risk = x.risk.filter((r) => r.accounts.includes(id)).slice(-100).reverse();
  const deposited = a?.deposited ?? 0n;
  const withdrawn = a?.withdrawn ?? 0n;
  return {
    id,
    bot: meta.bot,
    createdAt: meta.createdAt,
    nextFaucet: meta.lastFaucet + 60_000,
    wallet: usd(wallet),
    deposited: usd(deposited),
    withdrawn: usd(withdrawn),
    equity: usd(total),
    pnl: usd(total - (deposited - withdrawn)),
    positions,
    ledger: { realized: usd(ledger.realized), funding: usd(ledger.funding), adlPaid: usd(ledger.adlPaid), adlCovered: usd(ledger.adlCovered) },
    spot,
    orders: x.ordersOf(id).map((o) => orderView(x, o)),
    fills,
    risk,
  };
}

export function leaderboardView(x: Exchange) {
  const rows = Object.values(x.accounts).map((meta) => {
    const a = x.state.accounts[meta.id];
    let total = a?.wallet ?? 0n;
    let haircuts = 0n;
    let open = 0;
    for (const m of Object.values(x.state.markets)) {
      const p = m.positions[meta.id];
      if (!p) continue;
      total += equity(p, m.mark);
      if (p.adlTransfer < 0n) haircuts += -p.adlTransfer;
      if (p.size !== 0n) open++;
    }
    for (const [mid, tokens] of Object.entries(a?.spot ?? {})) {
      const c = x.state.markets[mid]?.curve;
      if (c) total += tokens * spotPrice(c);
    }
    const netIn = (a?.deposited ?? 0n) - (a?.withdrawn ?? 0n);
    return { id: meta.id, bot: meta.bot, equity: total, pnl: total - netIn, haircuts, open };
  });
  rows.sort((a, b) => (b.pnl > a.pnl ? 1 : b.pnl < a.pnl ? -1 : 0));
  return rows.map((r) => ({ ...r, equity: usd(r.equity), pnl: usd(r.pnl), haircuts: usd(r.haircuts) }));
}

export function configView(x: Exchange) {
  return {
    genesis: x.genesis,
    graduation: GRADUATION.map((t) => ({ leverage: Number(t.leverage), volume: usd(t.volume), depth: usd(t.depth) })),
    fundingBasePerHour: FUNDING_BASE_PPB.map((r) => Number(r) / PPB),
  };
}
