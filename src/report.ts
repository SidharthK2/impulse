// Human-readable replay output.

import { createHash } from "node:crypto";
import {
  type Effect,
  type Event,
  type Market,
  type State,
  type Step,
  accountIds,
  equity,
  marketIds,
  positionIds,
  releasable,
  unrealized,
} from "./engine.js";
import { abs, fmtPrice, fmtUsd } from "./fixed.js";

const pad = (s: string, n: number) => s.padEnd(n);
const lpad = (s: string, n: number) => s.padStart(n);
const signed = (v: bigint) => (v > 0n ? `+${v}` : `${v}`);
const arrow = (a: string, b: string) => (a === b ? b : `${a} → ${b}`);
const amt = (a: string) => (a === "all" ? "all" : `$${a}`);

export function describeEvent(e: Event, before: State): string {
  switch (e.type) {
    case "market": {
      const kind = e.preset ?? (e.bounds ? "bounded" : "perp");
      return `MARKET    ${e.id} (${kind}${e.bounds ? ` [${e.bounds[0]}, ${e.bounds[1] ?? "∞"}]` : ""}, IM ${e.initialLeverage ?? 3}x, MM ${e.maintenanceLeverage ?? 6}x)`;
    }
    case "deposit":
      return `deposit   ${e.account} ${amt(e.amount)}`;
    case "withdraw":
      return `withdraw  ${e.account} ${amt(e.amount)}`;
    case "allocate":
      return `allocate  ${e.account} ${amt(e.amount)} → ${e.market}`;
    case "release":
      return `release   ${e.account} ${amt(e.amount)} ← ${e.market}`;
    case "trade":
      return `trade     ${e.market}: ${e.buyer} buys ${e.size} from ${e.seller} @ ${e.price}`;
    case "tick": {
      const m = before.markets[e.market];
      return `tick      ${e.market}: ${m?.mark == null ? "—" : fmtPrice(m.mark)} → ${e.price}`;
    }
    case "resolve":
      return `RESOLVE   ${e.market} @ ${e.price}`;
    case "spotBuy":
      return `spot buy  ${e.market}: ${e.account} spends ${amt(e.amount)}`;
    case "spotSell":
      return `spot sell ${e.market}: ${e.account} sells ${e.tokens === "all" ? "all" : e.tokens} tokens`;
    case "advance":
      return `advance   +${e.seconds}s → t=${before.time + BigInt(e.seconds)}s`;
  }
}

function entry(size: bigint, basis: bigint): string {
  return size === 0n ? "—" : fmtPrice(abs(basis / size));
}

function positionRows(before: Market | undefined, after: Market, all: boolean): string[] {
  const head =
    `    ${pad(`[${after.id}]`, 10)} ${lpad("size", 15)} ${lpad("entry", 10)} ${lpad("collateral", 24)} ` +
    `${lpad("uPnL", 22)} ${lpad("equity", 24)} ${lpad("ADL ±", 10)} ${lpad("releasable", 11)}`;
  const rows: string[] = [];
  for (const id of positionIds(after)) {
    const p = after.positions[id]!;
    const b = before?.positions[id];
    const bSize = b?.size ?? 0n;
    const bCol = b?.collateral ?? 0n;
    const bU = b ? unrealized(b, before!.mark) : 0n;
    const bE = b ? equity(b, before!.mark) : 0n;
    const changed = !b || bSize !== p.size || bCol !== p.collateral || bE !== equity(p, after.mark);
    if (!all && !changed) continue;
    rows.push(
      `    ${pad(id, 10)} ${lpad(arrow(signed(bSize), signed(p.size)), 15)} ${lpad(entry(p.size, p.basis), 10)} ` +
        `${lpad(arrow(fmtUsd(bCol), fmtUsd(p.collateral)), 24)} ${lpad(arrow(fmtUsd(bU), fmtUsd(unrealized(p, after.mark))), 22)} ` +
        `${lpad(arrow(fmtUsd(bE), fmtUsd(equity(p, after.mark))), 24)} ${lpad(p.adlTransfer === 0n ? "" : fmtUsd(p.adlTransfer), 10)} ` +
        `${lpad(fmtUsd(releasable(after, p)), 11)}`,
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
        out.push(`    ADL haircut ${f.account}: −$${fmtUsd(f.amount)}${f.fromPrincipal > 0n ? ` (of which $${fmtUsd(f.fromPrincipal)} from principal)` : ""}`);
        break;
      case "settlement":
        out.push(`    settled at ${fmtPrice(f.price)}: ${f.closes.map((c) => `${c.account} ${signed(c.closed)}`).join(", ") || "(no positions)"}`);
        break;
      case "spot":
        out.push(
          `    ${f.tokens > 0n ? "bought" : "sold"} ${abs(f.tokens)} tokens for $${fmtUsd(abs(f.usdc))} (fee $${fmtUsd(f.fee)}); ` +
            `spot ${fmtPrice(f.priceBefore)} → ${fmtPrice(f.priceAfter)}`,
        );
        break;
      case "funding": {
        const pct = (Number(f.rate < 0n ? -f.rate : f.rate) / 1e7).toFixed(4);
        out.push(`    [${f.market}] funding ${pct}%/h for ${f.seconds}s: ${f.payers}s pay $${fmtUsd(f.total)}`);
        break;
      }
      case "graduation":
        out.push(`    [${f.market}] GRADUATED to tier ${f.tier}: max leverage ${f.leverage}x`);
        break;
      case "mark":
        out.push(`    [${f.market}] mark ${fmtPrice(f.from)} → ${fmtPrice(f.to)} (spot ${fmtPrice(f.spot)})`);
        break;
    }
  }
  return out;
}

export function marketTotals(m: Market): string {
  let eq = 0n;
  let rel = 0n;
  let oi = 0n;
  for (const id of positionIds(m)) {
    const p = m.positions[id]!;
    eq += equity(p, m.mark);
    rel += releasable(m, p);
    if (p.size > 0n) oi += p.size;
  }
  return `[${m.id}] vault $${fmtUsd(m.vault)} | Σequity $${fmtUsd(eq)} | Σreleasable $${fmtUsd(rel)} | OI ${oi} long = ${oi} short`;
}

export function totals(s: State): string {
  const wallets = accountIds(s).reduce((sum, id) => sum + s.accounts[id]!.wallet, 0n);
  const vaults = marketIds(s).reduce((sum, id) => sum + s.markets[id]!.vault, 0n);
  const curves = marketIds(s).reduce((sum, id) => {
    const c = s.markets[id]!.curve;
    return c ? sum + c.x - c.x0 : sum;
  }, 0n);
  const held = wallets + vaults + curves + s.fees;
  return (
    `wallets $${fmtUsd(wallets)} + market vaults $${fmtUsd(vaults)}` +
    (curves || s.fees ? ` + curves $${fmtUsd(curves)} + fees $${fmtUsd(s.fees)}` : "") +
    ` = $${fmtUsd(held)} held | deposits − withdrawals $${fmtUsd(s.totalDeposits - s.totalWithdrawals)}`
  );
}

export function renderStep(step: Step): string {
  const { index, event, before, result } = step;
  const lines = [`#${String(index).padStart(2, "0")} ${describeEvent(event, before)}`];
  if (!result.ok) {
    lines.push(`    REJECTED: ${result.reason}`);
    return lines.join("\n");
  }
  const after = result.state;
  if ("account" in event) {
    const b = before.accounts[event.account]?.wallet ?? 0n;
    lines.push(`    ${event.account} wallet ${arrow(fmtUsd(b), fmtUsd(after.accounts[event.account]!.wallet))}`);
  }
  lines.push(...effectLines(result.effects));
  const touched = "market" in event ? [event.market] : [...new Set(result.effects.map((f) => f.market))];
  const distress = (id: string) => result.effects.some((f) => f.market === id && (f.kind === "liquidation" || f.kind === "bankrupt"));
  for (const id of touched) {
    const big = event.type === "tick" || event.type === "resolve" || event.type === "advance" || distress(id);
    const quiet = event.type === "spotBuy" || event.type === "spotSell";
    if (quiet && !distress(id)) continue;
    lines.push(...positionRows(before.markets[id], after.markets[id]!, big && result.effects.length > 0));
    if (big) lines.push(`    ${marketTotals(after.markets[id]!)}`);
  }
  return lines.join("\n");
}

export function stateHash(s: State): string {
  const json = JSON.stringify(s, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}
