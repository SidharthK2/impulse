// Freezes the TypeScript reference engine's results into tests/golden/, so the Rust engine can be checked against
// them with no TypeScript at runtime (rs/engine/tests/golden.rs).
//
//   tests/golden/scenarios/<name>.json   per-step outcomes and final state for tests/scenarios/<name>.json
//   tests/golden/histories.jsonl          300 random histories (archive/tests/engine/histories.ts, seeds 1–300)
//   tests/golden/fuzz.jsonl               300 fuzz histories (the generator of the old engine.test.ts "fuzz" test)
//
// Each outcome is {ok: true, effects} or {ok: false, reason}; bigints are decimal strings, the Rust encoding.
// Run from the repo root: npx tsx archive/golden/generate.ts (see archive/README.md).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { type Event, type State, apply, initialState } from "../reference/engine/engine.js";
import { randomHistory } from "../tests/engine/histories.js";

const root = new URL("../..", import.meta.url).pathname;
const out = `${root}tests/golden`;
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

function run(events: Event[]) {
  let state = initialState();
  const steps = events.map((e) => {
    const r = apply(state, e);
    state = r.state;
    return r.ok ? { ok: true, effects: r.effects } : { ok: false, reason: r.reason };
  });
  return { steps, final: state };
}

// The fuzz generator, verbatim from the old engine.test.ts: three priced markets and a curve market under both
// ADL policies, with the events built against the live state.
function fuzzHistory(seed: number): Event[] {
  let x = seed >>> 0 || 1;
  const r = () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
  const K = (price: string, market: string): Event => ({ type: "tick", market, price });
  const T = (buyer: string, seller: string, size: number, price: string, market: string): Event => ({ type: "trade", market, buyer, seller, size, price });
  const R = (price: string, market: string): Event => ({ type: "resolve", market, price });
  const REL = (account: string, amount: string, market: string): Event => ({ type: "release", account, market, amount });
  const names = ["a", "b", "c", "d", "e", "f"];
  const markets: { id: string; event: Event; price: (mark: number) => string }[] = [
    { id: "BIN", event: { type: "market", id: "BIN", preset: "binary" }, price: () => (r() < 0.15 ? ["0", "1", "0.01", "0.99"][Math.floor(r() * 4)]! : (r() * 0.999 + 0.0005).toFixed(9)) },
    { id: "MEME", event: { type: "market", id: "MEME", preset: "perp", resolvable: true }, price: (mk) => Math.max(1e-9, mk * (r() < 0.1 ? 0.1 + r() * 8 : 0.8 + r() * 0.4)).toFixed(9) },
    { id: "EQ", event: { type: "market", id: "EQ", preset: "perp", resolvable: true, initialLeverage: 5, maintenanceLeverage: 10 }, price: (mk) => (mk * (0.9 + r() * 0.2)).toFixed(9) },
  ];
  const start: Record<string, string> = { BIN: "0.5", MEME: "0.00001", EQ: "250" };
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const events: Event[] = [];
  let s: State = initialState();
  const step = (e: Event) => {
    events.push(e);
    s = apply(s, e).state;
  };
  const adl = seed % 2 === 0 ? "pnl" : "size";
  const taperOn = seed % 3 === 0 ? { resolvesAt: 20_000, taperSeconds: 10_000 } : {};
  for (const m of markets) {
    step(m.event.type === "market" ? { ...m.event, adl, ...(m.id === "BIN" ? taperOn : {}) } : m.event);
    step(K(start[m.id]!, m.id));
  }
  step({ type: "market", id: "ATTN", preset: "attention", oracleWindow: pick([0, 300]), adl });
  for (const n of names) {
    step({ type: "deposit", account: n, amount: String(30 + Math.floor(r() * 900)) });
    for (const m of markets) step({ type: "allocate", account: n, market: m.id, amount: String(10 + Math.floor(r() * 300)) });
    step({ type: "deposit", account: n, amount: String(100 + Math.floor(r() * 3000)) });
    step({ type: "spotBuy", account: n, market: "ATTN", amount: String(50 + Math.floor(r() * 1000)) });
    step({ type: "allocate", account: n, market: "ATTN", amount: String(10 + Math.floor(r() * 300)) });
  }
  for (let i = 0; i < 120; i++) {
    if (r() < 0.25) {
      const a = pick(names);
      const roll = r();
      const mark = s.markets.ATTN!.mark!;
      if (roll < 0.35) {
        const b = pick(names.filter((n) => n !== a));
        const size = BigInt(Math.floor((5 + r() * 300) / (Number(mark) / 1e9)));
        step({ type: "trade", market: "ATTN", buyer: a, seller: b, size: size.toString(), price: (Number(mark) / 1e9).toFixed(9) });
      } else if (roll < 0.6) step({ type: "spotBuy", account: a, market: "ATTN", amount: r() < 0.2 ? "all" : String(1 + Math.floor(r() * 2000)) });
      else if (roll < 0.85) step({ type: "spotSell", account: a, market: "ATTN", tokens: "all" });
      else step({ type: "advance", seconds: 1 + Math.floor(r() * 600) });
      continue;
    }
    const m = pick(markets);
    const mark = Number(s.markets[m.id]!.mark) / 1e9;
    const roll = r();
    if (roll < 0.45) {
      const buyer = pick(names);
      const seller = pick(names.filter((n) => n !== buyer));
      const px = m.id === "BIN" ? Math.min(1, Math.max(0, mark + (r() - 0.5) * 0.02)) : mark * (0.99 + r() * 0.02);
      const notional = 5 + r() * 200;
      const size = Math.max(1, Math.floor(notional / Math.max(px, 1e-9)));
      step(T(buyer, seller, size, Math.max(px, 1e-9).toFixed(9), m.id));
    } else if (roll < 0.8) step(K(m.price(mark), m.id));
    else if (roll < 0.9) step(REL(pick(names), r() < 0.5 ? "all" : String(1 + Math.floor(r() * 50)), m.id));
    else step({ type: "allocate", account: pick(names), market: m.id, amount: r() < 0.5 ? "all" : String(1 + Math.floor(r() * 50)) });
  }
  step({ type: "advance", seconds: 25_000 });
  for (const m of markets) {
    const mark = Number(s.markets[m.id]!.mark) / 1e9;
    step(R(m.id === "BIN" ? (r() < 0.5 ? "0" : "1") : m.price(mark), m.id));
    for (const n of names) step(REL(n, "all", m.id));
  }
  for (const n of names) step({ type: "withdraw", account: n, amount: "all" });
  return events;
}

mkdirSync(`${out}/scenarios`, { recursive: true });
for (const f of readdirSync(`${root}tests/scenarios`).filter((f) => f.endsWith(".json")).sort()) {
  const { events } = JSON.parse(readFileSync(`${root}tests/scenarios/${f}`, "utf8")) as { events: Event[] };
  writeFileSync(`${out}/scenarios/${f}`, json(run(events)) + "\n");
}
for (const [file, generate] of [
  ["histories.jsonl", randomHistory],
  ["fuzz.jsonl", fuzzHistory],
] as const) {
  const lines = [];
  for (let seed = 1; seed <= 300; seed++) {
    const events = generate(seed);
    lines.push(json({ seed, events, ...run(events) }));
  }
  writeFileSync(`${out}/${file}`, lines.join("\n") + "\n");
}
console.log(`wrote ${out}`);
