// Usage: tsx src/cli.ts <scenario.json> [more.json ...] [--json]
// Replays each scenario deterministically and prints the ledger after every event.

import { readFileSync } from "node:fs";
import { DEFAULT_PARAMS, type Event, type Params, replay } from "./engine.js";
import { renderStep, stateHash, totals } from "./report.js";

interface Scenario {
  name: string;
  description?: string;
  params?: { initialLeverage?: number; maintenanceLeverage?: number };
  events: Event[];
}

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));
if (files.length === 0) {
  console.error("usage: tsx src/cli.ts <scenario.json> [...] [--json]");
  process.exit(1);
}

for (const file of files) {
  const sc = JSON.parse(readFileSync(file, "utf8")) as Scenario;
  const params: Params = {
    initialLeverage: BigInt(sc.params?.initialLeverage ?? DEFAULT_PARAMS.initialLeverage),
    maintenanceLeverage: BigInt(sc.params?.maintenanceLeverage ?? DEFAULT_PARAMS.maintenanceLeverage),
  };
  const { steps, final } = replay(sc.events, params);

  if (asJson) {
    const out = { scenario: sc.name, hash: stateHash(final), steps: steps.map((s) => ({ event: s.event, ok: s.result.ok, ...(s.result.ok ? { effects: s.result.effects } : { reason: s.result.reason }) })), final };
    console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    continue;
  }

  console.log("=".repeat(100));
  console.log(`${sc.name}  (IM ${params.initialLeverage}x, MM ${params.maintenanceLeverage}x)`);
  if (sc.description) console.log(sc.description);
  console.log("=".repeat(100));
  for (const step of steps) console.log(renderStep(step));
  console.log("-".repeat(100));
  console.log(`final: ${totals(final)}`);
  console.log(`state hash: ${stateHash(final)}  (deterministic: same events → same hash)\n`);
}
