// Impulse reference engine: one isolated prediction-market outcome, linear perp on a price in [0, 1].
// Every event is an atomic state transition: apply to a clone, assert invariants, commit or reject.
// See docs/ACCOUNTING.md for the model this implements.

import { allocate } from "./alloc.js";
import { ONE, abs, ceilDiv, fmtUsd, max, min, parseMicro, sign } from "./fixed.js";

export interface Params {
  initialLeverage: bigint; // IM = notional / initialLeverage
  maintenanceLeverage: bigint; // MM = notional / maintenanceLeverage
}

export const DEFAULT_PARAMS: Params = { initialLeverage: 3n, maintenanceLeverage: 6n };

export interface Account {
  id: string;
  cash: bigint;
  size: bigint; // contracts, + long / − short
  basis: bigint; // Σ signed fill size × fill price (micro-USD)
  // Ledger columns, for inspection and invariant 6 (cash = deposited − withdrawn + realized + adlTransfer).
  deposited: bigint;
  withdrawn: bigint;
  realized: bigint;
  adlTransfer: bigint; // − haircut paid as absorber, + shortfall covered as bankrupt
}

export interface State {
  seq: number;
  params: Params;
  mark: bigint | null;
  status: "open" | "resolved";
  vault: bigint;
  totalDeposits: bigint;
  totalWithdrawals: bigint;
  accounts: Record<string, Account>;
}

export type Event =
  | { type: "deposit"; account: string; amount: string }
  | { type: "withdraw"; account: string; amount: string } // "all" = full withdrawable balance
  | { type: "trade"; buyer: string; seller: string; size: number | string; price: string }
  | { type: "tick"; price: string }
  | { type: "resolve"; outcome: 0 | 1 };

export interface ForcedClose {
  account: string;
  closed: bigint; // signed change in size
  price: bigint;
}

export type Effect =
  | { kind: "liquidation"; account: string; size: bigint; equity: bigint; maintenance: bigint }
  | { kind: "bankrupt"; account: string; size: bigint; shortfall: bigint }
  | { kind: "forcedClose"; closes: ForcedClose[] }
  | { kind: "haircut"; account: string; amount: bigint }
  | { kind: "settlement"; price: bigint; closes: ForcedClose[] };

export type Result =
  | { ok: true; state: State; effects: Effect[] }
  | { ok: false; state: State; reason: string };

export class Rejected extends Error {}

export function initialState(params: Params = DEFAULT_PARAMS): State {
  return {
    seq: 0,
    params,
    mark: null,
    status: "open",
    vault: 0n,
    totalDeposits: 0n,
    totalWithdrawals: 0n,
    accounts: {},
  };
}

// ---------- derived quantities ----------

export const ids = (s: State) => Object.keys(s.accounts).sort();

export function equity(a: Account, mark: bigint | null): bigint {
  if (a.size === 0n) return a.cash - a.basis;
  if (mark === null) throw new Error(`account ${a.id} has a position but no mark`);
  return a.cash + a.size * mark - a.basis;
}

export const unrealized = (a: Account, mark: bigint | null) => (a.size === 0n ? 0n : a.size * mark! - a.basis);

function maxLoss(a: Account, mark: bigint): bigint {
  return a.size > 0n ? a.size * mark : abs(a.size) * (ONE - mark);
}

function requirement(a: Account, mark: bigint | null, leverage: bigint): bigint {
  if (a.size === 0n) return 0n;
  return min(maxLoss(a, mark!), ceilDiv(abs(a.size) * mark!, leverage));
}

export const initialMargin = (s: State, a: Account) => requirement(a, s.mark, s.params.initialLeverage);
export const maintenanceMargin = (s: State, a: Account) => requirement(a, s.mark, s.params.maintenanceLeverage);

export function withdrawable(s: State, a: Account): bigint {
  return max(0n, min(a.cash, equity(a, s.mark) - initialMargin(s, a)));
}

// ---------- fills ----------

/** Apply a signed fill of `d` contracts at price `x`. Returns realized PnL. */
function fill(a: Account, d: bigint, x: bigint): bigint {
  let realized = 0n;
  if (a.size !== 0n && sign(d) !== sign(a.size)) {
    const r = min(abs(d), abs(a.size));
    const basisRemoved = (a.basis * r) / abs(a.size); // truncation stays inside this account
    realized = -sign(d) * r * x - basisRemoved;
    a.basis -= basisRemoved;
    a.cash += realized;
    a.size += sign(d) * r;
    d -= sign(d) * r;
  }
  if (d !== 0n) {
    a.size += d;
    a.basis += d * x;
  }
  a.realized += realized;
  return realized;
}

// ---------- event handlers ----------

function getAccount(s: State, id: string): Account {
  const a = s.accounts[id];
  if (!a) throw new Rejected(`unknown account "${id}"`);
  return a;
}

function parsePrice(p: string): bigint {
  const v = parseMicro(p);
  if (v < 0n || v > ONE) throw new Rejected(`price ${p} outside [0, 1]`);
  return v;
}

function parsePositive(amount: string, what: string): bigint {
  const v = parseMicro(amount);
  if (v <= 0n) throw new Rejected(`${what} must be positive`);
  return v;
}

function onDeposit(s: State, e: Extract<Event, { type: "deposit" }>) {
  const amt = parsePositive(e.amount, "deposit");
  const a = (s.accounts[e.account] ??= {
    id: e.account,
    cash: 0n,
    size: 0n,
    basis: 0n,
    deposited: 0n,
    withdrawn: 0n,
    realized: 0n,
    adlTransfer: 0n,
  });
  a.cash += amt;
  a.deposited += amt;
  s.vault += amt;
  s.totalDeposits += amt;
}

function onWithdraw(s: State, e: Extract<Event, { type: "withdraw" }>) {
  const a = getAccount(s, e.account);
  const w = withdrawable(s, a);
  const amt = e.amount === "all" ? w : parsePositive(e.amount, "withdrawal");
  if (amt <= 0n) throw new Rejected("nothing withdrawable");
  if (amt > w) throw new Rejected(`withdraw $${fmtUsd(amt)} exceeds withdrawable $${fmtUsd(w)}`);
  a.cash -= amt;
  a.withdrawn += amt;
  s.vault -= amt;
  s.totalWithdrawals += amt;
}

function onTrade(s: State, e: Extract<Event, { type: "trade" }>) {
  if (s.status !== "open") throw new Rejected("market resolved");
  if (s.mark === null) throw new Rejected("no oracle price yet");
  if (e.buyer === e.seller) throw new Rejected("self-trade");
  const size = BigInt(e.size);
  if (size <= 0n) throw new Rejected("size must be positive");
  const price = parsePrice(e.price);
  const parties: [Account, bigint][] = [
    [getAccount(s, e.buyer), size],
    [getAccount(s, e.seller), -size],
  ];
  for (const [a, d] of parties) {
    const before = a.size;
    fill(a, d, price);
    const reduceOnly = abs(a.size) < abs(before) && sign(a.size) !== -sign(before);
    const eq = equity(a, s.mark);
    const need = reduceOnly ? maintenanceMargin(s, a) : initialMargin(s, a);
    if (eq < need) {
      throw new Rejected(`${a.id}: equity $${fmtUsd(eq)} below ${reduceOnly ? "maintenance" : "initial"} margin $${fmtUsd(need)}`);
    }
  }
}

/** Liquidation + ADL loop, run inside a tick. Returns effects. */
function resolveDistress(s: State): Effect[] {
  const effects: Effect[] = [];
  const mark = s.mark!;
  for (;;) {
    const distressed = ids(s)
      .map((id) => s.accounts[id]!)
      .filter((a) => a.size !== 0n && equity(a, mark) < maintenanceMargin(s, a));
    if (distressed.length === 0) return effects;

    const side = sign(distressed[0]!.size);
    if (distressed.some((a) => sign(a.size) !== side)) {
      throw new Error("invariant: distressed accounts on both sides in one round");
    }
    const opposing = ids(s)
      .map((id) => s.accounts[id]!)
      .filter((a) => sign(a.size) === -side);

    let qTotal = 0n;
    let dTotal = 0n;
    for (const a of distressed) {
      const eq = equity(a, mark);
      qTotal += abs(a.size);
      if (eq < 0n) {
        dTotal += -eq;
        effects.push({ kind: "bankrupt", account: a.id, size: a.size, shortfall: -eq });
      } else {
        effects.push({ kind: "liquidation", account: a.id, size: a.size, equity: eq, maintenance: maintenanceMargin(s, a) });
      }
    }

    const weights = opposing.map((a) => ({ key: a.id, weight: abs(a.size) }));
    const closes = allocate(qTotal, weights);
    const haircuts = allocate(dTotal, weights);

    // Close distressed accounts fully at mark; take the other side pro-rata at mark.
    const forced: ForcedClose[] = [];
    for (const a of distressed) {
      forced.push({ account: a.id, closed: -a.size, price: mark });
      fill(a, -a.size, mark);
    }
    for (const a of opposing) {
      const r = closes.get(a.id)!;
      if (r > abs(a.size)) throw new Error(`invariant: ADL closes ${r} > position ${a.size} for ${a.id}`);
      if (r === 0n) continue;
      forced.push({ account: a.id, closed: side * r, price: mark });
      fill(a, side * r, mark);
    }
    effects.push({ kind: "forcedClose", closes: forced });

    // Move the shortfall from absorbers to bankrupt accounts.
    for (const a of opposing) {
      const h = haircuts.get(a.id)!;
      if (h === 0n) continue;
      if (h > equity(a, mark)) throw new Error(`invariant: haircut ${h} exceeds equity of ${a.id}`);
      a.cash -= h;
      a.adlTransfer -= h;
      effects.push({ kind: "haircut", account: a.id, amount: h });
    }
    for (const a of distressed) {
      const eq = equity(a, mark);
      if (eq < 0n) {
        a.cash += -eq;
        a.adlTransfer += -eq;
      }
    }
  }
}

function onTick(s: State, price: bigint): Effect[] {
  if (s.status !== "open") throw new Rejected("market resolved");
  s.mark = price;
  return resolveDistress(s);
}

function onResolve(s: State, outcome: 0 | 1): Effect[] {
  if (outcome !== 0 && outcome !== 1) throw new Rejected("outcome must be 0 or 1");
  const price = outcome === 1 ? ONE : 0n;
  const effects = onTick(s, price);
  const closes: ForcedClose[] = [];
  for (const id of ids(s)) {
    const a = s.accounts[id]!;
    if (a.size === 0n) continue;
    closes.push({ account: id, closed: -a.size, price });
    fill(a, -a.size, price);
  }
  effects.push({ kind: "settlement", price, closes });
  s.status = "resolved";
  return effects;
}

// ---------- invariants ----------

export function checkInvariants(s: State): string[] {
  const errs: string[] = [];
  let netSize = 0n;
  let cashMinusBasis = 0n;
  let sumEquity = 0n;
  let sumWithdrawable = 0n;
  for (const id of ids(s)) {
    const a = s.accounts[id]!;
    netSize += a.size;
    cashMinusBasis += a.cash - a.basis;
    if (a.size !== 0n && s.mark === null) {
      errs.push(`${id}: position without mark`);
      continue;
    }
    const eq = equity(a, s.mark);
    sumEquity += eq;
    if (eq < 0n) errs.push(`${id}: negative equity ${eq}`);
    if (a.size !== 0n && eq < maintenanceMargin(s, a)) errs.push(`${id}: below maintenance margin`);
    const w = withdrawable(s, a);
    if (w > eq) errs.push(`${id}: withdrawable ${w} > equity ${eq}`);
    sumWithdrawable += w;
    if (a.cash !== a.deposited - a.withdrawn + a.realized + a.adlTransfer) errs.push(`${id}: ledger mismatch`);
    if (s.status === "resolved" && (a.size !== 0n || a.basis !== 0n)) errs.push(`${id}: open position after resolution`);
  }
  if (netSize !== 0n) errs.push(`unbalanced exposure: Σsize = ${netSize}`);
  if (s.vault !== s.totalDeposits - s.totalWithdrawals) errs.push("vault != deposits − withdrawals");
  if (cashMinusBasis !== s.vault) errs.push(`Σ(cash − basis) ${cashMinusBasis} != vault ${s.vault}`);
  if (sumEquity !== s.vault) errs.push(`Σequity ${sumEquity} != vault ${s.vault}`);
  if (sumWithdrawable > s.vault) errs.push("Σwithdrawable > vault");
  return errs;
}

// ---------- apply / replay ----------

export function apply(state: State, event: Event): Result {
  const s = structuredClone(state);
  let effects: Effect[] = [];
  try {
    switch (event.type) {
      case "deposit":
        onDeposit(s, event);
        break;
      case "withdraw":
        onWithdraw(s, event);
        break;
      case "trade":
        onTrade(s, event);
        break;
      case "tick":
        effects = onTick(s, parsePrice(event.price));
        break;
      case "resolve":
        effects = onResolve(s, event.outcome);
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

export function replay(events: Event[], params: Params = DEFAULT_PARAMS): { steps: Step[]; final: State } {
  let state = initialState(params);
  const steps: Step[] = [];
  events.forEach((event, index) => {
    const result = apply(state, event);
    steps.push({ index, event, before: state, result });
    state = result.state;
  });
  return { steps, final: state };
}
