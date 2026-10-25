// The exchange: a central limit order book per market in front of the Impulse risk engine.
//
// The engine owns every dollar (wallets, per-market collateral, positions) and runs liquidation and ADL inside
// each transition. The exchange owns what the engine doesn't model: resting orders, matching, account keys,
// market metadata, and history. Every match becomes one atomic engine transaction:
//   allocate margin for each side (auto-margin, isolated) → trade at the maker's price
// and either commits whole or not at all. Feed ticks, curve trades and the clock are engine events too, so
// "solvent after every transition" holds for the live venue exactly as it does in replay.

import { randomBytes } from "node:crypto";
import {
  type Effect,
  type Event,
  type Market,
  type Position,
  type State,
  apply,
  equity,
  initialMargin,
  initialState,
  leverageNow,
} from "../../src/engine.js";
import { abs, ceilDiv, max, min, sign } from "../../src/fixed.js";
import { Book, type Order, type Side, type Tif } from "./book.js";
import { autoTick, coinPrice, coinsFromLots, dec, fmt, lotPrice, lotsFromCoins, parseFixed, pow10, usd } from "./units.js";

export class ExchangeError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

// ---------- types ----------

export type Source =
  | { kind: "hyperliquid"; coin: string; dex?: string }
  | { kind: "polymarket"; marketId: string; tokenId: string; outcome: string }
  | { kind: "curve" } // attention market: the perp's oracle is its own spot curve
  | { kind: "sim"; volBps: number } // offline random walk, volatility per step in bps
  | { kind: "manual" }; // admin ticks only

export type Kind = "perp" | "binary" | "attention";

export interface MarketMeta {
  id: string;
  name: string;
  kind: Kind;
  base: string;
  szDecimals: number; // one lot = 10^-szDecimals coins
  tick: bigint; // price increment, nano-USD per coin
  source: Source;
  description: string;
  url: string | null;
  createdAt: number;
  creator: string | null;
  resolvesAtMs: number | null;
  heldUntil: number | null; // admin price override: feed ticks are ignored until then
}

export interface MarketSpec {
  id: string;
  kind: Kind;
  source: Source;
  name?: string;
  base?: string;
  szDecimals?: number;
  tick?: string; // coin price
  price?: string; // first oracle price (coin price) for externally priced markets
  description?: string;
  url?: string;
  creator?: string;
  adl?: "size" | "pnl";
  oracleWindow?: number;
  feeBps?: number;
  resolvesAtMs?: number;
  taperSeconds?: number;
  initialLeverage?: number;
  maintenanceLeverage?: number;
}

export interface AccountMeta {
  id: string;
  apiKey: string;
  bot: boolean;
  createdAt: number;
  lastFaucet: number;
}

export interface Fill {
  id: number;
  time: number;
  market: string;
  kind: "perp" | "spot";
  price: bigint; // nano-USD per lot (spot: average incl. fee)
  size: bigint; // lots
  side: Side; // taker side
  taker: string;
  maker: string; // "curve" for spot
  takerOrder: number | null;
  makerOrder: number | null;
}

export type RiskKind = "liquidation" | "bankrupt" | "haircut" | "adl" | "settlement" | "graduation" | "gap" | "listing";

export interface RiskEvent {
  id: number;
  time: number;
  market: string;
  kind: RiskKind;
  accounts: string[];
  text: string;
  amount: string | null; // USD, where there is one
}

export interface Candle {
  t: number; // minute start, ms
  o: bigint; // mark, nano-USD per lot
  h: bigint;
  l: bigint;
  c: bigint;
  v: bigint; // traded notional, nano-USD
}

export interface OrderInput {
  market: string;
  side: Side;
  type: "limit" | "market";
  size: string; // coins
  price?: string; // coin price, limit orders
  leverage?: number;
  reduceOnly?: boolean;
  tif?: Tif;
  slippage?: number; // market orders: worst acceptable price as a fraction of mark (default 5%)
}

export interface OrderResult {
  order: Order;
  fills: Fill[];
  status: "filled" | "partial" | "resting" | "cancelled";
  reason: string | null;
}

export interface Snapshot {
  v: 1;
  savedAt?: number; // wall-clock ms
  genesis: number;
  state: State;
  markets: Record<string, MarketMeta>;
  orders: Order[];
  accounts: Record<string, AccountMeta>;
  fills: Fill[];
  risk: RiskEvent[];
  candles: Record<string, Candle[]>;
  nextId: number;
}

const FILL_HISTORY = 5000;
const RISK_HISTORY = 2000;
const CANDLES = 1440; // a day of 1m candles
export const FAUCET_AMOUNT = parseFixed("10000");
const FAUCET_CAP = parseFixed("100000");
const FAUCET_COOLDOWN_MS = 60_000;
const MAX_OPEN_ORDERS = 200;
const NAME = /^[a-z0-9_]{3,16}$/i;
const MARKET_ID = /^[A-Za-z0-9@_.-]{1,32}$/;

/** Dollars for human-readable feed text, rounded to cents. The event's `amount` field keeps the exact value. */
const cents = (v: bigint) => (Number(v) / 1e9).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const EMPTY_POSITION: Position = { account: "", collateral: 0n, size: 0n, basis: 0n, allocated: 0n, realized: 0n, adlTransfer: 0n, funding: 0n };

/** Did the engine reject a trade because of this account (its margin, or no collateral bucket at all)? */
const blames = (reason: string, account: string) => reason.startsWith(`${account}:`) || reason.startsWith(`${account} has no collateral`);

// ---------- exchange ----------

export class Exchange {
  state: State = initialState();
  genesis: number;
  markets: Record<string, MarketMeta> = {};
  books: Record<string, Book> = {};
  orders = new Map<number, Order>();
  accounts: Record<string, AccountMeta> = {};
  keys = new Map<string, string>(); // api key → account
  fills: Fill[] = [];
  risk: RiskEvent[] = [];
  candles: Record<string, Candle[]> = {};
  nextId = 1; // orders, fills and risk events share one counter
  version = 0; // bumps on every change; the websocket hub diffs on it
  readonly now: () => number;

  constructor(opts: { now?: () => number; genesis?: number } = {}) {
    this.now = opts.now ?? Date.now;
    this.genesis = opts.genesis ?? this.now();
  }

  // ---------- snapshot ----------

  toSnapshot(): Snapshot {
    return {
      v: 1,
      savedAt: this.now(),
      genesis: this.genesis,
      state: this.state,
      markets: this.markets,
      orders: [...this.orders.values()],
      accounts: this.accounts,
      fills: this.fills,
      risk: this.risk,
      candles: this.candles,
      nextId: this.nextId,
    };
  }

  static fromSnapshot(snap: Snapshot, opts: { now?: () => number } = {}): Exchange {
    if (snap.v !== 1) throw new Error(`unsupported snapshot version ${snap.v}`);
    const x = new Exchange({ now: opts.now, genesis: snap.genesis });
    x.state = snap.state;
    x.markets = snap.markets;
    x.accounts = snap.accounts;
    x.fills = snap.fills;
    x.risk = snap.risk;
    x.candles = snap.candles;
    x.nextId = snap.nextId;
    for (const id of Object.keys(x.markets)) x.books[id] = new Book();
    for (const o of [...snap.orders].sort((a, b) => a.id - b.id)) {
      x.orders.set(o.id, o);
      x.books[o.market]!.add(o);
    }
    for (const a of Object.values(x.accounts)) x.keys.set(a.apiKey, a.id);
    return x;
  }

  /**
   * Treat downtime as a pause: shift the clock origin so engine time resumes where it stopped. Otherwise a restart
   * would charge every open position the whole outage's funding (at whatever premium was last set) in one step.
   */
  resumeAfter(downMs: number) {
    if (downMs <= 0) return;
    this.genesis += downMs;
    for (const m of Object.values(this.markets)) {
      if (m.resolvesAtMs !== null) m.resolvesAtMs += downMs;
      if (m.heldUntil !== null) m.heldUntil += downMs;
    }
    this.version++;
  }

  // ---------- lookups ----------

  market(id: string): MarketMeta {
    const m = this.markets[id];
    if (!m) throw new ExchangeError(`unknown market "${id}"`, 404);
    return m;
  }

  engineMarket(id: string): Market {
    this.market(id);
    return this.state.markets[id]!;
  }

  account(id: string): AccountMeta {
    const a = this.accounts[id];
    if (!a) throw new ExchangeError(`unknown account "${id}"`, 404);
    return a;
  }

  accountByKey(key: string): AccountMeta | null {
    const id = this.keys.get(key);
    return id ? this.accounts[id]! : null;
  }

  ordersOf(account: string, market?: string): Order[] {
    return [...this.orders.values()].filter((o) => o.account === account && (market === undefined || o.market === market));
  }

  /** Engine time in seconds since genesis. */
  engineTime(ms = this.now()): bigint {
    return BigInt(Math.max(0, Math.floor((ms - this.genesis) / 1000)));
  }

  // ---------- engine transactions ----------

  /** Apply events in order to a copy of the state; commit only if all succeed. */
  private exec(events: Event[]): Effect[] {
    let s = this.state;
    const effects: Effect[] = [];
    for (const e of events) {
      const r = apply(s, e);
      if (!r.ok) throw new ExchangeError(r.reason);
      s = r.state;
      effects.push(...r.effects);
    }
    this.state = s;
    this.version++;
    return effects;
  }

  /** exec, then record what the engine did and hand idle collateral back to wallets. */
  private commit(events: Event[]): Effect[] {
    const effects = this.exec(events);
    this.digest(effects);
    this.sweep();
    return effects;
  }

  /** Collateral in a flat position goes back to the wallet (isolated margin is posted per fill, on demand). */
  private sweep() {
    const events: Event[] = [];
    for (const m of Object.values(this.state.markets)) {
      for (const p of Object.values(m.positions)) {
        if (p.size === 0n && p.collateral > 0n) events.push({ type: "release", account: p.account, market: m.id, amount: "all" });
      }
    }
    if (events.length === 0) return;
    try {
      this.exec(events);
    } catch (err) {
      console.error("sweep failed (collateral stays in the market):", (err as Error).message);
    }
  }

  private digest(effects: Effect[]) {
    const distressed = new Set<string>();
    for (const e of effects) {
      if (e.kind === "liquidation" || e.kind === "bankrupt") distressed.add(`${e.market}/${e.account}`);
    }
    for (const e of effects) {
      switch (e.kind) {
        case "liquidation": {
          const meta = this.markets[e.market]!;
          this.record(e.market, "liquidation", [e.account], `${e.account} liquidated: ${this.sideSize(meta, e.size)} closed at ${this.markStr(e.market)}, kept $${cents(e.equity)}`, e.equity);
          this.cancelAll(e.account, e.market);
          break;
        }
        case "bankrupt": {
          const meta = this.markets[e.market]!;
          this.record(e.market, "bankrupt", [e.account], `${e.account} bankrupt: ${this.sideSize(meta, e.size)} closed at ${this.markStr(e.market)}, $${cents(e.shortfall)} shortfall charged to the other side`, e.shortfall);
          this.cancelAll(e.account, e.market);
          break;
        }
        case "haircut":
          this.record(
            e.market,
            "haircut",
            [e.account],
            `${e.account} paid a $${cents(e.amount)} ADL haircut${e.fromPrincipal > 0n ? ` ($${cents(e.fromPrincipal)} of it from principal)` : " (from profit)"}`,
            e.amount,
          );
          break;
        case "forcedClose": {
          const meta = this.markets[e.market]!;
          for (const c of e.closes) {
            if (distressed.has(`${e.market}/${c.account}`)) continue;
            this.record(e.market, "adl", [c.account], `${c.account} auto-deleveraged: ${this.sideSize(meta, -c.closed)} force-closed at ${fmt(coinPrice(meta, c.price), 0)}`, null);
          }
          break;
        }
        case "settlement": {
          const meta = this.markets[e.market]!;
          this.record(e.market, "settlement", e.closes.map((c) => c.account), `${e.market} resolved at ${fmt(coinPrice(meta, e.price), 0)}; ${e.closes.length} positions settled`, null);
          for (const o of [...this.orders.values()]) if (o.market === e.market) this.removeOrder(o);
          break;
        }
        case "graduation":
          this.record(e.market, "graduation", [], `${e.market} graduated to tier ${e.tier}: max leverage now ${e.leverage}×`, null);
          break;
        case "mark":
          this.candle(e.market, e.to, 0n);
          break;
        case "spot": {
          const tokens = abs(e.tokens);
          const fill: Fill = {
            id: this.nextId++,
            time: this.now(),
            market: e.market,
            kind: "spot",
            price: abs(e.usdc) / tokens,
            size: tokens,
            side: e.tokens > 0n ? "buy" : "sell",
            taker: e.account,
            maker: "curve",
            takerOrder: null,
            makerOrder: null,
          };
          this.pushFill(fill);
          this.candle(e.market, this.state.markets[e.market]!.mark!, abs(e.usdc));
          break;
        }
        default:
          break; // funding accrues every clock step; positions carry the running total
      }
    }
  }

  private sideSize(meta: MarketMeta, size: bigint): string {
    const [int, frac] = coinsFromLots(meta, abs(size)).split(".");
    const grouped = BigInt(int!).toLocaleString("en-US") + (frac ? `.${frac}` : "");
    return `${size > 0n ? "long" : "short"} ${grouped} ${meta.base}`;
  }

  private markStr(market: string): string {
    const meta = this.markets[market]!;
    return fmt(coinPrice(meta, this.state.markets[market]!.mark!), 0);
  }

  record(market: string, kind: RiskKind, accounts: string[], text: string, amount: bigint | null) {
    this.risk.push({ id: this.nextId++, time: this.now(), market, kind, accounts, text, amount: amount === null ? null : usd(amount) });
    if (this.risk.length > RISK_HISTORY) this.risk.splice(0, this.risk.length - RISK_HISTORY);
  }

  private pushFill(f: Fill) {
    this.fills.push(f);
    if (this.fills.length > FILL_HISTORY) this.fills.splice(0, this.fills.length - FILL_HISTORY);
  }

  candle(market: string, lotPx: bigint, volume: bigint, at = this.now()) {
    const t = Math.floor(at / 60_000) * 60_000;
    const cs = (this.candles[market] ??= []);
    const last = cs[cs.length - 1];
    if (last && last.t > t) return;
    if (last && last.t === t) {
      last.h = max(last.h, lotPx);
      last.l = min(last.l, lotPx);
      last.c = lotPx;
      last.v += volume;
      return;
    }
    const o = last?.c ?? lotPx;
    cs.push({ t, o, h: max(o, lotPx), l: min(o, lotPx), c: lotPx, v: volume });
    if (cs.length > CANDLES) cs.splice(0, cs.length - CANDLES);
  }

  // ---------- accounts and money ----------

  createAccount(name: string, opts: { bot?: boolean } = {}): AccountMeta {
    const id = name.trim();
    if (!NAME.test(id)) throw new ExchangeError("name must be 3–16 letters, digits or _");
    if (["curve", "admin"].includes(id.toLowerCase())) throw new ExchangeError(`"${id}" is reserved`, 409);
    if (Object.keys(this.accounts).some((a) => a.toLowerCase() === id.toLowerCase())) throw new ExchangeError(`name "${id}" is taken`, 409);
    const meta: AccountMeta = { id, apiKey: randomBytes(24).toString("base64url"), bot: !!opts.bot, createdAt: this.now(), lastFaucet: 0 };
    this.accounts[id] = meta;
    this.keys.set(meta.apiKey, id);
    this.version++;
    return meta;
  }

  /** Paper money in. Bypasses the faucet's limits: for bots, tests and admin. */
  deposit(account: string, amount: string) {
    this.account(account);
    this.commit([{ type: "deposit", account, amount }]);
  }

  faucet(account: string): bigint {
    const meta = this.account(account);
    const wallet = this.state.accounts[account]?.wallet ?? 0n;
    if (wallet >= FAUCET_CAP) throw new ExchangeError(`wallet already holds $${usd(wallet)}; the faucet stops at $${usd(FAUCET_CAP)}`);
    const wait = meta.lastFaucet + FAUCET_COOLDOWN_MS - this.now();
    if (wait > 0) throw new ExchangeError(`faucet cooling down: try again in ${Math.ceil(wait / 1000)}s`, 429);
    this.commit([{ type: "deposit", account, amount: dec(FAUCET_AMOUNT) }]);
    meta.lastFaucet = this.now();
    return FAUCET_AMOUNT;
  }

  withdraw(account: string, amount: string) {
    this.account(account);
    this.commit([{ type: "withdraw", account, amount }]);
  }

  /** Add (positive) or remove (negative) isolated margin on an open position. */
  adjustMargin(account: string, market: string, amount: string) {
    this.account(account);
    const m = this.engineMarket(market);
    const p = m.positions[account];
    if (!p || p.size === 0n) throw new ExchangeError(`no open position in ${market}`);
    let v: bigint;
    try {
      v = parseFixed(amount);
    } catch (err) {
      throw new ExchangeError((err as Error).message);
    }
    if (v === 0n) throw new ExchangeError("amount must be non-zero");
    this.commit([v > 0n ? { type: "allocate", account, market, amount: dec(v) } : { type: "release", account, market, amount: dec(-v) }]);
  }

  // ---------- markets and prices ----------

  createMarket(spec: MarketSpec): MarketMeta {
    if (!MARKET_ID.test(spec.id)) throw new ExchangeError("market id must be 1–32 letters, digits or @_.-");
    if (this.markets[spec.id]) throw new ExchangeError(`market ${spec.id} exists`, 409);
    const kind = spec.kind;
    const sz = kind === "perp" ? (spec.szDecimals ?? 0) : 0;
    const start = spec.price ? parseFixed(spec.price) : null;
    if (kind !== "attention" && spec.source.kind !== "manual" && start === null) throw new ExchangeError("externally priced markets need a starting price");
    const tick = spec.tick ? parseFixed(spec.tick) : kind === "binary" ? 1_000_000n : kind === "attention" ? 1n : autoTick(start ?? 10n ** 9n, sz);
    if (tick <= 0n || tick % pow10(sz) !== 0n) throw new ExchangeError("tick must be a positive whole number of nano-USD per lot");
    const resolvesAt = spec.resolvesAtMs === undefined ? undefined : Number(this.engineTime(spec.resolvesAtMs));
    const event: Event = {
      type: "market",
      id: spec.id,
      preset: kind,
      adl: spec.adl ?? "pnl",
      ...(spec.oracleWindow !== undefined && { oracleWindow: spec.oracleWindow }),
      ...(spec.feeBps !== undefined && { feeBps: spec.feeBps }),
      ...(resolvesAt !== undefined && { resolvesAt }),
      ...(spec.taperSeconds !== undefined && { taperSeconds: spec.taperSeconds }),
      ...(spec.initialLeverage !== undefined && { initialLeverage: spec.initialLeverage }),
      ...(spec.maintenanceLeverage !== undefined && { maintenanceLeverage: spec.maintenanceLeverage }),
    };
    const meta: MarketMeta = {
      id: spec.id,
      name: spec.name ?? spec.id,
      kind,
      base: spec.base ?? (kind === "binary" ? "YES" : spec.id),
      szDecimals: sz,
      tick,
      source: spec.source,
      description: spec.description ?? "",
      url: spec.url ?? null,
      createdAt: this.now(),
      creator: spec.creator ?? null,
      resolvesAtMs: spec.resolvesAtMs ?? null,
      heldUntil: null,
    };
    const events: Event[] = [event];
    if (start !== null && kind !== "attention") events.push({ type: "tick", market: spec.id, price: dec(this.clampLot(kind, lotPrice(meta, start))) });
    this.exec(events); // validates the config before anything else is registered
    this.markets[spec.id] = meta;
    this.books[spec.id] = new Book();
    const mark = this.state.markets[spec.id]!.mark;
    if (mark !== null) this.candle(spec.id, mark, 0n);
    this.record(spec.id, "listing", spec.creator ? [spec.creator] : [], `${spec.id} listed${spec.creator ? ` by ${spec.creator}` : ""}: ${meta.name}`, null);
    return meta;
  }

  private clampLot(kind: Kind, lot: bigint): bigint {
    if (kind === "binary") return min(max(lot, 0n), 10n ** 9n);
    return max(lot, 1n);
  }

  /**
   * Oracle update from a feed (coin price, nano-USD). Ignored while an admin hold is active unless forced.
   * Liquidation and ADL run inside the same transition.
   */
  tick(market: string, coinNano: bigint, opts: { force?: boolean } = {}): Effect[] | null {
    const meta = this.market(market);
    const m = this.state.markets[market]!;
    if (meta.source.kind === "curve") throw new ExchangeError(`${market} is priced by its own curve`);
    if (m.status !== "open") return null;
    if (meta.heldUntil !== null) {
      if (this.now() < meta.heldUntil && !opts.force) return null;
      if (this.now() >= meta.heldUntil) meta.heldUntil = null;
    }
    const lot = this.clampLot(meta.kind, lotPrice(meta, coinNano));
    if (lot === m.mark) {
      this.candle(market, lot, 0n);
      return [];
    }
    const effects = this.commit([{ type: "tick", market, price: dec(lot) }]);
    this.candle(market, lot, 0n);
    return effects;
  }

  /** Admin price override: set the oracle now and ignore the feed for `holdSeconds`. */
  adminPrice(market: string, price: string, holdSeconds: number): Effect[] {
    const meta = this.market(market);
    if (meta.source.kind === "curve") throw new ExchangeError(`${market} is priced by its own curve; move it with spot trades`);
    const before = this.state.markets[market]!.mark;
    let coin: bigint;
    try {
      coin = parseFixed(price);
    } catch (err) {
      throw new ExchangeError((err as Error).message);
    }
    meta.heldUntil = holdSeconds > 0 ? this.now() + holdSeconds * 1000 : null;
    const effects = this.tick(market, coin, { force: true }) ?? [];
    const busts = effects.filter((e) => e.kind === "liquidation" || e.kind === "bankrupt").length;
    this.record(
      market,
      "gap",
      [],
      `${market} oracle forced ${before === null ? "—" : fmt(coinPrice(meta, before), 0)} → ${this.markStr(market)}${holdSeconds > 0 ? ` for ${holdSeconds}s` : ""}: ${busts} position${busts === 1 ? "" : "s"} liquidated or bankrupt`,
      null,
    );
    return effects;
  }

  releaseHold(market: string) {
    this.market(market).heldUntil = null;
    this.version++;
  }

  resolve(market: string, price: string): Effect[] {
    const meta = this.market(market);
    let coin: bigint;
    try {
      coin = parseFixed(price);
    } catch (err) {
      throw new ExchangeError((err as Error).message);
    }
    return this.commit([{ type: "resolve", market, price: dec(lotPrice(meta, coin)) }]);
  }

  /** Move the engine clock to wall time: funding accrues, curve TWAPs refresh, tapers tighten, risk runs. */
  clock(): Effect[] {
    const t = this.engineTime();
    if (t <= this.state.time) return [];
    return this.commit([{ type: "advance", seconds: Number(t - this.state.time) }]);
  }

  // ---------- spot (attention curves) ----------

  spotBuy(account: string, market: string, usdc: string): Effect[] {
    this.account(account);
    this.market(market);
    return this.commit([{ type: "spotBuy", account, market, amount: usdc }]);
  }

  spotSell(account: string, market: string, tokens: string): Effect[] {
    this.account(account);
    this.market(market);
    if (tokens !== "all" && !/^\d+$/.test(tokens)) throw new ExchangeError("tokens must be a whole number or \"all\"");
    return this.commit([{ type: "spotSell", account, market, tokens }]);
  }

  // ---------- orders ----------

  placeOrder(account: string, input: OrderInput): OrderResult {
    this.account(account);
    const meta = this.market(input.market);
    const m = this.state.markets[meta.id]!;
    if (m.status !== "open") throw new ExchangeError(`${meta.id} is resolved`);
    if (m.mark === null) throw new ExchangeError(`${meta.id} has no price yet`);
    if (input.side !== "buy" && input.side !== "sell") throw new ExchangeError("side must be buy or sell");
    if (input.type !== "limit" && input.type !== "market") throw new ExchangeError("type must be limit or market");
    let size: bigint;
    try {
      size = lotsFromCoins(meta, input.size);
    } catch (err) {
      throw new ExchangeError(`size: ${(err as Error).message}`);
    }
    if (size <= 0n) throw new ExchangeError("size must be positive");

    const maxLev = leverageNow(m).initial;
    const leverage = input.leverage === undefined ? maxLev : BigInt(Math.floor(Number(input.leverage)));
    if (leverage < 1n || leverage > maxLev) throw new ExchangeError(`leverage must be 1–${maxLev}× in ${meta.id} right now`);

    const { lower, upper } = m.config;
    let price: bigint;
    let tif: Tif;
    if (input.type === "market") {
      const slip = BigInt(Math.round(Math.min(Math.max(input.slippage ?? 0.05, 0.001), 0.5) * 10_000));
      const band = max((m.mark * slip) / 10_000n, (meta.tick / pow10(meta.szDecimals)) * 5n);
      price = input.side === "buy" ? m.mark + band : m.mark - band;
      if (upper !== null && price > upper) price = upper;
      price = max(price, max(lower, upper === null ? 1n : lower));
      tif = "ioc";
    } else {
      if (input.price === undefined) throw new ExchangeError("limit orders need a price");
      let coin: bigint;
      try {
        coin = parseFixed(input.price);
      } catch (err) {
        throw new ExchangeError(`price: ${(err as Error).message}`);
      }
      if (coin <= 0n) throw new ExchangeError("price must be positive");
      if (coin % meta.tick !== 0n) throw new ExchangeError(`price must be a multiple of the tick ${fmt(meta.tick, 0)}`);
      price = lotPrice(meta, coin);
      if (price < lower || (upper !== null && price > upper)) throw new ExchangeError(`price outside the market's bounds`);
      tif = input.tif ?? "gtc";
      if (!["gtc", "ioc", "alo"].includes(tif)) throw new ExchangeError("tif must be gtc, ioc or alo");
    }

    const reduceOnly = !!input.reduceOnly;
    const dir = input.side === "buy" ? 1n : -1n;
    const cur = m.positions[account]?.size ?? 0n;
    if (reduceOnly) {
      if (cur === 0n || sign(cur) === dir) throw new ExchangeError("reduce-only order would not reduce a position");
      size = min(size, abs(cur));
    } else {
      this.checkAffordable(m, account, dir * size, price, leverage);
    }
    const book = this.books[meta.id]!;
    if (tif === "alo" && book.crosses(input.side, price)) throw new ExchangeError("post-only order would take liquidity");
    if (tif !== "ioc" && this.ordersOf(account).length >= MAX_OPEN_ORDERS) throw new ExchangeError(`at most ${MAX_OPEN_ORDERS} open orders`);

    const order: Order = { id: this.nextId++, account, market: meta.id, side: input.side, price, size, filled: 0n, leverage, reduceOnly, tif, time: this.now() };
    const { fills, stop } = this.match(order);
    let status: OrderResult["status"];
    if (order.size === 0n) status = "filled";
    else if (tif !== "ioc" && stop === null) {
      book.add(order);
      this.orders.set(order.id, order);
      status = order.filled > 0n ? "partial" : "resting";
    } else status = order.filled > 0n ? "partial" : "cancelled";
    this.version++;
    return { order, fills, status, reason: stop ?? (status === "cancelled" ? "no liquidity at or inside the limit price" : null) };
  }

  /** Rough pre-trade check so obviously unaffordable orders don't rest. Fills re-check exactly. */
  private checkAffordable(m: Market, account: string, delta: bigint, price: bigint, leverage: bigint) {
    const p = m.positions[account];
    const cur = p?.size ?? 0n;
    const next = cur + delta;
    if (abs(next) <= abs(cur) && sign(next) !== -sign(cur)) return; // reduces
    const px = max(price, m.mark!);
    let need = ceilDiv(abs(delta) * px, leverage);
    if (m.config.upper !== null) need = min(need, abs(delta) * m.config.upper);
    const wallet = this.state.accounts[account]?.wallet ?? 0n;
    const free = p ? max(0n, equity(p, m.mark) - initialMargin(m, p)) : 0n;
    if (need > wallet + free) throw new ExchangeError(`insufficient balance: needs about $${usd(need)} of margin, $${usd(wallet + free)} available`);
  }

  private match(o: Order): { fills: Fill[]; stop: string | null } {
    const book = this.books[o.market]!;
    const fills: Fill[] = [];
    const opp: Side = o.side === "buy" ? "sell" : "buy";
    while (o.size > 0n) {
      const maker = book.best(opp);
      if (!maker || (o.side === "buy" ? maker.price > o.price : maker.price < o.price)) break;
      if (maker.account === o.account) {
        this.removeOrder(maker); // self-trade prevention: the resting order goes
        continue;
      }
      let qty = min(o.size, maker.size);
      if (maker.reduceOnly) {
        qty = min(qty, this.reducible(maker));
        if (qty === 0n) {
          this.removeOrder(maker);
          continue;
        }
      }
      if (o.reduceOnly) {
        const r = this.reducible(o);
        if (r === 0n) return { fills, stop: "position already closed" };
        qty = min(qty, r);
      }
      const res = this.tryFill(o, maker, qty);
      if (res.ok === false) {
        if (res.blame === "maker") {
          this.removeOrder(maker); // the maker can no longer afford its order
          continue;
        }
        return { fills, stop: res.reason };
      }
      fills.push(res.fill);
      o.size -= qty;
      o.filled += qty;
      maker.size -= qty;
      maker.filled += qty;
      if (maker.size === 0n) this.removeOrder(maker);
    }
    return { fills, stop: null };
  }

  private reducible(o: Order): bigint {
    const cur = this.state.markets[o.market]!.positions[o.account]?.size ?? 0n;
    const dir = o.side === "buy" ? 1n : -1n;
    return cur !== 0n && sign(cur) === -dir ? abs(cur) : 0n;
  }

  private tryFill(taker: Order, maker: Order, qty: bigint): { ok: true; fill: Fill } | { ok: false; blame: "maker" | "taker"; reason: string } {
    const m = this.state.markets[taker.market]!;
    const price = maker.price;
    const [buyer, seller] = taker.side === "buy" ? [taker, maker] : [maker, taker];
    const events: Event[] = [];
    for (const [o, d] of [
      [buyer, qty],
      [seller, -qty],
    ] as const) {
      const need = this.marginFor(m, o.account, d, price, o.leverage);
      if (need > 0n) events.push({ type: "allocate", account: o.account, market: m.id, amount: dec(need) });
    }
    events.push({ type: "trade", market: m.id, buyer: buyer.account, seller: seller.account, size: qty.toString(), price: dec(price) });
    try {
      this.commit(events);
    } catch (err) {
      if (!(err instanceof ExchangeError)) throw err;
      return { ok: false, blame: blames(err.message, maker.account) ? "maker" : "taker", reason: err.message };
    }
    const fill: Fill = {
      id: this.nextId++,
      time: this.now(),
      market: m.id,
      kind: "perp",
      price,
      size: qty,
      side: taker.side,
      taker: taker.account,
      maker: maker.account,
      takerOrder: taker.id,
      makerOrder: maker.id,
    };
    this.pushFill(fill);
    this.candle(m.id, this.state.markets[m.id]!.mark!, qty * price);
    return { ok: true, fill };
  }

  /**
   * Auto-margin for one side of a fill: top the position's equity (after the fill, marked at the oracle) up to
   * the larger of the engine's initial margin and the order's chosen leverage. Capped by the wallet; if that's
   * not enough the engine rejects the trade and the matcher blames this side.
   */
  marginFor(m: Market, account: string, delta: bigint, price: bigint, leverage: bigint): bigint {
    const p = m.positions[account];
    const cur = p?.size ?? 0n;
    const next = cur + delta;
    if (abs(next) <= abs(cur) && sign(next) !== -sign(cur)) return 0n; // pure reduction needs nothing new
    const mark = m.mark!;
    const eqAfter = (p ? equity(p, mark) : 0n) + delta * (mark - price);
    const lev = min(leverage, leverageNow(m).initial);
    const engineIm = initialMargin(m, { ...EMPTY_POSITION, size: next });
    let chosen = ceilDiv(abs(next) * mark, lev);
    const cap = next > 0n ? next * (mark - m.config.lower) : m.config.upper === null ? null : abs(next) * (m.config.upper - mark);
    if (cap !== null && chosen > cap) chosen = cap;
    let target = max(engineIm, chosen);
    // At the max-loss cap, initial and maintenance margin coincide, so the first funding payment would liquidate
    // the position. Post 5% more so a fully collateralized position is actually safe.
    if (cap !== null && target >= cap) target += ceilDiv(cap, 20n);
    const need = target - eqAfter;
    const wallet = this.state.accounts[account]?.wallet ?? 0n;
    return need <= 0n ? 0n : min(need, wallet);
  }

  private removeOrder(o: Order) {
    this.books[o.market]?.remove(o);
    this.orders.delete(o.id);
    this.version++;
  }

  cancel(account: string, orderId: number) {
    const o = this.orders.get(orderId);
    if (!o || o.account !== account) throw new ExchangeError(`no open order ${orderId}`, 404);
    this.removeOrder(o);
  }

  cancelAll(account: string, market?: string): number {
    const mine = this.ordersOf(account, market);
    for (const o of mine) this.removeOrder(o);
    return mine.length;
  }
}
