// Replay scenarios under each ADL policy and compare who ends up with what.
// Usage: tsx archive/sims/compare.ts [scenario.json ...]   (defaults to every scenario in tests/scenarios/)

import { readdirSync, readFileSync } from "node:fs";
import { type AdlPolicy, type Event, type State, accountIds, equity, marketIds, replay, spotPrice } from "../reference/engine/engine.js";
import { fmtUsd } from "../reference/engine/fixed.js";

const POLICIES: AdlPolicy[] = ["size", "pnl"];

interface Outcome {
  net: bigint; // final wealth − deposits (wallet + withdrawn + market equity + spot at curve price)
  haircut: bigint; // total ADL haircut paid
  principal: bigint; // part of that haircut that came out of principal
}

function outcomes(events: Event[], adl: AdlPolicy): Map<string, Outcome> {
  const withPolicy = events.map((e) => (e.type === "market" ? { ...e, adl } : e));
  const { steps, final } = replay(withPolicy);
  const out = new Map<string, Outcome>();
  for (const id of accountIds(final)) out.set(id, { net: wealth(final, id) - final.accounts[id]!.deposited, haircut: 0n, principal: 0n });
  for (const step of steps) {
    if (!step.result.ok) continue;
    for (const f of step.result.effects) {
      if (f.kind !== "haircut") continue;
      const o = out.get(f.account)!;
      o.haircut += f.amount;
      o.principal += f.fromPrincipal;
    }
  }
  return out;
}

function wealth(s: State, id: string): bigint {
  const a = s.accounts[id]!;
  let w = a.wallet + a.withdrawn;
  for (const mid of marketIds(s)) {
    const m = s.markets[mid]!;
    const p = m.positions[id];
    if (p) w += equity(p, m.mark);
    if (m.curve && a.spot[mid]) w += a.spot[mid]! * spotPrice(m.curve);
  }
  return w;
}

const money = (v: bigint) => (v === 0n ? "—" : `${v < 0n ? "-" : ""}$${fmtUsd(v < 0n ? -v : v)}`);

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync("tests/scenarios")
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => `tests/scenarios/${f}`);

for (const file of files) {
  const sc = JSON.parse(readFileSync(file, "utf8")) as { name: string; events: Event[] };
  const results = POLICIES.map((p) => outcomes(sc.events, p));
  const touched = [...results[0]!.keys()].filter((id) => results.some((r) => r.get(id)!.haircut > 0n));
  console.log(`\n${sc.name}`);
  if (touched.length === 0) {
    console.log("  no ADL haircuts: both policies identical");
    continue;
  }
  console.log(`  ${"account".padEnd(9)} ${"net PnL (size)".padStart(16)} ${"principal hit".padStart(14)}   ${"net PnL (pnl)".padStart(16)} ${"principal hit".padStart(14)}   ${"Δ pnl − size".padStart(14)}`);
  for (const id of [...results[0]!.keys()]) {
    const [a, b] = [results[0]!.get(id)!, results[1]!.get(id)!];
    if (a.net === b.net && a.haircut === 0n && b.haircut === 0n) continue;
    console.log(
      `  ${id.padEnd(9)} ${money(a.net).padStart(16)} ${money(a.principal).padStart(14)}   ${money(b.net).padStart(16)} ${money(b.principal).padStart(14)}   ${money(b.net - a.net).padStart(14)}`,
    );
  }
}
