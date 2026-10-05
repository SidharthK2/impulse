// Impulse reference engine: Mirror-style MicroPerps for any asset, no exchange backstop.
// Markets are isolated shards: each owns its positions, collateral vault and config, and risk processing
// (liquidation + ADL) only ever reads and writes the market it runs in. Accounts hold a wallet and move
// collateral into per-market buckets explicitly.
// Every event is an atomic state transition: apply to a clone, assert invariants, commit or reject.
// See docs/ACCOUNTING.md for the model this implements.

import { allocate } from "./alloc.js";
import { abs, ceilDiv, fmtPrice, fmtUsd, max, min, parseFixed, sign } from "./fixed.js";

// ---------- types ----------

export interface MarketConfig {
  lower: bigint; // lowest valid price (0 unless bounded)
  upper: bigint | null; // highest valid price, null = unbounded (e.g. tokens, equities)
  resolvable: boolean; // can be settled to a final price (prediction market, pre-IPO flatten)
  initialLeverage: bigint; // IM = notional / initialLeverage
  maintenanceLeverage: bigint; // MM = notional / maintenanceLeverage
}

export interface Position {
  account: string;
  collateral: bigint; // cash in this market's bucket
  size: bigint; // units, + long / − short
  basis: bigint; // Σ signed fill size × fill price
  // Ledger columns: collateral = allocated + realized + adlTransfer (invariant).
  allocated: bigint; // Σ allocate − Σ release
  realized: bigint;
  adlTransfer: bigint; // − haircut paid as absorber, + shortfall covered as bankrupt
}

export interface Market {
  id: string;
  config: MarketConfig;
  mark: bigint | null;
  status: "open" | "resolved";
  vault: bigint; // collateral held for this market = Σ allocated
  positions: Record<string, Position>;
}

export interface Account {
  id: string;
  wallet: bigint;
  deposited: bigint;
  withdrawn: bigint;
}

export interface State {
  seq: number;
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
      preset?: "binary" | "perp"; // binary = price in [0,1], resolvable; perp = unbounded, not resolvable
      bounds?: [string, string | null];
      resolvable?: boolean;
      initialLeverage?: number;
      maintenanceLeverage?: number;
    }
  | { type: "deposit"; account: string; amount: Amount }
  | { type: "withdraw"; account: string; amount: Amount } // "all" allowed
  | { type: "allocate"; account: string; market: string; amount: Amount } // wallet → market; "all" allowed
  | { type: "release"; account: string; market: string; amount: Amount } // market → wallet; "all" allowed
  | { type: "trade"; market: string; buyer: string; seller: string; size: number | string; price: string }
  | { type: "tick"; market: string; price: string }
  | { type: "resolve"; market: string; price: string };

export interface ForcedClose {
  account: string;
  closed: bigint; // signed change in size
  price: bigint;
}

export type Effect =
  | { kind: "liquidation"; market: string; account: string; size: bigint; equity: bigint; maintenance: bigint }
  | { kind: "bankrupt"; market: string; account: string; size: bigint; shortfall: bigint }
  | { kind: "forcedClose"; market: string; closes: ForcedClose[] }
  | { kind: "haircut"; market: string; account: string; amount: bigint }
  | { kind: "settlement"; market: string; price: bigint; closes: ForcedClose[] };

export type Result =
  | { ok: true; state: State; effects: Effect[] }
  | { ok: false; state: State; reason: string };

export class Rejected extends Error {}

export const DEFAULT_LEVERAGE = { initial: 3n, maintenance: 6n };

export function initialState(): State {
  return { seq: 0, totalDeposits: 0n, totalWithdrawals: 0n, accounts: {}, markets: {} };
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

function requirement(m: Market, p: Position, leverage: bigint): bigint {
  if (p.size === 0n) return 0n;
  const byNotional = ceilDiv(abs(p.size) * m.mark!, leverage);
  const cap = maxLoss(m, p);
  return cap === null ? byNotional : min(cap, byNotional);
}

export const initialMargin = (m: Market, p: Position) => requirement(m, p, m.config.initialLeverage);
export const maintenanceMargin = (m: Market, p: Position) => requirement(m, p, m.config.maintenanceLeverage);

/** Realized collateral that can leave the market while still covering initial margin. */
export function releasable(m: Market, p: Position): bigint {
  return max(0n, min(p.collateral, equity(p, m.mark) - initialMargin(m, p)));
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
  const [lo, hi] = e.bounds ?? (binary ? ["0", "1"] : ["0", null]);
  const config: MarketConfig = {
    lower: parseFixed(lo),
    upper: hi === null ? null : parseFixed(hi),
    resolvable: e.resolvable ?? binary,
    initialLeverage: BigInt(e.initialLeverage ?? DEFAULT_LEVERAGE.initial),
    maintenanceLeverage: BigInt(e.maintenanceLeverage ?? DEFAULT_LEVERAGE.maintenance),
  };
  if (config.lower < 0n || (config.upper !== null && config.upper <= config.lower)) throw new Rejected("bad bounds");
  if (config.initialLeverage < 1n || config.maintenanceLeverage < config.initialLeverage) {
    throw new Rejected("need 1 ≤ initialLeverage ≤ maintenanceLeverage");
  }
  s.markets[e.id] = { id: e.id, config, mark: null, status: "open", vault: 0n, positions: {} };
}

function onDeposit(s: State, e: Extract<Event, { type: "deposit" }>) {
  const amt = parseFixed(e.amount);
  if (amt <= 0n) throw new Rejected("deposit must be positive");
  const a = (s.accounts[e.account] ??= { id: e.account, wallet: 0n, deposited: 0n, withdrawn: 0n });
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

function onTrade(s: State, e: Extract<Event, { type: "trade" }>) {
  const m = getMarket(s, e.market);
  if (m.status !== "open") throw new Rejected(`${m.id} is resolved`);
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
}

/** Liquidation + ADL loop for one market. Reads and writes nothing outside `m`. */
function resolveDistress(m: Market): Effect[] {
  const effects: Effect[] = [];
  const mark = m.mark!;
  for (;;) {
    const distressed = positionsOf(m).filter((p) => p.size !== 0n && equity(p, mark) < maintenanceMargin(m, p));
    if (distressed.length === 0) return effects;

    const side = sign(distressed[0]!.size);
    if (distressed.some((p) => sign(p.size) !== side)) {
      throw new Error(`invariant: distressed positions on both sides in ${m.id}`);
    }
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
    const haircuts = allocate(dTotal, weights);

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
      p.collateral -= h;
      p.adlTransfer -= h;
      effects.push({ kind: "haircut", market: m.id, account: p.account, amount: h });
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

function onTick(s: State, e: { market: string; price: string }): Effect[] {
  const m = getMarket(s, e.market);
  if (m.status !== "open") throw new Rejected(`${m.id} is resolved`);
  m.mark = parsePrice(m, e.price);
  return resolveDistress(m);
}

function onResolve(s: State, e: Extract<Event, { type: "resolve" }>): Effect[] {
  const m = getMarket(s, e.market);
  if (!m.config.resolvable) throw new Rejected(`${m.id} is not resolvable`);
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
    if (p.collateral !== p.allocated + p.realized + p.adlTransfer) errs.push(`${id}: ledger mismatch`);
    if (m.status === "resolved" && (p.size !== 0n || p.basis !== 0n)) errs.push(`${id}: open position after resolution`);
  }
  if (netSize !== 0n) errs.push(`${m.id}: unbalanced exposure Σsize = ${netSize}`);
  if (allocated !== m.vault) errs.push(`${m.id}: vault ${m.vault} != Σallocated ${allocated}`);
  if (collateralMinusBasis !== m.vault) errs.push(`${m.id}: Σ(collateral − basis) ${collateralMinusBasis} != vault ${m.vault}`);
  if (sumEquity !== m.vault) errs.push(`${m.id}: Σequity ${sumEquity} != vault ${m.vault}`);
  if (sumReleasable > m.vault) errs.push(`${m.id}: Σreleasable > vault`);
  return errs;
}

export function checkInvariants(s: State): string[] {
  const errs = marketIds(s).flatMap((id) => checkMarket(s.markets[id]!));
  let wallets = 0n;
  for (const id of accountIds(s)) {
    const a = s.accounts[id]!;
    wallets += a.wallet;
    if (a.wallet < 0n) errs.push(`${id}: negative wallet`);
  }
  const vaults = marketIds(s).reduce((sum, id) => sum + s.markets[id]!.vault, 0n);
  if (wallets + vaults !== s.totalDeposits - s.totalWithdrawals) {
    errs.push(`Σwallets + Σvaults ${wallets + vaults} != deposits − withdrawals ${s.totalDeposits - s.totalWithdrawals}`);
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
        onTrade(s, event);
        break;
      case "tick":
        effects = onTick(s, event);
        break;
      case "resolve":
        effects = onResolve(s, event);
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
