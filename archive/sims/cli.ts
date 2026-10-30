// Usage: tsx archive/sims/cli.ts <scenario.json> [more.json ...] [--json]
// Replays each scenario deterministically and prints the ledger after every event.

import { readFileSync } from "node:fs";
import { type Event, marketIds, replay } from "../reference/engine/engine.js";
import { marketTotals, renderStep, stateHash, totals } from "../reference/engine/report.js";

interface Scenario {
  name: string;
  description?: string;
  events: Event[];
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: tsx archive/sims/cli.ts <scenario.json> [...] [--json]");
  process.exit(1);
}

const bigintSafe = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

for (const file of files) {
  const sc = JSON.parse(readFileSync(file, "utf8")) as Scenario;
  const { steps, final } = replay(sc.events);

  if (asJson) {
    const out = {
      scenario: sc.name,
      hash: stateHash(final),
      steps: steps.map((s) => ({ event: s.event, ok: s.result.ok, ...(s.result.ok ? { effects: s.result.effects } : { reason: s.result.reason }) })),
      final,
    };
    console.log(JSON.stringify(out, bigintSafe, 2));
    continue;
  }

  console.log("=".repeat(110));
  console.log(sc.name);
  if (sc.description) console.log(sc.description);
  console.log("=".repeat(110));
  for (const step of steps) console.log(renderStep(step));
  console.log("-".repeat(110));
  for (const id of marketIds(final)) console.log(`final ${marketTotals(final.markets[id]!)}`);
  console.log(`final ${totals(final)}`);
  console.log(`state hash: ${stateHash(final)}  (deterministic: same events → same hash)\n`);
}
