// A small in-browser exchange that speaks the API contract, for building screens before the backend has them.
// Dev only (see store.ts `fixtures`). Prices move, snipes open, pre-IPO markets IPO and crashes charge ADL, so
// every screen has live data with the new MarketView fields, RiskEvent prices and AccountView snipes.

import type {
  AccountView,
  BookView,
  Candle,
  FillView,
  Level,
  MarketView,
  PositionView,
  RiskEvent,
  Setting,
} from "../types";

export interface World {
  now: number;
  markets: Record<string, MarketView>;
  candles: Record<string, Candle[]>;
  books: Record<string, BookView>;
  trades: Record<string, FillView[]>;
  events: RiskEvent[];
  /** The viewer's fixture holdings, merged into whatever account the server returns. */
  positions: PositionView[];
  spot: AccountView["spot"];
  snipes: AccountView["snipes"];
  nextId: number;
  seed: number;
}

// ---------- numbers ----------

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let rand = rng(7);
const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-9)) * Math.cos(2 * Math.PI * rand());

/** Five significant figures, like the server's ticks. */
export const decimalsFor = (p: number) =>
  Math.min(10, Math.max(0, 4 - Math.floor(Math.log10(Math.max(p, 1e-12)))));
const fix = (v: number, d: number) => v.toFixed(d);
const money = (v: number) => v.toFixed(2);

const MIN = 60_000;
const HOUR = 60 * MIN;
const SHARES = 1_000_000_000; // pre-IPO implied valuation = mark × 1B

// Mirror's published curve: $5k virtual USDC against 1B tokens, 1% fee.
const VIRTUAL_USDC = 5000;
const SUPPLY = 1_000_000_000;
const K = VIRTUAL_USDC * SUPPLY;
const FEE = 0.01;
export const curvePrice = (usdcIn: number) => (VIRTUAL_USDC + usdcIn) ** 2 / K;
const tokensFor = (usdcIn: number, add: number) =>
  K / (VIRTUAL_USDC + usdcIn) - K / (VIRTUAL_USDC + usdcIn + add);

const BOTS = ["maker", "ape", "degen", "whale", "scalper"];
const SNIPERS = [
  "maker",
  "whale",
  "ape",
  "degen",
  "scalper",
  "kite",
  "ozzy",
  "pell",
  "rune",
  "juno",
  "tamsin",
  "vex",
];

// ---------- markets ----------

type Spec = Pick<MarketView, "id" | "name" | "kind" | "base"> & Partial<MarketView>;

function market(spec: Spec, mark: number | null, now: number): MarketView {
  const d = decimalsFor(mark ?? 0.00001);
  return {
    description: "",
    url: null,
    creator: null,
    source: { kind: "book", label: "own order book" },
    status: "open",
    szDecimals: mark && mark > 100 ? 4 : mark && mark > 1 ? 2 : 0,
    tick: (10 ** -d).toFixed(d),
    priceDecimals: d,
    bounds: [null, null],
    mark: mark === null ? null : fix(mark, d),
    last: mark === null ? null : fix(mark, d),
    open24h: mark === null ? null : fix(mark, d),
    bestBid: null,
    bestAsk: null,
    volume24h: "0",
    volume: "0",
    openInterest: "0",
    openInterestUsd: "0",
    maxLeverage: 3,
    maintenanceLeverage: 6,
    tier: 0,
    graduation: {
      next: { leverage: 5, volume: "250000", depth: "50000" },
      volume: "0",
      depth: "0",
    },
    funding: { enabled: true, ratePerHour: 0.0005, baseRatePerHour: 0.0005 },
    adl: "pnl",
    resolvable: false,
    resolvesAt: null,
    taper: null,
    curve: null,
    heldUntil: null,
    createdAt: now - 3 * HOUR,
    positions: 0,
    snipe: null,
    launch: null,
    preipo: null,
    settings: [],
    ...spec,
  };
}

const coinSettings = (oracleWindow: number): Setting[] => [
  { label: "Curve reserves", value: "$5k virtual USDC / 1B tokens", ours: false },
  { label: "Spot fee", value: "1%", ours: false },
  { label: "Snipe window", value: "5 min, one open price", ours: true },
  {
    label: "Perp oracle",
    value: oracleWindow === 0 ? "curve, instant" : `${oracleWindow / 60}m TWAP of the curve`,
    ours: true,
  },
  { label: "Start leverage", value: "3×", ours: true },
  { label: "ADL rule", value: "capped pro-rata on profit", ours: true },
];

const preipoSettings: Setting[] = [
  { label: "Price source", value: "own order book (no outside oracle)", ours: true },
  { label: "Implied valuation", value: "mark × 1,000,000,000", ours: true },
  { label: "Start leverage", value: "3×", ours: true },
  { label: "Funding", value: "0.05%/h base, premium on last trade", ours: true },
  { label: "ADL rule", value: "capped pro-rata on profit", ours: true },
];

const perpSettings: Setting[] = [
  { label: "Oracle", value: "Hyperliquid mid", ours: false },
  { label: "Start leverage", value: "3×, graduates to 100×", ours: true },
  { label: "Funding", value: "0.05%/h base", ours: true },
  { label: "ADL rule", value: "capped pro-rata on profit", ours: true },
];

function snipeView(
  opensAt: number,
  bids: { account: string; usdc: number; time: number }[],
): MarketView["snipe"] {
  const total = bids.reduce((s, b) => s + b.usdc, 0);
  const by = new Map<string, number>();
  for (const b of bids) by.set(b.account, (by.get(b.account) ?? 0) + b.usdc);
  const p = curvePrice(total * (1 - FEE));
  return {
    opensAt,
    total: money(total),
    snipers: by.size,
    projectedOpenPrice: fix(p, decimalsFor(p)),
    top: [...by]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([account, usdc]) => ({ account, usdc: money(usdc) })),
    recent: bids
      .toSorted((a, b) => b.time - a.time)
      .slice(0, 10)
      .map((b) => ({ ...b, usdc: money(b.usdc) })),
  };
}

/** Bids behind every fixture snipe, kept outside MarketView (which only exposes the top and latest 10). */
const snipeBids: Record<string, { account: string; usdc: number; time: number }[]> = {};

function newCoin(w: World, handle: string, opensIn: number, seedBids: number): MarketView {
  const id = handle.startsWith("@") ? handle : `@${handle}`;
  const bids: { account: string; usdc: number; time: number }[] = [];
  for (let i = 0; i < seedBids; i++)
    bids.push({
      account: SNIPERS[i % SNIPERS.length]!,
      usdc: Math.round(50 + rand() ** 2 * 1500),
      time: w.now - (seedBids - i) * 9000,
    });
  snipeBids[id] = bids;
  return market(
    {
      id,
      name: `${id} creator coin`,
      kind: "attention",
      base: id.slice(1).toUpperCase(),
      description: `Creator coin for ${id}. Snipe bids pool into one open price; then the coin trades on its curve and the perp marks to it.`,
      creator: "you",
      source: { kind: "curve", label: "own curve, 10m TWAP" },
      szDecimals: 0,
      createdAt: w.now,
      curve: {
        price: fix(curvePrice(0), 10),
        usdcIn: "0",
        tokensSold: "0",
        supply: String(SUPPLY),
        feeBps: 100,
        oracleWindow: 600,
        marketCap: money(curvePrice(0) * SUPPLY),
      },
      snipe: snipeView(w.now + opensIn, bids),
      settings: coinSettings(600),
    },
    null,
    w.now,
  );
}

// ---------- price history ----------

/** Log-space Brownian bridge through anchor points, as 1m candles. A zero-length step between anchors is a gap. */
function history(anchors: { t: number; p: number }[], vol: number): Candle[] {
  const out: Candle[] = [];
  for (let s = 0; s < anchors.length - 1; s++) {
    const a = anchors[s]!;
    const b = anchors[s + 1]!;
    const n = Math.max(1, Math.round((b.t - a.t) / MIN));
    const walk = [0];
    for (let i = 1; i <= n; i++) walk.push(walk[i - 1]! + gauss() * vol);
    for (let i = 0; i < n; i++) {
      const f = i / n;
      const bridge = walk[i]! - f * walk[n]!;
      const c = Math.exp(Math.log(a.p) * (1 - f) + Math.log(b.p) * f + bridge);
      const t = Math.floor((a.t + i * MIN) / MIN) * MIN;
      const o = out.length ? out[out.length - 1]!.c : c;
      out.push({
        t,
        o,
        c,
        h: Math.max(o, c) * (1 + rand() * vol * 0.6),
        l: Math.min(o, c) * (1 - rand() * vol * 0.6),
        v: Math.round(rand() * 4000 + 200),
      });
    }
  }
  return out;
}

// ---------- the world ----------

function event(w: World, e: Omit<RiskEvent, "id">): RiskEvent {
  const full = { ...e, id: w.nextId++ };
  w.events.unshift(full);
  return full;
}

export function createWorld(now: number): World {
  rand = rng(now % 100000);
  const w: World = {
    now,
    markets: {},
    candles: {},
    books: {},
    trades: {},
    events: [],
    positions: [],
    spot: [],
    snipes: [],
    nextId: 900_000,
    seed: now,
  };
  const add = (m: MarketView, candles: Candle[] = []) => {
    w.markets[m.id] = m;
    w.candles[m.id] = candles;
    w.trades[m.id] = [];
  };

  // Crypto and prediction markets, for running with no server at all. Server markets with the same id win.
  add(
    market(
      {
        id: "BTC-PERP",
        name: "Bitcoin",
        kind: "perp",
        base: "BTC",
        source: { kind: "hyperliquid", label: "Hyperliquid mid", coin: "BTC" },
        maxLeverage: 20,
        maintenanceLeverage: 40,
        tier: 3,
        settings: perpSettings,
        positions: 41,
      },
      81250,
      now,
    ),
    history(
      [
        { t: now - 24 * HOUR, p: 79100 },
        { t: now - 6 * HOUR, p: 82400 },
        { t: now, p: 81250 },
      ],
      0.0016,
    ),
  );
  add(
    market(
      {
        id: "ETH-PERP",
        name: "Ether",
        kind: "perp",
        base: "ETH",
        source: { kind: "hyperliquid", label: "Hyperliquid mid", coin: "ETH" },
        maxLeverage: 10,
        maintenanceLeverage: 20,
        tier: 2,
        settings: perpSettings,
        positions: 27,
      },
      2412.5,
      now,
    ),
    history(
      [
        { t: now - 24 * HOUR, p: 2490 },
        { t: now, p: 2412.5 },
      ],
      0.002,
    ),
  );
  add(
    market(
      {
        id: "PM-FIXTURE",
        name: "Will the fixture bill pass by December?",
        kind: "binary",
        base: "YES",
        source: { kind: "polymarket", label: "Polymarket midpoint" },
        bounds: ["0", "1"],
        resolvable: true,
        settings: [
          { label: "Oracle", value: "Polymarket midpoint", ours: false },
          { label: "Start leverage", value: "3×", ours: true },
          { label: "Taper", value: "none (end dates unreliable)", ours: true },
        ],
        positions: 12,
      },
      0.62,
      now,
    ),
    history(
      [
        { t: now - 24 * HOUR, p: 0.55 },
        { t: now, p: 0.62 },
      ],
      0.01,
    ),
  );

  // A creator coin still in its snipe window: opens in four minutes, then trades.
  add(newCoin(w, "@neonfox", 4 * MIN, 23));
  w.markets["@neonfox"]!.creator = "neonfox";
  snipeBids["@neonfox"]!.push({ account: "you", usdc: 250, time: now - 40_000 });
  w.markets["@neonfox"]!.snipe = snipeView(
    w.markets["@neonfox"]!.snipe!.opensAt,
    snipeBids["@neonfox"]!,
  );
  w.snipes.push({ market: "@neonfox", usdc: "250.00", time: now - 40_000 });

  // A creator coin that opened 50 minutes ago.
  {
    const openedAt = now - 50 * MIN;
    const sniped = 18_400;
    const openPrice = curvePrice(sniped * (1 - FEE));
    const usdcIn = sniped * (1 - FEE) + 6_100;
    const p = curvePrice(usdcIn);
    const m = market(
      {
        id: "@lunadev",
        name: "@lunadev creator coin",
        kind: "attention",
        base: "LUNADEV",
        creator: "lunadev",
        description:
          "Creator coin for @lunadev. Opened from a snipe pool; the perp marks to a 10-minute TWAP of the curve.",
        source: { kind: "curve", label: "own curve, 10m TWAP" },
        createdAt: openedAt - 5 * MIN,
        curve: {
          price: fix(p, 10),
          usdcIn: money(usdcIn),
          tokensSold: String(Math.round(SUPPLY - K / (VIRTUAL_USDC + usdcIn))),
          supply: String(SUPPLY),
          feeBps: 100,
          oracleWindow: 600,
          marketCap: money(p * SUPPLY),
        },
        launch: {
          openPrice: fix(openPrice, decimalsFor(openPrice)),
          openedAt,
          sniped: money(sniped),
          tokensSold: String(Math.round(tokensFor(0, sniped * (1 - FEE)))),
          reserve: money(sniped * (1 - FEE)),
        },
        settings: coinSettings(600),
        positions: 19,
      },
      p,
      now,
    );
    add(
      m,
      history(
        [
          { t: openedAt, p: openPrice },
          { t: openedAt + 8 * MIN, p: openPrice * 1.9 },
          { t: openedAt + 30 * MIN, p: openPrice * 1.3 },
          { t: now, p },
        ],
        0.012,
      ),
    );
    event(w, {
      time: openedAt,
      market: m.id,
      kind: "open",
      accounts: [],
      text: `${m.id} opened at ${fix(openPrice, decimalsFor(openPrice))}: $${money(sniped)} from 31 snipers filled at one price`,
      amount: money(sniped),
      price: fix(openPrice, decimalsFor(openPrice)),
    });
    w.spot.push({
      market: m.id,
      tokens: "1250000",
      value: money(1_250_000 * p),
      price: fix(p, 10),
    });
  }

  // A private pre-IPO market priced only by its own book, with an ADL cluster 25 minutes ago.
  {
    const seed = 12;
    const mark = 18.4;
    const m = market(
      {
        id: "HELIX-PRE",
        name: "Helix Robotics (pre-IPO)",
        kind: "preipo",
        base: "HELIX",
        description:
          "Fictional private company for fixtures. No outside price exists: the mark is the mid of our order book.",
        settings: preipoSettings,
        preipo: {
          seedPrice: money(seed),
          impliedValuation: money(mark * SHARES),
          status: "private",
          ipoAt: null,
          ipoPrice: null,
        },
        positions: 34,
      },
      mark,
      now,
    );
    const crashAt = now - 25 * MIN;
    add(
      m,
      history(
        [
          { t: now - 24 * HOUR, p: seed },
          { t: now - 8 * HOUR, p: 16.2 },
          { t: now - 41 * MIN, p: 18.92 },
          { t: crashAt - MIN, p: 19.6 },
          { t: crashAt, p: 15.1 },
          { t: crashAt + 6 * MIN, p: 16.8 },
          { t: now, p: mark },
        ],
        0.004,
      ),
    );
    event(w, {
      time: now - 41 * MIN,
      market: m.id,
      kind: "liquidation",
      accounts: ["ape"],
      text: "ape liquidated: long 400 HELIX closed at 18.92, kept $611.40",
      amount: "611.40",
      price: "18.92",
    });
    cluster(w, m.id, crashAt, 15.1, "degen", "long 2,500 HELIX", 1842.17, [
      ["maker", 1203.55],
      ["whale", 512.4],
      ["scalper", 126.22],
    ]);
    w.positions.push(position(m, "long", 120, 17.2, 5));
  }

  // A pre-IPO market that has gone public: the IPO repriced it from 41.20 to 55.00 in one step.
  {
    const ipoAt = now - 35 * MIN;
    const m = market(
      {
        id: "NWND-PRE",
        name: "Northwind AI (pre-IPO)",
        kind: "preipo",
        base: "NWND",
        description:
          "Fictional company for fixtures. Priced by our book until its IPO, then marked to the listed price.",
        source: { kind: "book", label: "own order book" },
        settings: preipoSettings,
        preipo: {
          seedPrice: "30.00",
          impliedValuation: money(56.1 * SHARES),
          status: "public",
          ipoAt,
          ipoPrice: "55.00",
        },
        positions: 22,
      },
      56.1,
      now,
    );
    add(
      m,
      history(
        [
          { t: now - 24 * HOUR, p: 33 },
          { t: ipoAt - MIN, p: 41.2 },
          { t: ipoAt, p: 55 },
          { t: now, p: 56.1 },
        ],
        0.003,
      ),
    );
    event(w, {
      time: ipoAt,
      market: m.id,
      kind: "ipo",
      accounts: [],
      text: `${m.id} IPO priced at 55.00: mark gapped from 41.20 (+33.5%)`,
      amount: null,
      price: "55.00",
    });
    cluster(w, m.id, ipoAt, 55, "scalper", "short 900 NWND", 2210.9, [
      ["maker", 1490.0],
      ["ape", 720.9],
    ]);
  }

  for (const m of Object.values(w.markets)) refresh(w, m);
  w.events.sort((a, b) => b.time - a.time);
  return w;
}

/** One bankruptcy and the haircuts that paid for it, all in one transaction (same time, same price). */
function cluster(
  w: World,
  market: string,
  time: number,
  price: number,
  bankrupt: string,
  what: string,
  shortfall: number,
  payers: [string, number][],
) {
  const d = decimalsFor(price);
  const px = fix(price, d);
  event(w, {
    time,
    market,
    kind: "bankrupt",
    accounts: [bankrupt],
    text: `${bankrupt} bankrupt: ${what} closed at ${px}, $${money(shortfall)} shortfall charged to the other side`,
    amount: money(shortfall),
    price: px,
  });
  for (const [who, amt] of payers) {
    event(w, {
      time,
      market,
      kind: "haircut",
      accounts: [who],
      text: `${who} paid a $${money(amt)} ADL haircut (from profit)`,
      amount: money(amt),
      price: px,
    });
  }
  event(w, {
    time,
    market,
    kind: "adl",
    accounts: [payers[0]![0]],
    text: `${payers[0]![0]} auto-deleveraged: position force-closed at ${px}`,
    amount: null,
    price: px,
  });
}

function position(
  m: MarketView,
  side: "long" | "short",
  size: number,
  entry: number,
  lev: number,
): PositionView {
  const mm = m.maintenanceLeverage;
  const liq =
    side === "long"
      ? (entry * (1 - 1 / lev)) / (1 - 1 / mm)
      : (entry * (1 + 1 / lev)) / (1 + 1 / mm);
  const bust = side === "long" ? entry * (1 - 1 / lev) : entry * (1 + 1 / lev);
  const collateral = (size * entry) / lev;
  const d = m.priceDecimals;
  return {
    market: m.id,
    kind: m.kind,
    size: String(side === "long" ? size : -size),
    side,
    entry: fix(entry, d),
    mark: m.mark,
    notional: "0",
    collateral: money(collateral),
    equity: money(collateral),
    unrealized: "0",
    realized: "0",
    funding: "0",
    adl: "0",
    allocated: money(collateral),
    pnl: "0",
    initialMargin: money(collateral),
    maintenanceMargin: money(collateral / 2),
    leverage: lev,
    liquidationPrice: fix(liq, d),
    bankruptcyPrice: fix(bust, d),
    releasable: "0",
  };
}

/** Recompute everything derived from the mark: book, best bid/ask, valuation, curve stats, position PnL. */
function refresh(w: World, m: MarketView) {
  const mark = m.mark === null ? null : Number(m.mark);
  if (mark !== null) {
    const step = Math.max(Number(m.tick), mark * 0.0006);
    const levels = (dir: 1 | -1): Level[] =>
      Array.from({ length: 14 }, (_, i) => ({
        price: fix(mark + dir * step * (i + 0.5 + rand() * 0.3), m.priceDecimals),
        size: fix(
          ((200 + rand() * 1800) / Math.max(mark, 0.01) ** 0.5) * (1 + i * 0.15),
          m.szDecimals,
        ),
        orders: 1 + Math.floor(rand() * 4),
      }));
    const bids = levels(-1);
    const asks = levels(1);
    w.books[m.id] = { market: m.id, bids, asks, mark: m.mark };
    m.bestBid = bids[0]!.price;
    m.bestAsk = asks[0]!.price;
    const cs = w.candles[m.id] ?? [];
    const dayAgo = cs.find((c) => c.t >= w.now - 24 * HOUR);
    if (dayAgo) m.open24h = fix(dayAgo.o, m.priceDecimals);
    m.volume24h = money(
      cs.filter((c) => c.t >= w.now - 24 * HOUR).reduce((s, c) => s + c.v * 12, 0),
    ); // candle v is a made-up count; ~$12 a unit keeps volumes plausible
    m.openInterest = fix(m.positions * 180, m.szDecimals);
    m.openInterestUsd = money(m.positions * 180 * mark);
    if (m.preipo) m.preipo = { ...m.preipo, impliedValuation: money(mark * SHARES) };
  }
  if (m.curve) {
    const p = curvePrice(Number(m.curve.usdcIn));
    m.curve = { ...m.curve, price: fix(p, 10), marketCap: money(p * SUPPLY) };
  }
  for (const p of w.positions) {
    if (p.market !== m.id || mark === null) continue;
    const size = Number(p.size);
    const unreal = size * (mark - Number(p.entry));
    p.mark = m.mark;
    p.notional = money(Math.abs(size) * mark);
    p.unrealized = money(unreal);
    p.equity = money(Number(p.collateral) + unreal);
    p.pnl = money(unreal + Number(p.realized) + Number(p.adl));
  }
  for (const s of w.spot) {
    if (s.market === m.id && m.curve) {
      s.price = m.curve.price;
      s.value = money(Number(s.tokens) * Number(m.curve.price));
    }
  }
}

function setMark(w: World, m: MarketView, p: number) {
  if (m.kind === "binary") p = Math.min(0.99, Math.max(0.01, p));
  const d = m.priceDecimals;
  m.mark = fix(p, d);
  m.last = m.mark;
  const t = Math.floor(w.now / MIN) * MIN;
  const cs = (w.candles[m.id] ??= []);
  const last = cs[cs.length - 1];
  if (last && last.t === t) {
    last.c = p;
    last.h = Math.max(last.h, p);
    last.l = Math.min(last.l, p);
    last.v += Math.round(rand() * 300);
  } else {
    cs.push({
      t,
      o: last?.c ?? p,
      h: Math.max(last?.c ?? p, p),
      l: Math.min(last?.c ?? p, p),
      c: p,
      v: Math.round(rand() * 300),
    });
    if (cs.length > 1440) cs.shift();
  }
}

function trade(
  w: World,
  m: MarketView,
  side: "buy" | "sell",
  size: number,
  price: number,
  taker: string,
  maker: string,
  kind: "perp" | "spot" = "perp",
): FillView {
  const f: FillView = {
    id: w.nextId++,
    time: w.now,
    market: m.id,
    kind,
    price: fix(price, m.priceDecimals),
    size: fix(size, m.szDecimals),
    notional: money(size * price),
    side,
    taker,
    maker,
  };
  const ts = (w.trades[m.id] ??= []);
  ts.unshift(f);
  if (ts.length > 40) ts.pop();
  return f;
}

function curveTrade(w: World, m: MarketView, usdc: number, who: string) {
  const c = m.curve!;
  const usdcIn = Math.max(0, Number(c.usdcIn) + usdc * (1 - FEE));
  const before = curvePrice(Number(c.usdcIn));
  m.curve = {
    ...c,
    usdcIn: money(usdcIn),
    tokensSold: String(Math.round(SUPPLY - K / (VIRTUAL_USDC + usdcIn))),
  };
  const p = curvePrice(usdcIn);
  setMark(w, m, p);
  trade(
    w,
    m,
    usdc > 0 ? "buy" : "sell",
    Math.abs(usdc) / ((before + p) / 2),
    p,
    who,
    "curve",
    "spot",
  );
}

/** Advance the clock: random walks, house trades on the curves, snipes that reach their open. */
export function tick(w: World, now: number) {
  w.now = now;
  for (const m of Object.values(w.markets)) {
    if (m.status !== "open") continue;
    if (m.snipe) {
      if (now >= m.snipe.opensAt) open(w, m);
      continue;
    }
    if (m.curve) {
      if (rand() < 0.5)
        curveTrade(w, m, (rand() - 0.47) * 180, BOTS[Math.floor(rand() * BOTS.length)]!);
    } else if (m.mark !== null && !(m.heldUntil && m.heldUntil > now)) {
      const vol = m.kind === "binary" ? 0.004 : m.kind === "preipo" ? 0.0012 : 0.0006;
      setMark(w, m, Number(m.mark) * Math.exp(gauss() * vol));
    }
    if (m.mark !== null && rand() < 0.6) {
      const side = rand() < 0.5 ? "buy" : "sell";
      trade(
        w,
        m,
        side,
        (50 + rand() * 900) / Math.max(Number(m.mark), 0.0001) ** 0.6,
        Number(side === "buy" ? (m.bestAsk ?? m.mark) : (m.bestBid ?? m.mark)),
        BOTS[Math.floor(rand() * 5)]!,
        "maker",
      );
    }
    refresh(w, m);
  }
}

/** The snipe window closes: every bid fills at one price, the curve takes the pool, and the market is live. */
function open(w: World, m: MarketView) {
  const bids = snipeBids[m.id] ?? [];
  const total = bids.reduce((s, b) => s + b.usdc, 0);
  const net = total * (1 - FEE);
  const tokens = tokensFor(0, net);
  const p = curvePrice(net);
  const avg = tokens > 0 ? net / tokens : p;
  const d = decimalsFor(p);
  m.priceDecimals = d;
  m.tick = (10 ** -d).toFixed(d);
  m.curve = { ...m.curve!, usdcIn: money(net), tokensSold: String(Math.round(tokens)) };
  m.launch = {
    openPrice: fix(p, d),
    openedAt: w.now,
    sniped: money(total),
    tokensSold: String(Math.round(tokens)),
    reserve: money(net),
  };
  m.snipe = null;
  m.open24h = fix(p, d);
  setMark(w, m, p);
  event(w, {
    time: w.now,
    market: m.id,
    kind: "open",
    accounts: [],
    text: `${m.id} opened at ${fix(p, d)}: $${money(total)} from ${new Set(bids.map((b) => b.account)).size} snipers filled at one price`,
    amount: money(total),
    price: fix(p, d),
  });
  const mine = bids.filter((b) => b.account === "you").reduce((s, b) => s + b.usdc, 0);
  w.snipes = w.snipes.filter((s) => s.market !== m.id);
  if (mine > 0)
    w.spot.push({
      market: m.id,
      tokens: String(Math.round((mine * (1 - FEE)) / avg)),
      value: money(mine * (1 - FEE)),
      price: fix(p, 10),
    });
}

// ---------- the API, for fixture markets and contract endpoints the server doesn't have yet ----------

export class FixtureError extends Error {}

type Body = Record<string, unknown>;
const str = (v: unknown) =>
  typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);

/** Handle a request in the fixture world, or return undefined to let the real server take it. */
export function handle(
  w: World,
  method: string,
  path: string,
  body: Body = {},
  force = false,
): unknown {
  const id = str(body.market);
  const m = id ? w.markets[id] : undefined;
  const mine = !!m;
  if (method !== "POST") return undefined;

  switch (path) {
    case "/api/snipe": {
      if (!m && !force) return undefined;
      if (!m) throw new FixtureError(`unknown market ${id}`);
      if (!m.snipe || w.now >= m.snipe.opensAt) throw new FixtureError("snipe window is closed");
      const usdc = Number(body.usdc);
      if (!(usdc > 0)) throw new FixtureError("usdc must be positive");
      (snipeBids[m.id] ??= []).push({ account: "you", usdc, time: w.now });
      m.snipe = snipeView(m.snipe.opensAt, snipeBids[m.id]!);
      const prev = w.snipes.find((s) => s.market === m.id);
      if (prev) prev.usdc = money(Number(prev.usdc) + usdc);
      else w.snipes.push({ market: m.id, usdc: money(usdc), time: w.now });
      return { ok: true };
    }
    case "/api/attention":
    case "/api/admin/demo-coin": {
      if (!force) return undefined;
      const words = ["orbit", "pixel", "mango", "quasar", "ember", "drift", "fable", "gecko"];
      const handle =
        str(body.handle).trim() ||
        `@${words[Math.floor(rand() * words.length)]}_${Math.floor(rand() * 90 + 10)}`;
      const id = (handle.startsWith("@") ? handle : `@${handle}`).toLowerCase();
      if (w.markets[id]) throw new FixtureError(`${id} is already listed`);
      const coin = newCoin(w, id, 5 * MIN, path === "/api/admin/demo-coin" ? 6 : 0);
      w.markets[id] = coin;
      w.candles[id] = [];
      w.trades[id] = [];
      event(w, {
        time: w.now,
        market: id,
        kind: "listing",
        accounts: [],
        text: `${id} listed: snipe window open for 5 minutes`,
        amount: null,
        price: null,
      });
      return coin;
    }
    case "/api/admin/preipo": {
      if (!force) return undefined;
      const pid = str(body.id).toUpperCase();
      const price = Number(body.price);
      if (!pid || !(price > 0)) throw new FixtureError("id and a positive price are required");
      if (w.markets[pid]) throw new FixtureError(`${pid} is already listed`);
      const pm = market(
        {
          id: pid,
          name: str(body.name) || pid,
          kind: "preipo",
          base: pid.replace(/-PRE$/, ""),
          description: str(body.description),
          createdAt: w.now,
          settings: preipoSettings,
          preipo: {
            seedPrice: fix(price, 2),
            impliedValuation: money(price * SHARES),
            status: "private",
            ipoAt: null,
            ipoPrice: null,
          },
        },
        price,
        w.now,
      );
      w.markets[pid] = pm;
      w.candles[pid] = [];
      w.trades[pid] = [];
      setMark(w, pm, price);
      refresh(w, pm);
      event(w, {
        time: w.now,
        market: pid,
        kind: "listing",
        accounts: [],
        text: `${pid} listed pre-IPO at ${fix(price, 2)} (implied ${money(price * SHARES)})`,
        amount: null,
        price: fix(price, 2),
      });
      return pm;
    }
    case "/api/admin/ipo": {
      if (!mine) return force ? fail(id) : undefined;
      if (m.kind !== "preipo" || !m.preipo) throw new FixtureError(`${id} is not a pre-IPO market`);
      if (m.preipo.status === "public") throw new FixtureError(`${id} is already public`);
      const ipo = Number(body.price);
      if (!(ipo > 0)) throw new FixtureError("price must be positive");
      const before = Number(m.mark);
      setMark(w, m, ipo);
      m.preipo = {
        ...m.preipo,
        status: "public",
        ipoAt: w.now,
        ipoPrice: fix(ipo, m.priceDecimals),
      };
      const ch = ipo / before - 1;
      event(w, {
        time: w.now,
        market: m.id,
        kind: "ipo",
        accounts: [],
        text: `${m.id} IPO priced at ${fix(ipo, m.priceDecimals)}: mark gapped from ${fix(before, m.priceDecimals)} (${ch >= 0 ? "+" : ""}${(ch * 100).toFixed(1)}%)`,
        amount: null,
        price: m.mark,
      });
      const effects = [`${m.id} is public at ${m.mark}`];
      if (Math.abs(ch) > 0.15) effects.push(...crash(w, m, ipo, ch > 0 ? "short" : "long"));
      refresh(w, m);
      return { effects };
    }
    case "/api/admin/pump": {
      if (!mine) return force ? fail(id) : undefined;
      if (!m.curve || m.snipe)
        throw new FixtureError(
          m.snipe ? `${id} hasn't opened yet` : `${id} has no curve: use /api/admin/price`,
        );
      const usdc = Number(body.usdc);
      if (!usdc) throw new FixtureError("usdc must be non-zero");
      const before = Number(m.mark);
      curveTrade(w, m, usdc, "house");
      const after = Number(m.mark);
      const effects = [
        `house ${usdc > 0 ? "bought" : "sold"} $${money(Math.abs(usdc))} on the curve: ${fix(before, m.priceDecimals)} → ${fix(after, m.priceDecimals)}`,
      ];
      if (Math.abs(after / before - 1) > 0.25)
        effects.push(...crash(w, m, after, usdc > 0 ? "short" : "long"));
      refresh(w, m);
      return { effects };
    }
    case "/api/admin/price": {
      if (!mine) return undefined;
      const p = Number(body.price);
      if (!(p > 0) && m.kind !== "binary") throw new FixtureError("price must be positive");
      const before = Number(m.mark);
      setMark(w, m, p);
      const hold = Number(body.holdSeconds) || 0;
      m.heldUntil = hold > 0 ? w.now + hold * 1000 : null;
      event(w, {
        time: w.now,
        market: m.id,
        kind: "gap",
        accounts: [],
        text: `${m.id} oracle forced to ${m.mark} (was ${fix(before, m.priceDecimals)})`,
        amount: null,
        price: m.mark,
      });
      if (Math.abs(p / before - 1) > 0.2) crash(w, m, p, p < before ? "long" : "short");
      refresh(w, m);
      return { ok: true };
    }
    case "/api/admin/release": {
      if (!mine) return undefined;
      m.heldUntil = null;
      return { ok: true };
    }
    case "/api/admin/resolve": {
      if (!mine) return undefined;
      const p = Number(body.price);
      setMark(w, m, p);
      m.mark = fix(p, m.priceDecimals);
      m.status = "resolved";
      event(w, {
        time: w.now,
        market: m.id,
        kind: "settlement",
        accounts: [],
        text: `${m.id} resolved at ${p}; ${m.positions} positions settled`,
        amount: null,
        price: m.mark,
      });
      w.positions = w.positions.filter((x) => x.market !== m.id);
      return { ok: true };
    }
    case "/api/orders": {
      if (!mine) return undefined;
      if (m.mark === null) throw new FixtureError(`${id} hasn't opened yet`);
      const side = str(body.side) as "buy" | "sell";
      const size = Number(body.size);
      if (!(size > 0)) throw new FixtureError("size must be positive");
      const price = Number(side === "buy" ? m.bestAsk : m.bestBid) || Number(m.mark);
      const fill = {
        ...trade(w, m, side, size, price, "you", "maker"),
        mySide: side,
        liquidity: "taker" as const,
      };
      const signed = side === "buy" ? size : -size;
      const p = w.positions.find((x) => x.market === m.id);
      if (!p)
        w.positions.push(
          position(
            m,
            signed > 0 ? "long" : "short",
            size,
            price,
            Number(body.leverage) || m.maxLeverage,
          ),
        );
      else {
        const cur = Number(p.size);
        const next = cur + signed;
        if (Math.abs(next) < 1e-12) w.positions = w.positions.filter((x) => x !== p);
        else if (Math.sign(next) === Math.sign(cur) && Math.abs(next) > Math.abs(cur)) {
          const entry = (Math.abs(cur) * Number(p.entry) + size * price) / Math.abs(next);
          Object.assign(
            p,
            position(
              m,
              p.side as "long" | "short",
              Math.abs(next),
              entry,
              p.leverage ?? m.maxLeverage,
            ),
          );
        } else
          Object.assign(
            p,
            position(
              m,
              next > 0 ? "long" : "short",
              Math.abs(next),
              Math.abs(next) > Math.abs(cur) ? price : Number(p.entry),
              p.leverage ?? m.maxLeverage,
            ),
          );
      }
      refresh(w, m);
      return { status: "filled", reason: null, fills: [fill] };
    }
    case "/api/positions/close": {
      if (!mine) return undefined;
      w.positions = w.positions.filter((x) => x.market !== m.id);
      return { status: "filled", reason: null };
    }
    case "/api/spot/buy":
    case "/api/spot/sell": {
      if (!mine) return undefined;
      if (!m.curve || m.snipe)
        throw new FixtureError(
          m.snipe ? "the coin opens when the snipe window closes" : "no curve",
        );
      const held = w.spot.find((s) => s.market === m.id);
      if (path === "/api/spot/buy") {
        const usdc = Number(body.usdc);
        if (!(usdc > 0)) throw new FixtureError("usdc must be positive");
        const tokens = tokensFor(Number(m.curve.usdcIn), usdc * (1 - FEE));
        curveTrade(w, m, usdc, "you");
        if (held) held.tokens = String(Math.round(Number(held.tokens) + tokens));
        else
          w.spot.push({
            market: m.id,
            tokens: String(Math.round(tokens)),
            value: money(usdc),
            price: m.curve.price,
          });
      } else {
        if (!held) throw new FixtureError("nothing to sell");
        const x = VIRTUAL_USDC + Number(m.curve.usdcIn);
        const tokens =
          body.tokens === "all"
            ? Number(held.tokens)
            : Math.min(Number(body.tokens), Number(held.tokens));
        const out = x - K / (K / x + tokens);
        curveTrade(w, m, -out / (1 - FEE), "you");
        held.tokens = String(Math.round(Number(held.tokens) - tokens));
        if (Number(held.tokens) <= 0) w.spot = w.spot.filter((s) => s !== held);
      }
      refresh(w, m);
      return { ok: true };
    }
  }
  return undefined;
}

function fail(id: string): never {
  throw new FixtureError(`unknown market ${id}`);
}

/** A big move bankrupts someone on the losing side, and the winners pay for it: liquidation, bankruptcy, haircuts. */
function crash(w: World, m: MarketView, price: number, losing: "long" | "short"): string[] {
  const [victim, ...payers] = BOTS.toSorted(() => rand() - 0.5);
  const shortfall = Math.round(300 + rand() * 2400) + rand();
  const shares = payers.slice(0, 3).map((p) => [p!, rand() + 0.2] as [string, number]);
  const sum = shares.reduce((s, [, x]) => s + x, 0);
  const pays = shares.map(
    ([p, x]) => [p, Math.round(((shortfall * x) / sum) * 100) / 100] as [string, number],
  );
  const d = decimalsFor(price);
  const liqd = payers[3] ?? "ape";
  event(w, {
    time: w.now,
    market: m.id,
    kind: "liquidation",
    accounts: [liqd],
    text: `${liqd} liquidated: ${losing} closed at ${fix(price, d)}, kept $${money(rand() * 400)}`,
    amount: null,
    price: fix(price, d),
  });
  cluster(
    w,
    m.id,
    w.now,
    price,
    victim!,
    `${losing} ${Math.round(500 + rand() * 3000)} ${m.base}`,
    shortfall,
    pays,
  );
  const mine = w.positions.find((p) => p.market === m.id && p.side === losing);
  const out = [
    `${victim} bankrupt: $${money(shortfall)} shortfall`,
    ...pays.map(([p, a]) => `${p} paid $${money(a)} ADL haircut`),
  ];
  if (
    mine &&
    (losing === "long"
      ? price <= Number(mine.liquidationPrice)
      : price >= Number(mine.liquidationPrice))
  ) {
    w.positions = w.positions.filter((p) => p !== mine);
    event(w, {
      time: w.now,
      market: m.id,
      kind: "liquidation",
      accounts: ["you"],
      text: `you liquidated: ${losing} ${Math.abs(Number(mine.size))} ${m.base} closed at ${fix(price, d)}`,
      amount: null,
      price: fix(price, d),
    });
    out.push("your position was liquidated");
  } else if (w.positions.some((p) => p.market === m.id && p.side !== losing)) {
    const p = w.positions.find((x) => x.market === m.id && x.side !== losing)!;
    const amt = Math.round(shortfall * 0.08 * 100) / 100;
    p.adl = money(Number(p.adl) - amt);
    event(w, {
      time: w.now,
      market: m.id,
      kind: "haircut",
      accounts: ["you"],
      text: `you paid a $${money(amt)} ADL haircut (from profit)`,
      amount: money(amt),
      price: fix(price, d),
    });
    out.push(`you paid $${money(amt)} ADL haircut`);
  }
  return out;
}
