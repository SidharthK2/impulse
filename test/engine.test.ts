import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Event,
  type Result,
  type State,
  apply,
  checkInvariants,
  equity,
  ids,
  initialState,
  replay,
  withdrawable,
} from "../src/engine.js";
import { parseMicro as usd } from "../src/fixed.js";
import { stateHash } from "../src/report.js";

const scenario = (name: string) =>
  (JSON.parse(readFileSync(new URL(`../scenarios/${name}.json`, import.meta.url), "utf8")) as { events: Event[] }).events;

const D = (account: string, amount: string): Event => ({ type: "deposit", account, amount });
const W = (account: string, amount: string): Event => ({ type: "withdraw", account, amount });
const T = (buyer: string, seller: string, size: number, price: string): Event => ({ type: "trade", buyer, seller, size, price });
const K = (price: string): Event => ({ type: "tick", price });
const R = (outcome: 0 | 1): Event => ({ type: "resolve", outcome });

function run(events: Event[]): { state: State; results: Result[] } {
  let state = initialState();
  const results: Result[] = [];
  for (const e of events) {
    const r = apply(state, e);
    results.push(r);
    state = r.state;
  }
  return { state, results };
}

const effectsOf = (r: Result) => (r.ok ? r.effects : []);

describe("scenario A: gap 0.60 → 0.05, resolve 0", () => {
  const events = scenario("gap-down-resolve-0");
  const { steps, final } = replay(events);
  const gap = steps.find((s) => s.event.type === "tick" && s.event.price === "0.05")!;

  it("bankrupts the levered longs with exact shortfalls", () => {
    const bankrupt = effectsOf(gap.result).filter((e) => e.kind === "bankrupt");
    expect(bankrupt).toEqual([
      { kind: "bankrupt", account: "alice", size: 600n, shortfall: usd("178") },
      { kind: "bankrupt", account: "bob", size: 500n, shortfall: usd("107") },
    ]);
  });

  it("charges shorts pro-rata by size, summing exactly to the shortfall", () => {
    const haircuts = effectsOf(gap.result).filter((e) => e.kind === "haircut");
    expect(haircuts.map((h) => (h.kind === "haircut" ? [h.account, h.amount] : []))).toEqual([
      ["carol", 153_461_538n],
      ["dave", 87_692_308n],
      ["erin", 43_846_154n],
    ]);
    expect(haircuts.reduce((s, h) => s + (h.kind === "haircut" ? h.amount : 0n), 0n)).toBe(usd("285"));
  });

  it("force-reduces shorts by the closed long size and leaves the solvent long untouched", () => {
    const s = gap.result.state;
    expect(s.accounts.alice!.size).toBe(0n);
    expect(s.accounts.bob!.size).toBe(0n);
    expect([s.accounts.carol!.size, s.accounts.dave!.size, s.accounts.erin!.size]).toEqual([-108n, -61n, -31n]);
    expect(s.accounts.frank!.size).toBe(200n);
    expect(equity(s.accounts.alice!, s.mark)).toBe(0n);
    expect(equity(s.accounts.bob!, s.mark)).toBe(0n);
  });

  it("rejects withdrawals from the bankrupt account and over-withdrawals", () => {
    const rejected = steps.filter((s) => !s.result.ok).map((s) => s.event);
    expect(rejected).toContainEqual(W("alice", "1"));
    expect(rejected).toContainEqual(W("carol", "1000"));
    expect(rejected).toContainEqual(W("bob", "100"));
  });

  it("drains the vault to exactly zero after resolution", () => {
    expect(final.status).toBe("resolved");
    expect(final.vault).toBe(0n);
    for (const id of ids(final)) expect(final.accounts[id]!.cash).toBe(0n);
  });

  it("is deterministic", () => {
    expect(stateHash(replay(events).final)).toBe(stateHash(final));
  });
});

describe("scenario B: levered short resolves to 1", () => {
  const { steps, final } = replay(scenario("gap-down-resolve-1"));
  const res = steps.find((s) => s.event.type === "resolve")!;

  it("bankrupts gina and charges both longs pro-rata", () => {
    const fx = effectsOf(res.result);
    expect(fx).toContainEqual({ kind: "bankrupt", account: "gina", size: -300n, shortfall: usd("275.5") });
    expect(fx).toContainEqual({ kind: "haircut", account: "frank", amount: usd("110.2") });
    expect(fx).toContainEqual({ kind: "haircut", account: "hank", amount: usd("165.3") });
  });

  it("caps hank's payout at what gina actually posted", () => {
    // Theoretical PnL 300 × (1 − 0.06) = 282; received 282 − 165.30 = 116.70.
    const h = final.accounts.hank!;
    expect(h.cash + h.withdrawn - h.deposited).toBe(usd("116.7"));
    expect(final.vault).toBe(0n);
  });
});

describe("scenario C: gap up with liquidation and ADL", () => {
  const { steps } = replay(scenario("gap-up-resolve-0"));
  const gap = steps.find((s) => s.event.type === "tick" && s.event.price === "0.95")!;

  it("liquidates pia (E ≥ 0) at mark and lets them keep the residual", () => {
    const fx = effectsOf(gap.result);
    expect(fx.find((e) => e.kind === "liquidation")).toMatchObject({ account: "pia", equity: usd("2.5") });
    expect(gap.result.state.accounts.pia!.cash).toBe(usd("2.5"));
    expect(gap.result.state.accounts.pia!.adlTransfer).toBe(0n);
  });

  it("leaves the near-fully collateralized short untouched", () => {
    expect(gap.result.state.accounts.quinn!.size).toBe(-100n);
  });
});

describe("trade validation", () => {
  const base = [D("a", "10"), D("b", "100")];

  it("needs an oracle price first", () => {
    const { results } = run([...base, T("a", "b", 10, "0.5")]);
    expect(results.at(-1)).toMatchObject({ ok: false, reason: "no oracle price yet" });
  });

  it("enforces initial margin at mark for both sides", () => {
    // 3x on 60 contracts at 0.5 needs $10; 61 needs $10.17.
    expect(run([...base, K("0.5"), T("a", "b", 60, "0.5")]).results.at(-1)!.ok).toBe(true);
    expect(run([...base, K("0.5"), T("a", "b", 61, "0.5")]).results.at(-1)!.ok).toBe(false);
  });

  it("values off-mark trades at mark, so a bad price can't sneak in insolvency", () => {
    // Buying at 0.9 when mark is 0.5 is an instant loss of 0.4/contract.
    const { results } = run([...base, K("0.5"), T("a", "b", 30, "0.9")]);
    expect(results.at(-1)!.ok).toBe(false);
  });

  it("rejects self-trades, out-of-range prices and trades after resolution", () => {
    expect(run([...base, K("0.5"), T("a", "a", 1, "0.5")]).results.at(-1)!.ok).toBe(false);
    expect(run([...base, K("0.5"), T("a", "b", 1, "1.01")]).results.at(-1)!.ok).toBe(false);
    expect(run([...base, K("0.5"), R(1), T("a", "b", 1, "0.5")]).results.at(-1)!.ok).toBe(false);
  });

  it("lets an account reduce while between MM and IM", () => {
    // a long 60 @ 0.5 with $10; tick to 0.45 → equity 7, IM 9, MM 4.5.
    const { results } = run([...base, D("c", "100"), K("0.5"), T("a", "b", 60, "0.5"), K("0.45"), T("c", "a", 30, "0.45")]);
    expect(results.at(-1)!.ok).toBe(true);
  });
});

describe("withdrawals", () => {
  it("allows realized cash only, never unrealized profit", () => {
    const { state, results } = run([D("a", "100"), D("b", "100"), K("0.5"), T("a", "b", 100, "0.5"), K("0.9"), W("a", "101")]);
    expect(equity(state.accounts.a!, state.mark)).toBe(usd("140"));
    // equity − IM = 140 − 30 = 110, but cash is still 100: the 40 profit is unrealized.
    expect(results.at(-1)!.ok).toBe(false);
    expect(withdrawable(state, state.accounts.a!)).toBe(usd("100"));
  });
});

describe("rounding", () => {
  it("allocates an indivisible shortfall exactly across equal absorbers", () => {
    // Three equal shorts; the long goes bankrupt by an amount not divisible by 3.
    const { state, results } = run([
      D("L", "10.000001"),
      D("s1", "50"),
      D("s2", "50"),
      D("s3", "50"),
      K("0.5"),
      T("L", "s1", 20, "0.5"),
      T("L", "s2", 20, "0.5"),
      T("L", "s3", 20, "0.5"),
      K("0"),
    ]);
    const haircuts = effectsOf(results.at(-1)!).filter((e) => e.kind === "haircut");
    const amounts = haircuts.map((h) => (h.kind === "haircut" ? h.amount : 0n));
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(usd("19.999999"));
    expect(amounts).toEqual([6_666_667n, 6_666_666n, 6_666_666n]);
    expect(checkInvariants(state)).toEqual([]);
  });
});

describe("why clamping is not solvency", () => {
  it("clamping a bankrupt account to zero creates claims the vault can't pay", () => {
    // Replay the gap but skip the ADL step: measure what naive clamping would show.
    let s = initialState();
    for (const e of scenario("gap-down-resolve-0").slice(0, 18)) s = apply(s, e).state;
    s = structuredClone(s);
    s.mark = usd("0.05"); // raw price update, no risk processing
    const claims = ids(s).reduce((sum, id) => {
      const e = equity(s.accounts[id]!, s.mark);
      return sum + (e < 0n ? 0n : e);
    }, 0n);
    expect(claims - s.vault).toBe(usd("285")); // exactly the unallocated shortfall
  });
});

// Seeded fuzz: random deposits, trades, ticks (including gaps to the bounds), withdrawals.
// apply() asserts every invariant after every transition and throws on violation.
describe("fuzz", () => {
  function rng(seed: number) {
    let x = seed >>> 0 || 1;
    return () => {
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      return (x >>> 0) / 2 ** 32;
    };
  }

  it("holds every invariant over 300 random histories, both gap directions", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    let adls = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      const price = () => (r() < 0.15 ? pick(["0", "1", "0.01", "0.99"]) : (Math.floor(r() * 999_999) / 1e6 + 0.000001).toFixed(6));
      let s = initialState();
      const step = (e: Event) => {
        const res = apply(s, e);
        if (res.ok && res.effects.some((f) => f.kind === "haircut")) adls++;
        s = res.state;
      };
      for (const n of names) step(D(n, String(10 + Math.floor(r() * 500))));
      step(K(price()));
      for (let i = 0; i < 80; i++) {
        const roll = r();
        if (roll < 0.5) {
          const buyer = pick(names);
          const seller = pick(names.filter((n) => n !== buyer));
          const mark = Number(s.mark) / 1e6;
          const px = Math.min(1, Math.max(0, mark + (r() - 0.5) * 0.02)).toFixed(6);
          step(T(buyer, seller, 1 + Math.floor(r() * 400), px));
        } else if (roll < 0.85) step(K(price()));
        else if (roll < 0.95) step(W(pick(names), r() < 0.5 ? "all" : String(1 + Math.floor(r() * 50))));
        else step(D(pick(names), String(1 + Math.floor(r() * 100))));
      }
      step(R(r() < 0.5 ? 0 : 1));
      for (const n of names) step(W(n, "all"));
      expect(s.vault).toBe(0n);
    }
    expect(adls).toBeGreaterThan(20); // the fuzz actually exercises ADL
  });
});
