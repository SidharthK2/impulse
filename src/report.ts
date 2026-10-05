// Human-readable replay output.

import { createHash } from "node:crypto";
import { type Effect, type Event, type State, type Step, equity, ids, unrealized, withdrawable } from "./engine.js";
import { abs, fmtPrice, fmtUsd } from "./fixed.js";

const pad = (s: string, n: number) => s.padEnd(n);
const lpad = (s: string, n: number) => s.padStart(n);
const signed = (v: bigint) => (v > 0n ? `+${v}` : `${v}`);
const arrow = (a: string, b: string) => (a === b ? b : `${a} → ${b}`);

export function describeEvent(e: Event, before: State): string {
  switch (e.type) {
    case "deposit":
      return `deposit   ${e.account} $${e.amount}`;
    case "withdraw":
      return `withdraw  ${e.account} ${e.amount === "all" ? "all" : "$" + e.amount}`;
    case "trade":
      return `trade     ${e.buyer} buys ${e.size} from ${e.seller} @ ${e.price}`;
    case "tick":
      return `tick      ${before.mark === null ? "—" : fmtPrice(before.mark)} → ${e.price}`;
    case "resolve":
      return `RESOLVE   outcome = ${e.outcome}`;
  }
}

function entry(size: bigint, basis: bigint): string {
  return size === 0n ? "—" : fmtPrice(abs(basis / size));
}

function accountRows(before: State, after: State, all: boolean): string[] {
  const head =
    `    ${pad("account", 8)} ${lpad("size", 13)} ${lpad("entry", 6)} ${lpad("cash", 24)} ` +
    `${lpad("uPnL", 22)} ${lpad("equity", 22)} ${lpad("ADL ±", 9)} ${lpad("withdrawable", 12)}`;
  const rows: string[] = [];
  for (const id of ids(after)) {
    const a = after.accounts[id]!;
    const b = before.accounts[id];
    const bSize = b?.size ?? 0n;
    const bCash = b?.cash ?? 0n;
    const bU = b ? unrealized(b, before.mark) : 0n;
    const bE = b ? equity(b, before.mark) : 0n;
    const changed = !b || bSize !== a.size || bCash !== a.cash || bE !== equity(a, after.mark);
    if (!all && !changed) continue;
    rows.push(
      `    ${pad(id, 8)} ${lpad(arrow(signed(bSize), signed(a.size)), 13)} ${lpad(entry(a.size, a.basis), 6)} ` +
        `${lpad(arrow(fmtUsd(bCash), fmtUsd(a.cash)), 24)} ${lpad(arrow(fmtUsd(bU), fmtUsd(unrealized(a, after.mark))), 22)} ` +
        `${lpad(arrow(fmtUsd(bE), fmtUsd(equity(a, after.mark))), 22)} ${lpad(a.adlTransfer === 0n ? "" : fmtUsd(a.adlTransfer), 9)} ` +
        `${lpad(fmtUsd(withdrawable(after, a)), 12)}`,
    );
  }
  return rows.length ? [head, ...rows] : [];
}

function effectLines(effects: Effect[]): string[] {
  const out: string[] = [];
  for (const f of effects) {
    switch (f.kind) {
      case "liquidation":
        out.push(`    LIQUIDATED ${f.account}: size ${signed(f.size)}, equity ${fmtUsd(f.equity)} < MM ${fmtUsd(f.maintenance)} → closed at mark, keeps equity`);
        break;
      case "bankrupt":
        out.push(`    BANKRUPT   ${f.account}: size ${signed(f.size)}, equity −${fmtUsd(f.shortfall)} → shortfall $${fmtUsd(f.shortfall)} to be absorbed`);
        break;
      case "forcedClose":
        out.push(`    forced closes at mark: ${f.closes.map((c) => `${c.account} ${signed(c.closed)}`).join(", ")}`);
        break;
      case "haircut":
        out.push(`    ADL haircut ${f.account}: −$${fmtUsd(f.amount)}`);
        break;
      case "settlement":
        out.push(`    settled at ${fmtPrice(f.price)}: ${f.closes.map((c) => `${c.account} ${signed(c.closed)}`).join(", ") || "(no positions)"}`);
        break;
    }
  }
  return out;
}

export function totals(s: State): string {
  let eq = 0n;
  let wd = 0n;
  let oi = 0n;
  for (const id of ids(s)) {
    const a = s.accounts[id]!;
    eq += equity(a, s.mark);
    wd += withdrawable(s, a);
    if (a.size > 0n) oi += a.size;
  }
  return `vault $${fmtUsd(s.vault)} | Σequity $${fmtUsd(eq)} | Σwithdrawable $${fmtUsd(wd)} | open interest ${oi} long = ${oi} short`;
}

export function renderStep(step: Step): string {
  const { index, event, before, result } = step;
  const lines = [`#${String(index).padStart(2, "0")} ${describeEvent(event, before)}`];
  if (!result.ok) {
    lines.push(`    REJECTED: ${result.reason}`);
    return lines.join("\n");
  }
  const big = event.type === "tick" || event.type === "resolve";
  lines.push(...effectLines(result.effects));
  lines.push(...accountRows(before, result.state, big && result.effects.length > 0));
  if (big) lines.push(`    ${totals(result.state)}`);
  return lines.join("\n");
}

export function stateHash(s: State): string {
  const json = JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}
