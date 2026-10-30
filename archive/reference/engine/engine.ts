// Impulse reference engine: Mirror-style MicroPerps for any asset, no exchange backstop.
// Markets are isolated shards: each owns its positions, collateral vault and config, and risk processing
// (liquidation + ADL) only ever reads and writes the market it runs in. Accounts hold a wallet and move
// collateral into per-market buckets explicitly.
// Every event is an atomic state transition: apply to a clone, assert invariants, commit or reject.
// See docs/ACCOUNTING.md for the model this implements.

import { allocate } from "./alloc.js";
import { abs, ceilDiv, fmtPrice, fmtUsd, isqrt, max, min, parseFixed, sign } from "./fixed.js";

// ---------- types ----------

export interface MarketConfig {
  lower: bigint; // lowest valid price (0 unless bounded)
  upper: bigint | null; // highest valid price, null = unbounded (e.g. tokens, equities)
  resolvable: boolean; // can be settled to a final price (prediction market, pre-IPO flatten)
  initialLeverage: bigint; // IM = notional / initialLeverage
  maintenanceLeverage: bigint; // MM = notional / maintenanceLeverage
  adl: AdlPolicy;
  graduation: boolean; // leverage rises through GRADUATION tiers as volume and depth grow
  funding: boolean; // hourly funding between longs and shorts
  resolvesAt: bigint | null; // scheduled resolution time (seconds); resolve is rejected before it
  taperSeconds: bigint; // before resolvesAt, margin requirements ramp up to full collateral against max loss
}

/**
 * Leverage graduation (Mirror: "leverage increases according to a combination of volume and depth", criteria
 * undisclosed). OUR criteria: a tier unlocks once cumulative traded notional AND depth both reach its thresholds.
 * Depth has no order book to measure here, so we proxy it with open-interest notional at mark, plus the real USDC
 * in the spot curve for attention markets. Tiers only ever go up, matching Mirror's wording. Tier 0 is the
 * market's configured leverage (3x default). Maintenance leverage keeps the configured IM:MM ratio (2x default).
 * Each tier also lowers the funding base rate (Mirror: funding starts at its "maximum base rate").
 */
export const GRADUATION: { leverage: bigint; volume: bigint; depth: bigint }[] = [
  { leverage: 5n, volume: 100_000n, depth: 10_000n },
  { leverage: 10n, volume: 1_000_000n, depth: 50_000n },
  { leverage: 20n, volume: 10_000_000n, depth: 250_000n },
  { leverage: 50n, volume: 100_000_000n, depth: 1_000_000n },
  { leverage: 100n, volume: 1_000_000_000n, depth: 5_000_000n },
].map((t) => ({ leverage: t.leverage, volume: t.volume * 10n ** 9n, depth: t.depth * 10n ** 9n }));

/**
 * Funding (OUR parameters; Mirror publishes none). Rates are per hour in parts per billion (1e9 = 100%).
 * rate = baseRate[tier] + clamp(premium / 8, ±PREMIUM_CAP), premium = (last trade − mark) / mark.
 * The base rate is paid by longs to shorts, highest at launch (0.05%/h ≈ 438%/yr) and falling to 0.00125%/h
 * (≈ 11%/yr, Hyperliquid's default) at the top tier. The rate is fixed at every trade/tick/oracle update and held
 * until the next one, so an inactive market keeps paying the last rate (Mirror's wording).
 */
export const FUNDING_BASE_PPB: bigint[] = [500_000n, 250_000n, 100_000n, 50_000n, 25_000n, 12_500n];
export const FUNDING_PREMIUM_CAP_PPB = 40_000_000n; // 4% per hour
const PPB = 1_000_000_000n;

/**
 * How a bankrupt position's shortfall is charged to the opposing side (forced closes are always size pro-rata,
 * which is what keeps exposure balanced):
 *  - "size": pro-rata by position size. Simple, provably never pushes an absorber below zero within a tick,
 *    but charges principal even for accounts that are barely in profit.
 *  - "pnl":  capped pro-rata on positive PnL (Chitra, arXiv:2512.01112): principal is protected. If total positive
 *    PnL can't cover the shortfall, the remainder comes out of principal pro-rata by remaining equity, and the
 *    effect reports how much principal was hit.
 */
export type AdlPolicy = "size" | "pnl";

export interface Position {
  account: string;
  collateral: bigint; // cash in this market's bucket
  size: bigint; // units, + long / − short
  basis: bigint; // Σ signed fill size × fill price
  // Ledger columns: collateral = allocated + realized + adlTransfer + funding (invariant).
  allocated: bigint; // Σ allocate − Σ release
  realized: bigint;
  adlTransfer: bigint; // − haircut paid as absorber, + shortfall covered as bankrupt
  funding: bigint; // + received, − paid
}

/** Mirror-style spot market: xy=k bonding curve on virtual reserves (USDC x, tokens y). */
export interface Curve {
  x0: bigint; // initial virtual USDC reserve (nano-USD)
  y0: bigint; // initial virtual token reserve (= max supply, units)
  x: bigint;
  y: bigint;
  feeBps: bigint; // spot fee, charged on the USDC side
}

/** Perp oracle read from the market's own curve: instant (window 0) or a time-weighted average. */
export interface CurveOracle {
  window: bigint; // seconds
  history: { t: bigint; price: bigint }[]; // spot price change points, pruned to the window
}

/**
 * Creator-coin launch: a snipe window before the curve opens. Bids are USDC from the wallet (net of the spot fee)
 * and can't be cancelled. At the open, the whole book of bids buys from the curve at one price (see onOpen).
 */
export interface Launch {
  open: boolean;
  bids: Record<string, bigint>; // net USDC per account, waiting for the open
  reserve: bigint; // after the open: the part of the bids the curve didn't take, held by the market
}

export interface Market {
  id: string;
  config: MarketConfig;
  curve: Curve | null;
  oracle: CurveOracle | null;
  launch: Launch | null;
  mark: bigint | null;
  time: bigint; // market's view of the clock (kept in sync with State.time)
  tier: number; // graduation tier, 0 = launch
  volume: bigint; // cumulative traded notional
  lastTrade: bigint | null; // last trade price: the funding premium's perp price when there's no book mid
  mid: bigint | null; // order-book mid from the exchange (`book` events): the funding premium's perp price
  fundingRate: bigint; // ppb per hour, positive = longs pay shorts
  status: "open" | "resolved";
  vault: bigint; // collateral held for this market = Σ allocated
  positions: Record<string, Position>;
}

export interface Account {
  id: string;
  wallet: bigint;
  spot: Record<string, bigint>; // curve-token holdings per market
  deposited: bigint;
  withdrawn: bigint;
}

export interface State {
  seq: number;
  time: bigint; // seconds, advanced by `advance` events
  fees: bigint; // spot fees collected by the venue
  totalDeposits: bigint;
  totalWithdrawals: bigint;
  accounts: Record<string, Account>;
  markets: Record<string, Market>;
}

type Amount = string; // decimal, or "all" where noted

export type Event =
  | {
      type: "market";
      id: string;
      preset?: "binary" | "perp" | "attention"; // attention = unbounded perp priced off its own xy=k spot curve
      bounds?: [string, string | null];
      curve?: { usdc: string; tokens: number | string }; // virtual reserves (attention default: $5,000 / 1B)
      feeBps?: number; // spot fee (attention default 100 = 1%, our assumption; Mirror's is unpublished)
      oracleWindow?: number; // seconds of TWAP smoothing on the curve price (default 0 = instant)
      adl?: AdlPolicy; // default "size"
      graduation?: boolean; // default true
      funding?: boolean; // default true
      resolvesAt?: number; // seconds on the simulation clock
      taperSeconds?: number; // default 0 (no taper)
      resolvable?: boolean;
      initialLeverage?: number;
      maintenanceLeverage?: number;
      launch?: boolean; // curve markets only: open with a snipe window (spot and perp trading wait for `open`)
    }
  | { type: "deposit"; account: string; amount: Amount }
  | { type: "withdraw"; account: string; amount: Amount } // "all" allowed
  | { type: "allocate"; account: string; market: string; amount: Amount } // wallet → market; "all" allowed
  | { type: "release"; account: string; market: string; amount: Amount } // market → wallet; "all" allowed
  | { type: "trade"; market: string; buyer: string; seller: string; size: number | string; price: string }
  | { type: "tick"; market: string; price: string } // external-feed markets only
  | { type: "spotBuy"; account: string; market: string; amount: Amount } // USDC from wallet into the curve; "all" allowed
  | { type: "spotSell"; account: string; market: string; tokens: number | string } // tokens back to the curve; "all" allowed
  | { type: "advance"; seconds: number } // move the clock; curve oracles refresh and risk runs
  | { type: "resolve"; market: string; price: string }
  | { type: "snipe"; account: string; market: string; amount: Amount } // bid USDC into a launch; "all" allowed
  | { type: "open"; market: string } // end a launch's snipe window: fill every bid at one price
  | { type: "book"; market: string; mid: string | null }; // the exchange's order-book mid (null: a side is empty)

export interface ForcedClose {
  account: string;
  closed: bigint; // signed change in size
  price: bigint;
}

export type Effect =
  | { kind: "liquidation"; market: string; account: string; size: bigint; equity: bigint; maintenance: bigint }
  | { kind: "bankrupt"; market: string; account: string; size: bigint; shortfall: bigint }
  | { kind: "forcedClose"; market: string; closes: ForcedClose[] }
  | { kind: "haircut"; market: string; account: string; amount: bigint; fromPrincipal: bigint }
  | { kind: "settlement"; market: string; price: bigint; closes: ForcedClose[] }
  | { kind: "spot"; market: string; account: string; usdc: bigint; tokens: bigint; fee: bigint; priceBefore: bigint; priceAfter: bigint }
  | { kind: "mark"; market: string; from: bigint; to: bigint; spot: bigint }
  | { kind: "funding"; market: string; rate: bigint; seconds: bigint; total: bigint; payers: "long" | "short" }
  | { kind: "graduation"; market: string; tier: number; leverage: bigint }
  | { kind: "open"; market: string; price: bigint; sniped: bigint; tokens: bigint; reserve: bigint; fills: LaunchFill[] };

export interface LaunchFill {
  account: string;
  usdc: bigint; // net bid
  tokens: bigint;
}

export type Result =
  | { ok: true; state: State; effects: Effect[] }
  | { ok: false; state: State; reason: string };

export class Rejected extends Error {}

export const DEFAULT_LEVERAGE = { initial: 3n, maintenance: 6n };

export function initialState(): State {
  return { seq: 0, time: 0n, fees: 0n, totalDeposits: 0n, totalWithdrawals: 0n, accounts: {}, markets: {} };
}

// ---------- derived quantities ----------

export const accountIds = (s: State) => Object.keys(s.accounts).sort();
export const marketIds = (s: State) => Object.keys(s.markets).sort();
export const positionIds = (m: Market) => Object.keys(m.positions).sort();
const positionsOf = (m: Market) => positionIds(m).map((id) => m.positions[id]!);

export function equity(p: Position, mark: bigint | null): bigint {
  if (p.size === 0n) return p.collateral - p.basis;
  if (mark === null) throw new Error(`position ${p.account} has size but market has no mark`);
  return p.collateral + p.size * mark - p.basis;
}

export const unrealized = (p: Position, mark: bigint | null) => (p.size === 0n ? 0n : p.size * mark! - p.basis);

/** Worst-case loss before the price hits a bound; null if unbounded. */
function maxLoss(m: Market, p: Position): bigint | null {
  const mark = m.mark!;
  if (p.size > 0n) return p.size * (mark - m.config.lower);
  return m.config.upper === null ? null : abs(p.size) * (m.config.upper - mark);
}

/** Current max leverage: the graduation tier's, or the configured launch leverage at tier 0. */
export function leverageNow(m: Market): { initial: bigint; maintenance: bigint } {
  if (m.tier === 0) return { initial: m.config.initialLeverage, maintenance: m.config.maintenanceLeverage };
  const initial = GRADUATION[m.tier - 1]!.leverage;
  return { initial, maintenance: (initial * m.config.maintenanceLeverage) / m.config.initialLeverage };
}

/**
 * Pre-resolution taper progress in ppb: 0 outside the taper window, rising linearly to 1e9 at resolvesAt.
 * Margin requirements blend from their normal value to the position's full max loss.
 */
export function taperProgress(m: Market): bigint {
  const { resolvesAt, taperSeconds } = m.config;
  if (resolvesAt === null || taperSeconds === 0n) return 0n;
  const start = resolvesAt - taperSeconds;
  if (m.time <= start) return 0n;
  if (m.time >= resolvesAt) return PPB;
  return ((m.time - start) * PPB) / taperSeconds;
}

function requirement(m: Market, p: Position, leverage: bigint): bigint {
  if (p.size === 0n) return 0n;
  const byNotional = ceilDiv(abs(p.size) * m.mark!, leverage);
  const cap = maxLoss(m, p);
  const normal = cap === null ? byNotional : min(cap, byNotional);
  const t = taperProgress(m);
  if (t === 0n || cap === null) return normal;
  return normal + ceilDiv((cap - normal) * t, PPB); // at resolvesAt: full collateral against max loss
}

export const initialMargin = (m: Market, p: Position) => requirement(m, p, leverageNow(m).initial);
export const maintenanceMargin = (m: Market, p: Position) => requirement(m, p, leverageNow(m).maintenance);

/** Realized collateral that can leave the market while still covering initial margin. */
export function releasable(m: Market, p: Position): bigint {
  return max(0n, min(p.collateral, equity(p, m.mark) - initialMargin(m, p)));
}

// ---------- curve and oracle ----------

export const spotPrice = (c: Curve) => c.x / c.y; // nano-USD per token

/** Time-weighted average of the curve price over the oracle window ending now; null if no time has elapsed. */
function curveMark(o: CurveOracle, now: bigint, spot: bigint): bigint | null {
  if (o.window === 0n) return spot;
  const from = now - o.window;
  let weighted = 0n;
  let start: bigint | null = null;
  o.history.forEach((h, i) => {
    const segStart = h.t > from ? h.t : from;
    const segEnd = o.history[i + 1]?.t ?? now;
    if (segEnd <= segStart) return;
    start ??= segStart;
    weighted += h.price * (segEnd - segStart);
  });
  if (start === null || now === start) return null; // a zero-width window says nothing: keep the previous mark
  return weighted / (now - start);
}

/** Record the current spot price and recompute the mark. Returns a mark effect if it moved. */
function refreshOracle(s: State, m: Market): Effect[] {
  if (!m.curve || !m.oracle) return [];
  const spot = spotPrice(m.curve);
  const h = m.oracle.history;
  const last = h[h.length - 1];
  if (last && last.t === s.time) last.price = spot;
  else if (!last || last.price !== spot) h.push({ t: s.time, price: spot });
  // Drop change points that ended before the window began (keep the one straddling its start).
  while (h.length > 1 && h[1]!.t <= s.time - m.oracle.window) h.shift();
  const before = m.mark!;
  m.mark = curveMark(m.oracle, s.time, spot) ?? before;
  return m.mark === before ? [] : [{ kind: "mark", market: m.id, from: before, to: m.mark, spot }];
}

// ---------- fills ----------

/** Apply a signed fill of `d` units at price `x`. Returns realized PnL. */
function fill(p: Position, d: bigint, x: bigint): bigint {
  let realized = 0n;
  if (p.size !== 0n && sign(d) !== sign(p.size)) {
    const r = min(abs(d), abs(p.size));
    const basisRemoved = (p.basis * r) / abs(p.size); // truncation stays inside this position
    realized = -sign(d) * r * x - basisRemoved;
    p.basis -= basisRemoved;
    p.collateral += realized;
    p.size += sign(d) * r;
    d -= sign(d) * r;
  }
  if (d !== 0n) {
    p.size += d;
    p.basis += d * x;
  }
  p.realized += realized;
  return realized;
}

// ---------- lookups and parsing ----------

function getAccount(s: State, id: string): Account {
  const a = s.accounts[id];
  if (!a) throw new Rejected(`unknown account "${id}"`);
  return a;
}

function getMarket(s: State, id: string): Market {
  const m = s.markets[id];
  if (!m) throw new Rejected(`unknown market "${id}"`);
  return m;
}

function getPosition(m: Market, account: string): Position {
  const p = m.positions[account];
  if (!p) throw new Rejected(`${account} has no collateral in ${m.id}`);
  return p;
}

function parsePrice(m: Market, p: string): bigint {
  const v = parseFixed(p);
  if (v < m.config.lower || (m.config.upper !== null && v > m.config.upper)) {
    const hi = m.config.upper === null ? "∞" : fmtPrice(m.config.upper);
    throw new Rejected(`price ${p} outside [${fmtPrice(m.config.lower)}, ${hi}] for ${m.id}`);
  }
  if (v <= 0n && m.config.upper === null) throw new Rejected("unbounded markets need a positive price");
  return v;
}

function parseAmount(amount: Amount, available: bigint, what: string): bigint {
  const v = amount === "all" ? available : parseFixed(amount);
  if (v <= 0n) throw new Rejected(amount === "all" ? `nothing to ${what}` : `${what} must be positive`);
  if (v > available) throw new Rejected(`${what} $${fmtUsd(v)} exceeds available $${fmtUsd(available)}`);
  return v;
}

// ---------- event handlers ----------

function onMarket(s: State, e: Extract<Event, { type: "market" }>) {
  if (s.markets[e.id]) throw new Rejected(`market ${e.id} exists`);
  const binary = e.preset === "binary";
  const attention = e.preset === "attention";
  const [lo, hi] = e.bounds ?? (binary ? ["0", "1"] : ["0", null]);
  const config: MarketConfig = {
    lower: parseFixed(lo),
    upper: hi === null ? null : parseFixed(hi),
    resolvable: e.resolvable ?? binary,
    initialLeverage: BigInt(e.initialLeverage ?? DEFAULT_LEVERAGE.initial),
    maintenanceLeverage: BigInt(e.maintenanceLeverage ?? DEFAULT_LEVERAGE.maintenance),
    adl: e.adl ?? "size",
    graduation: e.graduation ?? true,
    funding: e.funding ?? true,
    resolvesAt: e.resolvesAt === undefined ? null : BigInt(e.resolvesAt),
    taperSeconds: BigInt(e.taperSeconds ?? 0),
  };
  if (config.lower < 0n || (config.upper !== null && config.upper <= config.lower)) throw new Rejected("bad bounds");
  if (config.adl !== "size" && config.adl !== "pnl") throw new Rejected(`unknown ADL policy ${config.adl}`);
  if ((config.resolvesAt !== null || config.taperSeconds > 0n) && !config.resolvable) throw new Rejected("only resolvable markets can schedule resolution");
  if (config.taperSeconds < 0n || (config.taperSeconds > 0n && config.resolvesAt === null)) throw new Rejected("taper needs resolvesAt");
  if (config.initialLeverage < 1n || config.maintenanceLeverage < config.initialLeverage) {
    throw new Rejected("need 1 ≤ initialLeverage ≤ maintenanceLeverage");
  }
  let curve: Curve | null = null;
  let oracle: CurveOracle | null = null;
  if (e.launch && !(attention || e.curve)) throw new Rejected("only curve markets can launch");
  if (attention || e.curve) {
    const x0 = parseFixed(e.curve?.usdc ?? "5000");
    const y0 = BigInt(e.curve?.tokens ?? 1_000_000_000);
    if (x0 <= 0n || y0 <= 0n) throw new Rejected("curve reserves must be positive");
    const feeBps = BigInt(e.feeBps ?? 100);
    if (feeBps < 0n || feeBps >= 10_000n) throw new Rejected("feeBps must be in [0, 10000)");
    curve = { x0, y0, x: x0, y: y0, feeBps };
    oracle = { window: BigInt(e.oracleWindow ?? 0), history: [{ t: s.time, price: spotPrice(curve) }] };
  }
  s.markets[e.id] = {
    id: e.id,
    config,
    curve,
    oracle,
    launch: e.launch ? { open: false, bids: {}, reserve: 0n } : null,
    mark: curve ? spotPrice(curve) : null,
    time: s.time,
    tier: 0,
    volume: 0n,
    lastTrade: null,
    mid: null,
    fundingRate: 0n,
    status: "open",
    vault: 0n,
    positions: {},
  };
  updateFundingRate(s.markets[e.id]!);
}

function onDeposit(s: State, e: Extract<Event, { type: "deposit" }>) {
  const amt = parseFixed(e.amount);
  if (amt <= 0n) throw new Rejected("deposit must be positive");
  const a = (s.accounts[e.account] ??= { id: e.account, wallet: 0n, spot: {}, deposited: 0n, withdrawn: 0n });
  a.wallet += amt;
  a.deposited += amt;
  s.totalDeposits += amt;
}

function onWithdraw(s: State, e: Extract<Event, { type: "withdraw" }>) {
  const a = getAccount(s, e.account);
  const amt = parseAmount(e.amount, a.wallet, "withdraw");
  a.wallet -= amt;
  a.withdrawn += amt;
  s.totalWithdrawals += amt;
}

function onAllocate(s: State, e: Extract<Event, { type: "allocate" }>) {
  const a = getAccount(s, e.account);
  const m = getMarket(s, e.market);
  const amt = parseAmount(e.amount, a.wallet, "allocate");
  const p = (m.positions[a.id] ??= {
    account: a.id,
    collateral: 0n,
    size: 0n,
    basis: 0n,
    allocated: 0n,
    realized: 0n,
    adlTransfer: 0n,
    funding: 0n,
  });
  a.wallet -= amt;
  p.collateral += amt;
  p.allocated += amt;
  m.vault += amt;
}

function onRelease(s: State, e: Extract<Event, { type: "release" }>) {
  const a = getAccount(s, e.account);
  const m = getMarket(s, e.market);
  const p = getPosition(m, a.id);
  const amt = parseAmount(e.amount, releasable(m, p), "release");
  p.collateral -= amt;
  p.allocated -= amt;
  m.vault -= amt;
  a.wallet += amt;
}

function onTrade(s: State, e: Extract<Event, { type: "trade" }>): Effect[] {
  const m = getMarket(s, e.market);
  if (m.status !== "open") throw new Rejected(`${m.id} is resolved`);
  assertLaunched(m);
  if (m.mark === null) throw new Rejected(`${m.id} has no oracle price yet`);
  if (e.buyer === e.seller) throw new Rejected("self-trade");
  const size = BigInt(e.size);
  if (size <= 0n) throw new Rejected("size must be positive");
  const price = parsePrice(m, e.price);
  const parties: [Position, bigint][] = [
    [getPosition(m, e.buyer), size],
    [getPosition(m, e.seller), -size],
  ];
  for (const [p, d] of parties) {
    const before = p.size;
    fill(p, d, price);
    const reduceOnly = abs(p.size) < abs(before) && sign(p.size) !== -sign(before);
    const eq = equity(p, m.mark);
    const need = reduceOnly ? maintenanceMargin(m, p) : initialMargin(m, p);
    if (eq < need) {
      throw new Rejected(`${p.account}: equity $${fmtUsd(eq)} below ${reduceOnly ? "maintenance" : "initial"} margin $${fmtUsd(need)}`);
    }
  }
  m.volume += size * price;
  m.lastTrade = price;
  const effects = graduate(m);
  updateFundingRate(m);
  return effects;
}

// ---------- graduation and funding ----------

/** Depth proxy: open-interest notional at mark, plus real USDC in the spot curve. */
export function depth(m: Market): bigint {
  const oi = positionsOf(m).reduce((sum, p) => (p.size > 0n ? sum + p.size : sum), 0n);
  return oi * (m.mark ?? 0n) + (m.curve ? m.curve.x - m.curve.x0 : 0n);
}

function graduate(m: Market): Effect[] {
  if (!m.config.graduation || m.mark === null) return [];
  const effects: Effect[] = [];
  while (m.tier < GRADUATION.length) {
    const next = GRADUATION[m.tier]!;
    if (m.volume < next.volume || depth(m) < next.depth) break;
    m.tier += 1;
    effects.push({ kind: "graduation", market: m.id, tier: m.tier, leverage: next.leverage });
  }
  return effects;
}

function updateFundingRate(m: Market) {
  if (!m.config.funding || m.mark === null || m.mark === 0n) {
    m.fundingRate = 0n;
    return;
  }
  const base = FUNDING_BASE_PPB[m.tier]!;
  // The perp price is the book mid, else the last trade. A last trade goes stale when the oracle gaps; the
  // book is re-quoted around the new mark.
  const perp = m.mid ?? m.lastTrade;
  let premium = perp === null ? 0n : ((perp - m.mark) * PPB) / m.mark / 8n;
  if (premium > FUNDING_PREMIUM_CAP_PPB) premium = FUNDING_PREMIUM_CAP_PPB;
  if (premium < -FUNDING_PREMIUM_CAP_PPB) premium = -FUNDING_PREMIUM_CAP_PPB;
  m.fundingRate = base + premium;
}

/** Accrue `dt` seconds of funding at the current rate: exact transfer, payers and receivers each pro-rata by size. */
function accrueFunding(m: Market, dt: bigint): Effect[] {
  if (!m.config.funding || m.fundingRate === 0n || m.mark === null) return [];
  const longs = positionsOf(m).filter((p) => p.size > 0n);
  const shorts = positionsOf(m).filter((p) => p.size < 0n);
  const oi = longs.reduce((sum, p) => sum + p.size, 0n);
  if (oi === 0n) return [];
  const rate = m.fundingRate;
  const total = (oi * m.mark * abs(rate) * dt) / (3600n * PPB);
  if (total === 0n) return [];
  const [payers, receivers] = rate > 0n ? [longs, shorts] : [shorts, longs];
  const paid = allocate(total, payers.map((p) => ({ key: p.account, weight: abs(p.size) })));
  const got = allocate(total, receivers.map((p) => ({ key: p.account, weight: abs(p.size) })));
  for (const p of payers) {
    p.collateral -= paid.get(p.account)!;
    p.funding -= paid.get(p.account)!;
  }
  for (const p of receivers) {
    p.collateral += got.get(p.account)!;
    p.funding += got.get(p.account)!;
  }
  return [{ kind: "funding", market: m.id, rate, seconds: dt, total, payers: rate > 0n ? "long" : "short" }];
}

/**
 * Profit an absorber has made in this market: equity above their net allocation, capped at equity. If they have
 * already released more than they put in, their principal is out and all remaining equity counts as profit.
 */
const positivePnl = (p: Position, mark: bigint) => min(equity(p, mark), max(0n, equity(p, mark) - p.allocated));

/** How much of a haircut `h` came out of principal rather than profit. */
const principalPart = (p: Position, mark: bigint, h: bigint) => max(0n, h - positivePnl(p, mark));

/** Capped pro-rata on positive PnL, falling back to principal pro-rata by remaining equity. */
function pnlHaircuts(opposing: Position[], mark: bigint, dTotal: bigint) {
  const profit = opposing.map((p) => ({ key: p.account, weight: positivePnl(p, mark) }));
  const totalProfit = profit.reduce((sum, w) => sum + w.weight, 0n);
  const fromProfit = allocate(min(dTotal, totalProfit), profit); // each part ≤ its weight, so principal is untouched
  const rest = dTotal - min(dTotal, totalProfit);
  const remaining = opposing.map((p) => ({ key: p.account, weight: equity(p, mark) - fromProfit.get(p.account)! }));
  const fromPrincipal = allocate(rest, remaining); // each part ≤ remaining equity, so no absorber goes negative
  const haircuts = new Map(opposing.map((p) => [p.account, fromProfit.get(p.account)! + fromPrincipal.get(p.account)!]));
  return { haircuts, fromPrincipal };
}

/** Liquidation + ADL loop for one market. Reads and writes nothing outside `m`. */
function resolveDistress(m: Market): Effect[] {
  const effects: Effect[] = [];
  const mark = m.mark!;
  for (;;) {
    const allDistressed = positionsOf(m).filter((p) => p.size !== 0n && equity(p, mark) < maintenanceMargin(m, p));
    if (allDistressed.length === 0) return effects;

    // A price move only distresses one side, but a taper (requirements rising for everyone) can distress both.
    // Handle one side per round: the side with a bankrupt position first, otherwise the first distressed side.
    // Closing at mark doesn't change anyone's equity, so the other side is re-examined next round.
    const bankrupt = allDistressed.find((p) => equity(p, mark) < 0n);
    const side = sign((bankrupt ?? allDistressed[0]!).size);
    const distressed = allDistressed.filter((p) => sign(p.size) === side);
    const opposing = positionsOf(m).filter((p) => sign(p.size) === -side);

    let qTotal = 0n;
    let dTotal = 0n;
    for (const p of distressed) {
      const eq = equity(p, mark);
      qTotal += abs(p.size);
      if (eq < 0n) {
        dTotal += -eq;
        effects.push({ kind: "bankrupt", market: m.id, account: p.account, size: p.size, shortfall: -eq });
      } else {
        effects.push({ kind: "liquidation", market: m.id, account: p.account, size: p.size, equity: eq, maintenance: maintenanceMargin(m, p) });
      }
    }

    const weights = opposing.map((p) => ({ key: p.account, weight: abs(p.size) }));
    const closes = allocate(qTotal, weights);
    const { haircuts, fromPrincipal } = m.config.adl === "pnl" ? pnlHaircuts(opposing, mark, dTotal) : { haircuts: allocate(dTotal, weights), fromPrincipal: new Map<string, bigint>() };

    // Close distressed positions fully at mark; take the other side pro-rata at mark.
    const forced: ForcedClose[] = [];
    for (const p of distressed) {
      forced.push({ account: p.account, closed: -p.size, price: mark });
      fill(p, -p.size, mark);
    }
    for (const p of opposing) {
      const r = closes.get(p.account)!;
      if (r > abs(p.size)) throw new Error(`invariant: ADL closes ${r} > position ${p.size} for ${p.account}`);
      if (r === 0n) continue;
      forced.push({ account: p.account, closed: side * r, price: mark });
      fill(p, side * r, mark);
    }
    effects.push({ kind: "forcedClose", market: m.id, closes: forced });

    // Move the shortfall from absorbers to bankrupt positions.
    for (const p of opposing) {
      const h = haircuts.get(p.account)!;
      if (h === 0n) continue;
      if (h > equity(p, mark)) throw new Error(`invariant: haircut ${h} exceeds equity of ${p.account}`);
      const principal = fromPrincipal.get(p.account) ?? principalPart(p, mark, h);
      p.collateral -= h;
      p.adlTransfer -= h;
      effects.push({ kind: "haircut", market: m.id, account: p.account, amount: h, fromPrincipal: principal });
    }
    for (const p of distressed) {
      const eq = equity(p, mark);
      if (eq < 0n) {
        p.collateral += -eq;
        p.adlTransfer += -eq;
      }
    }
  }
}

function onBook(s: State, e: Extract<Event, { type: "book" }>) {
  const m = getMarket(s, e.market);
  if (m.status !== "open") throw new Rejected(`${m.id} is resolved`);
  m.mid = e.mid === null ? null : parsePrice(m, e.mid);
  updateFundingRate(m);
}

function onTick(s: State, e: { market: string; price: string }): Effect[] {
  const m = getMarket(s, e.market);
  if (m.status !== "open") throw new Rejected(`${m.id} is resolved`);
  if (m.curve) throw new Rejected(`${m.id} is priced by its own curve, not an external tick`);
  m.mark = parsePrice(m, e.price);
  const effects = resolveDistress(m);
  updateFundingRate(m);
  return effects;
}

const fee = (gross: bigint, bps: bigint) => ceilDiv(gross * bps, 10_000n);

function getCurve(m: Market): Curve {
  if (!m.curve) throw new Rejected(`${m.id} has no spot curve`);
  if (m.status !== "open") throw new Rejected(`${m.id} is resolved`);
  return m.curve;
}

/** Spot and perp trading wait for a launch's open. */
function assertLaunched(m: Market) {
  if (m.launch && !m.launch.open) throw new Rejected(`${m.id} is in its snipe window: trading starts at the open`);
}

function pendingLaunch(m: Market): Launch {
  if (!m.launch) throw new Rejected(`${m.id} has no launch`);
  if (m.launch.open) throw new Rejected(`${m.id} is already open`);
  return m.launch;
}

function onSnipe(s: State, e: Extract<Event, { type: "snipe" }>) {
  const a = getAccount(s, e.account);
  const m = getMarket(s, e.market);
  const c = getCurve(m);
  const launch = pendingLaunch(m);
  const usdc = parseAmount(e.amount, a.wallet, "snipe");
  const f = fee(usdc, c.feeBps); // the spot fee applies to snipes too
  if (usdc - f <= 0n) throw new Rejected("snipe too small");
  a.wallet -= usdc;
  s.fees += f;
  launch.bids[a.id] = (launch.bids[a.id] ?? 0n) + usdc - f;
}

/**
 * The open: all bids B buy from the curve together, at one price. The curve moves from (x0, y0) to (x1, y1) with
 *   x1 = (x0 + √(x0·(x0 + 4B))) / 2,  y1 = ⌈x0·y0 / x1⌉,  open price x1 / y1,
 * the point where buying y0 − y1 tokens at the open price costs B: x1·(x1 − x0) = x0·B. Only x1 − x0 enters the
 * curve; the rest of B stays in the market as its launch reserve. Tokens split pro-rata by bid (largest remainder).
 */
/** Where a launch's curve opens for total bids `B`: [x1, y1]. See onOpen. */
export function openCurve(x0: bigint, y0: bigint, B: bigint): [bigint, bigint] {
  const x1 = (x0 + isqrt(x0 * (x0 + 4n * B))) / 2n;
  return [x1, ceilDiv(x0 * y0, x1)];
}

function onOpen(s: State, e: Extract<Event, { type: "open" }>): Effect[] {
  const m = getMarket(s, e.market);
  const c = getCurve(m);
  const launch = pendingLaunch(m);
  const bids = Object.keys(launch.bids)
    .sort()
    .map((account) => ({ key: account, weight: launch.bids[account]! }));
  const B = bids.reduce((sum, b) => sum + b.weight, 0n);
  const x0 = c.x;
  const [x1, y1] = openCurve(x0, c.y, B);
  const tokens = c.y - y1;
  const split = allocate(tokens, bids);
  const fills: LaunchFill[] = [];
  for (const b of bids) {
    const t = split.get(b.key)!;
    fills.push({ account: b.key, usdc: b.weight, tokens: t });
    if (t > 0n) s.accounts[b.key]!.spot[m.id] = (s.accounts[b.key]!.spot[m.id] ?? 0n) + t;
  }
  c.x = x1;
  c.y = y1;
  m.launch = { open: true, bids: {}, reserve: B - (x1 - x0) };
  // The oracle restarts at the open price as if it had held for a whole window: nobody could trade the curve
  // before the open, and a pump right after it must take a full window to move a TWAP mark.
  const before = m.mark!;
  const price = spotPrice(c);
  m.oracle!.history = [{ t: s.time - m.oracle!.window, price }];
  m.mark = price;
  const effects: Effect[] = [{ kind: "open", market: m.id, price, sniped: B, tokens, reserve: m.launch.reserve, fills }];
  if (price !== before) effects.push({ kind: "mark", market: m.id, from: before, to: price, spot: price });
  effects.push(...graduate(m));
  updateFundingRate(m);
  return effects;
}

function onSpotBuy(s: State, e: Extract<Event, { type: "spotBuy" }>): Effect[] {
  const a = getAccount(s, e.account);
  const m = getMarket(s, e.market);
  const c = getCurve(m);
  assertLaunched(m);
  const usdc = parseAmount(e.amount, a.wallet, "spend");
  const f = fee(usdc, c.feeBps);
  const priceBefore = spotPrice(c);
  const k = c.x * c.y;
  const x = c.x + usdc - f;
  const y = ceilDiv(k, x); // round in the curve's favour
  const tokens = c.y - y;
  if (tokens <= 0n) throw new Rejected("buy too small");
  a.wallet -= usdc;
  a.spot[m.id] = (a.spot[m.id] ?? 0n) + tokens;
  s.fees += f;
  c.x = x;
  c.y = y;
  const spot: Effect = { kind: "spot", market: m.id, account: a.id, usdc, tokens, fee: f, priceBefore, priceAfter: spotPrice(c) };
  const effects = [spot, ...refreshOracle(s, m), ...resolveDistress(m), ...graduate(m)];
  updateFundingRate(m);
  return effects;
}

function onSpotSell(s: State, e: Extract<Event, { type: "spotSell" }>): Effect[] {
  const a = getAccount(s, e.account);
  const m = getMarket(s, e.market);
  const c = getCurve(m);
  assertLaunched(m);
  const held = a.spot[m.id] ?? 0n;
  const tokens = e.tokens === "all" ? held : BigInt(e.tokens);
  if (tokens <= 0n) throw new Rejected("nothing to sell");
  if (tokens > held) throw new Rejected(`sell ${tokens} exceeds holdings ${held}`);
  const priceBefore = spotPrice(c);
  const k = c.x * c.y;
  const y = c.y + tokens;
  const x = ceilDiv(k, y); // round in the curve's favour
  const gross = c.x - x;
  const f = fee(gross, c.feeBps);
  if (gross - f <= 0n) throw new Rejected("sell too small");
  a.spot[m.id] = held - tokens;
  a.wallet += gross - f;
  s.fees += f;
  c.x = x;
  c.y = y;
  const spot: Effect = { kind: "spot", market: m.id, account: a.id, usdc: -(gross - f), tokens: -tokens, fee: f, priceBefore, priceAfter: spotPrice(c) };
  const effects = [spot, ...refreshOracle(s, m), ...resolveDistress(m)];
  updateFundingRate(m);
  return effects;
}

function onAdvance(s: State, e: Extract<Event, { type: "advance" }>): Effect[] {
  const dt = BigInt(e.seconds);
  if (dt <= 0n) throw new Rejected("advance must be positive");
  s.time += dt;
  return marketIds(s).flatMap((id) => {
    const m = s.markets[id]!;
    m.time = s.time;
    if (m.status !== "open") return [];
    // Each step is its own risk round, so every round starts from a solvent state.
    // Funding at the rate held since the last event; the taper may also have raised requirements.
    const effects = [...accrueFunding(m, dt), ...resolveDistress(m)];
    effects.push(...refreshOracle(s, m), ...resolveDistress(m), ...graduate(m));
    updateFundingRate(m);
    return effects;
  });
}

function onResolve(s: State, e: Extract<Event, { type: "resolve" }>): Effect[] {
  const m = getMarket(s, e.market);
  if (!m.config.resolvable) throw new Rejected(`${m.id} is not resolvable`);
  if (m.config.resolvesAt !== null && s.time < m.config.resolvesAt) throw new Rejected(`${m.id} resolves at t=${m.config.resolvesAt}s (now t=${s.time}s)`);
  const effects = onTick(s, e);
  const price = m.mark!;
  const closes: ForcedClose[] = [];
  for (const p of positionsOf(m)) {
    if (p.size === 0n) continue;
    closes.push({ account: p.account, closed: -p.size, price });
    fill(p, -p.size, price);
  }
  effects.push({ kind: "settlement", market: m.id, price, closes });
  m.status = "resolved";
  return effects;
}

// ---------- invariants ----------

export function checkMarket(m: Market): string[] {
  const errs: string[] = [];
  let netSize = 0n;
  let allocated = 0n;
  let collateralMinusBasis = 0n;
  let sumEquity = 0n;
  let sumReleasable = 0n;
  for (const p of positionsOf(m)) {
    const id = `${m.id}/${p.account}`;
    netSize += p.size;
    allocated += p.allocated;
    collateralMinusBasis += p.collateral - p.basis;
    if (p.size !== 0n && m.mark === null) {
      errs.push(`${id}: position without mark`);
      continue;
    }
    const eq = equity(p, m.mark);
    sumEquity += eq;
    if (eq < 0n) errs.push(`${id}: negative equity ${eq}`);
    if (p.size !== 0n && eq < maintenanceMargin(m, p)) errs.push(`${id}: below maintenance margin`);
    const r = releasable(m, p);
    if (r > eq) errs.push(`${id}: releasable ${r} > equity ${eq}`);
    sumReleasable += r;
    if (p.collateral !== p.allocated + p.realized + p.adlTransfer + p.funding) errs.push(`${id}: ledger mismatch`);
    if (m.status === "resolved" && (p.size !== 0n || p.basis !== 0n)) errs.push(`${id}: open position after resolution`);
  }
  if (netSize !== 0n) errs.push(`${m.id}: unbalanced exposure Σsize = ${netSize}`);
  if (allocated !== m.vault) errs.push(`${m.id}: vault ${m.vault} != Σallocated ${allocated}`);
  if (collateralMinusBasis !== m.vault) errs.push(`${m.id}: Σ(collateral − basis) ${collateralMinusBasis} != vault ${m.vault}`);
  if (sumEquity !== m.vault) errs.push(`${m.id}: Σequity ${sumEquity} != vault ${m.vault}`);
  if (sumReleasable > m.vault) errs.push(`${m.id}: Σreleasable > vault`);
  if (m.curve) {
    const c = m.curve;
    if (c.x < c.x0) errs.push(`${m.id}: curve holds negative USDC`);
    if (c.x * c.y < c.x0 * c.y0) errs.push(`${m.id}: curve invariant k decreased`);
    if (c.y <= 0n) errs.push(`${m.id}: curve token reserve exhausted`);
  }
  return errs;
}

export function checkInvariants(s: State): string[] {
  const errs = marketIds(s).flatMap((id) => checkMarket(s.markets[id]!));
  for (const id of marketIds(s)) if (s.markets[id]!.time !== s.time) errs.push(`${id}: clock out of sync`);
  let wallets = 0n;
  for (const id of accountIds(s)) {
    const a = s.accounts[id]!;
    wallets += a.wallet;
    if (a.wallet < 0n) errs.push(`${id}: negative wallet`);
  }
  let held = 0n;
  for (const id of marketIds(s)) {
    const m = s.markets[id]!;
    held += m.vault;
    if (m.launch) {
      held += m.launch.reserve; // USDC the open didn't put in the curve
      for (const bid of Object.values(m.launch.bids)) held += bid; // bids waiting for the open
      if (m.launch.open && Object.keys(m.launch.bids).length > 0) errs.push(`${id}: bids left after the open`);
    }
    if (!m.curve) continue;
    held += m.curve.x - m.curve.x0; // real USDC sitting in the curve
    const tokens = accountIds(s).reduce((sum, a) => sum + (s.accounts[a]!.spot[id] ?? 0n), 0n);
    if (tokens !== m.curve.y0 - m.curve.y) errs.push(`${id}: Σ holdings ${tokens} != tokens sold ${m.curve.y0 - m.curve.y}`);
  }
  if (wallets + held + s.fees !== s.totalDeposits - s.totalWithdrawals) {
    errs.push(`wallets + vaults + curves + launches + fees ${wallets + held + s.fees} != deposits − withdrawals ${s.totalDeposits - s.totalWithdrawals}`);
  }
  return errs;
}

// ---------- apply / replay ----------

export function apply(state: State, event: Event): Result {
  const s = structuredClone(state);
  let effects: Effect[] = [];
  try {
    switch (event.type) {
      case "market":
        onMarket(s, event);
        break;
      case "deposit":
        onDeposit(s, event);
        break;
      case "withdraw":
        onWithdraw(s, event);
        break;
      case "allocate":
        onAllocate(s, event);
        break;
      case "release":
        onRelease(s, event);
        break;
      case "trade":
        effects = onTrade(s, event);
        break;
      case "tick":
        effects = onTick(s, event);
        break;
      case "resolve":
        effects = onResolve(s, event);
        break;
      case "spotBuy":
        effects = onSpotBuy(s, event);
        break;
      case "spotSell":
        effects = onSpotSell(s, event);
        break;
      case "advance":
        effects = onAdvance(s, event);
        break;
      case "snipe":
        onSnipe(s, event);
        break;
      case "open":
        effects = onOpen(s, event);
        break;
      case "book":
        onBook(s, event);
        break;
      default:
        throw new Rejected(`unknown event ${JSON.stringify(event)}`);
    }
  } catch (err) {
    if (err instanceof Rejected) return { ok: false, state, reason: err.message };
    throw err;
  }
  const errs = checkInvariants(s);
  if (errs.length) throw new Error(`invariant violation after ${JSON.stringify(event)}:\n  ${errs.join("\n  ")}`);
  s.seq += 1;
  return { ok: true, state: s, effects };
}

export interface Step {
  index: number;
  event: Event;
  before: State;
  result: Result;
}

export function replay(events: Event[]): { steps: Step[]; final: State } {
  let state = initialState();
  const steps: Step[] = [];
  events.forEach((event, index) => {
    const result = apply(state, event);
    steps.push({ index, event, before: state, result });
    state = result.state;
  });
  return { steps, final: state };
}
