// Differential test: the Rust engine (rs/engine) must do exactly what src/engine.ts does. Every scenario and a
// few hundred random histories go through both; each step's outcome (effects, or the rejection reason) and the
// final state must be identical.
//
// Needs the replay binary: `cargo build --manifest-path rs/Cargo.toml` (pnpm test builds it first).

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type Event, apply, initialState } from "../src/engine.js";
import { randomHistory } from "./histories.js";

const root = new URL("..", import.meta.url).pathname;
const bin = `${root}rs/target/debug/impulse-replay`;

/** JSON with bigints as decimal strings, the Rust side's encoding. */
const plain = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

function runTs(events: Event[]) {
  let state = initialState();
  const steps = events.map((e) => {
    const r = apply(state, e);
    state = r.state;
    return r.ok ? { ok: true, effects: r.effects } : { ok: false, reason: r.reason };
  });
  return plain({ steps, final: state });
}

function runRust(histories: Event[][]): unknown[] {
  const out = execFileSync(bin, [], { input: JSON.stringify(histories.map((events) => ({ events }))), maxBuffer: 1 << 30 });
  return JSON.parse(out.toString());
}

function compare(name: string, events: Event[], rust: unknown) {
  const ts = runTs(events) as { steps: unknown[]; final: unknown };
  const rs = rust as { steps: unknown[]; final: unknown; fatal?: string };
  expect(rs.fatal, `${name}: rust engine failed`).toBeUndefined();
  for (let i = 0; i < events.length; i++) {
    expect(rs.steps[i], `${name} step ${i}: ${JSON.stringify(events[i])}`).toEqual(ts.steps[i]);
  }
  expect(rs.final, `${name}: final state`).toEqual(ts.final);
}

describe.skipIf(!existsSync(bin))("differential: Rust engine = TS engine", () => {
  it("replays every scenario identically", () => {
    const files = readdirSync(`${root}scenarios`).filter((f) => f.endsWith(".json")).sort();
    const scenarios = files.map((f) => (JSON.parse(readFileSync(`${root}scenarios/${f}`, "utf8")) as { events: Event[] }).events);
    const rust = runRust(scenarios);
    files.forEach((f, i) => compare(f, scenarios[i]!, rust[i]));
    expect(files.length).toBeGreaterThan(5);
  });

  it("replays 300 random histories identically", () => {
    const histories = Array.from({ length: 300 }, (_, i) => randomHistory(i + 1));
    const rust = runRust(histories);
    let rejected = 0;
    let haircuts = 0;
    let opens = 0;
    let snipes = 0;
    let books = 0;
    histories.forEach((h, i) => {
      compare(`seed ${i + 1}`, h, rust[i]);
      const steps = (rust[i] as { steps: { ok: boolean; effects?: { kind: string }[] }[] }).steps;
      rejected += steps.filter((s) => !s.ok).length;
      haircuts += steps.filter((s) => s.effects?.some((e) => e.kind === "haircut")).length;
      opens += steps.filter((s) => s.effects?.some((e) => e.kind === "open")).length;
      snipes += h.filter((e, j) => e.type === "snipe" && steps[j]!.ok).length;
      books += h.filter((e, j) => e.type === "book" && e.mid !== null && steps[j]!.ok).length;
    });
    // The histories must actually exercise refusals and ADL, or the comparison proves little.
    expect(rejected).toBeGreaterThan(300);
    expect(haircuts).toBeGreaterThan(30);
    expect(opens).toBe(300); // every history launches its creator coin
    expect(snipes).toBeGreaterThan(600);
    expect(books).toBeGreaterThan(300); // book mids set, so funding premiums come from them
  }, 120_000);
});
