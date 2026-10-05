import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type Event,
  type Position,
  type Result,
  type State,
  apply,
  checkInvariants,
  equity,
  initialState,
  marketIds,
  positionIds,
  releasable,
  replay,
} from "../src/engine.js";
import { parseFixed as usd } from "../src/fixed.js";
import { stateHash } from "../src/report.js";

const scenario = (name: string) =>
  (JSON.parse(readFileSync(new URL(`../scenarios/${name}.json`, import.meta.url), "utf8")) as { events: Event[] }).events;

const M = "X";
const binary = (id = M): Event => ({ type: "market", id, preset: "binary" });
const perp = (id = M): Event => ({ type: "market", id, preset: "perp" });
/** Deposit and allocate everything to one market. */
const fund = (account: string, amount: string, market = M): Event[] => [
  { type: "deposit", account, amount },
  { type: "allocate", account, market, amount },
];
const T = (buyer: string, seller: string, size: number, price: string, market = M): Event => ({ type: "trade", market, buyer, seller, size, price });
const K = (price: string, market = M): Event => ({ type: "tick", market, price });
const R = (price: string, market = M): Event => ({ type: "resolve", market, price });
const REL = (account: string, amount: string, market = M): Event => ({ type: "release", account, market, amount });

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
const pos = (s: State, account: string, market = M): Position => s.markets[market]!.positions[account]!;
const netPnl = (s: State, account: string, market = M) => {
  const p = pos(s, account, market);
  return p.realized + p.adlTransfer;
};

describe("scenario A: binary gap 0.60 → 0.05, resolve 0", () => {
  const events = scenario("gap-down-resolve-0");
  const { steps, final } = replay(events);
  const gap = steps.find((s) => s.event.type === "tick" && s.event.price === "0.05")!;

  it("bankrupts the levered longs with exact shortfalls", () => {
    const bankrupt = effectsOf(gap.result).filter((e) => e.kind === "bankrupt");
    expect(bankrupt.map((b) => (b.kind === "bankrupt" ? [b.account, b.size, b.shortfall] : []))).toEqual([
      ["alice", 600n, usd("178")],
      ["bob", 500n, usd("107")],
    ]);
  });

  it("charges shorts pro-rata by size, summing exactly to the shortfall", () => {
    const haircuts = effectsOf(gap.result).flatMap((e) => (e.kind === "haircut" ? [[e.account, e.amount] as const] : []));
    expect(haircuts).toEqual([
      ["carol", 153_461_538_462n],
      ["dave", 87_692_307_692n],
      ["erin", 43_846_153_846n],
    ]);
    expect(haircuts.reduce((s, [, h]) => s + h, 0n)).toBe(usd("285"));
  });

  it("force-reduces shorts by the closed long size and leaves the solvent long untouched", () => {
    const s = gap.result.state;
    const m = "OUTCOME";
    expect([pos(s, "alice", m).size, pos(s, "bob", m).size]).toEqual([0n, 0n]);
    expect([pos(s, "carol", m).size, pos(s, "dave", m).size, pos(s, "erin", m).size]).toEqual([-108n, -61n, -31n]);
    expect(pos(s, "frank", m).size).toBe(200n);
    expect(equity(pos(s, "alice", m), s.markets[m]!.mark)).toBe(0n);
  });

  it("rejects releases from the bankrupt account and over-releases", () => {
    const rejected = steps.filter((s) => !s.result.ok).map((s) => s.event);
    expect(rejected).toContainEqual(REL("alice", "1", "OUTCOME"));
    expect(rejected).toContainEqual(REL("carol", "1000", "OUTCOME"));
    expect(rejected).toContainEqual(REL("bob", "100", "OUTCOME"));
  });

  it("drains every wallet and vault to exactly zero", () => {
    expect(final.markets.OUTCOME!.status).toBe("resolved");
    expect(final.markets.OUTCOME!.vault).toBe(0n);
    expect(final.totalDeposits - final.totalWithdrawals).toBe(0n);
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
    expect(fx).toContainEqual({ kind: "bankrupt", market: "OUTCOME", account: "gina", size: -300n, shortfall: usd("275.5") });
    expect(fx).toContainEqual({ kind: "haircut", market: "OUTCOME", account: "frank", amount: usd("110.2") });
    expect(fx).toContainEqual({ kind: "haircut", market: "OUTCOME", account: "hank", amount: usd("165.3") });
  });

  it("caps hank's payout at what gina actually posted", () => {
    // Theoretical PnL 300 × (1 − 0.06) = 282; received 282 − 165.30 = 116.70.
    expect(netPnl(final, "hank", "OUTCOME")).toBe(usd("116.7"));
    expect(final.totalDeposits - final.totalWithdrawals).toBe(0n);
  });
});

describe("scenario C: binary gap up with liquidation and ADL", () => {
  const { steps } = replay(scenario("gap-up-resolve-0"));
  const gap = steps.find((s) => s.event.type === "tick" && s.event.price === "0.95")!;

  it("liquidates pia (E ≥ 0) at mark and lets them keep the residual", () => {
    expect(effectsOf(gap.result).find((e) => e.kind === "liquidation")).toMatchObject({ account: "pia", equity: usd("2.5") });
    expect(pos(gap.result.state, "pia", "OUTCOME").collateral).toBe(usd("2.5"));
    expect(pos(gap.result.state, "pia", "OUTCOME").adlTransfer).toBe(0n);
  });

  it("leaves the near-fully collateralized short untouched", () => {
    expect(pos(gap.result.state, "quinn", "OUTCOME").size).toBe(-100n);
  });
});

describe("scenario D: unbounded memecoin squeeze", () => {
  const { steps, final } = replay(scenario("memecoin-squeeze"));
  const gap = steps.find((s) => s.event.type === "tick" && s.event.price === "0.00004")!;

  it("bankrupts a 0.5x short: no collateral ratio is safe on an unbounded asset", () => {
    expect(effectsOf(gap.result)).toContainEqual({ kind: "bankrupt", market: "PEPE", account: "dan", size: -10_000_000n, shortfall: usd("100") });
  });

  it("charges the longs pro-rata and drains to zero", () => {
    const fx = effectsOf(gap.result);
    expect(fx).toContainEqual({ kind: "haircut", market: "PEPE", account: "ana", amount: usd("75") });
    expect(fx).toContainEqual({ kind: "haircut", market: "PEPE", account: "eve", amount: usd("25") });
    expect(final.totalDeposits - final.totalWithdrawals).toBe(0n);
  });
});

describe("scenario E: isolation across markets", () => {
  const { steps } = replay(scenario("isolation-two-markets"));
  const blowup = steps.find((s) => s.event.type === "tick" && s.event.market === "ELECTION" && s.event.price === "0.02")!;

  it("bankrupts alice in ELECTION", () => {
    expect(effectsOf(blowup.result).some((e) => e.kind === "bankrupt" && e.account === "alice")).toBe(true);
  });

  it("leaves BTCX byte-for-byte identical", () => {
    expect(stateHash({ ...initialState(), markets: { BTCX: blowup.result.state.markets.BTCX! } })).toBe(
      stateHash({ ...initialState(), markets: { BTCX: blowup.before.markets.BTCX! } }),
    );
  });
});

describe("markets", () => {
  it("rejects duplicate markets, bad bounds and bad leverage", () => {
    expect(run([binary(), binary()]).results[1]!.ok).toBe(false);
    expect(run([{ type: "market", id: "Y", bounds: ["1", "0.5"] }]).results[0]!.ok).toBe(false);
    expect(run([{ type: "market", id: "Y", initialLeverage: 10, maintenanceLeverage: 5 }]).results[0]!.ok).toBe(false);
  });

  it("enforces price bounds per market type", () => {
    expect(run([binary(), K("1.01")]).results[1]!.ok).toBe(false);
    expect(run([perp(), K("1.01")]).results[1]!.ok).toBe(true);
    expect(run([perp(), K("0")]).results[1]!.ok).toBe(false);
    expect(run([binary(), K("0")]).results[1]!.ok).toBe(true);
  });

  it("only resolves resolvable markets", () => {
    expect(run([perp(), K("10"), R("12")]).results[2]!.ok).toBe(false);
    expect(run([{ type: "market", id: M, preset: "perp", resolvable: true }, K("10"), R("12")]).results[2]!.ok).toBe(true);
  });

  it("supports sub-micro prices exactly", () => {
    const { state } = run([perp(), ...fund("a", "10"), ...fund("b", "10"), K("0.000000005"), T("a", "b", 1_000_000_000, "0.000000005")]);
    expect(pos(state, "a").basis).toBe(usd("5"));
  });
});

describe("trade validation", () => {
  const base = [binary(), ...fund("a", "10"), ...fund("b", "100")];

  it("needs an oracle price first", () => {
    expect(run([...base, T("a", "b", 10, "0.5")]).results.at(-1)).toMatchObject({ ok: false, reason: "X has no oracle price yet" });
  });

  it("needs collateral in that market", () => {
    expect(run([...base, perp("Y"), K("5", "Y"), T("a", "b", 1, "5", "Y")]).results.at(-1)!.ok).toBe(false);
  });

  it("enforces initial margin at mark for both sides", () => {
    expect(run([...base, K("0.5"), T("a", "b", 60, "0.5")]).results.at(-1)!.ok).toBe(true);
    expect(run([...base, K("0.5"), T("a", "b", 61, "0.5")]).results.at(-1)!.ok).toBe(false);
  });

  it("values off-mark trades at mark, so a bad price can't sneak in insolvency", () => {
    expect(run([...base, K("0.5"), T("a", "b", 30, "0.9")]).results.at(-1)!.ok).toBe(false);
  });

  it("rejects self-trades and trades after resolution", () => {
    expect(run([...base, K("0.5"), T("a", "a", 1, "0.5")]).results.at(-1)!.ok).toBe(false);
    expect(run([...base, K("0.5"), R("1"), T("a", "b", 1, "0.5")]).results.at(-1)!.ok).toBe(false);
  });

  it("lets a position reduce while between MM and IM", () => {
    const { results } = run([...base, ...fund("c", "100"), K("0.5"), T("a", "b", 60, "0.5"), K("0.45"), T("c", "a", 30, "0.45")]);
    expect(results.at(-1)!.ok).toBe(true);
  });
});

describe("wallet and release", () => {
  it("releases realized collateral only, never unrealized profit", () => {
    const { state, results } = run([binary(), ...fund("a", "100"), ...fund("b", "100"), K("0.5"), T("a", "b", 100, "0.5"), K("0.9"), REL("a", "101")]);
    const m = state.markets[M]!;
    expect(equity(pos(state, "a"), m.mark)).toBe(usd("140"));
    expect(results.at(-1)!.ok).toBe(false); // equity − IM = 110, but collateral is 100
    expect(releasable(m, pos(state, "a"))).toBe(usd("100"));
  });

  it("cannot allocate or withdraw more than the wallet holds", () => {
    expect(run([binary(), { type: "deposit", account: "a", amount: "5" }, { type: "allocate", account: "a", market: M, amount: "6" }]).results.at(-1)!.ok).toBe(false);
    expect(run([binary(), ...fund("a", "5"), { type: "withdraw", account: "a", amount: "1" }]).results.at(-1)!.ok).toBe(false);
  });
});

describe("rounding", () => {
  it("allocates an indivisible shortfall exactly across equal absorbers", () => {
    const { state, results } = run([
      binary(),
      ...fund("L", "10.000000001"),
      ...fund("s1", "50"),
      ...fund("s2", "50"),
      ...fund("s3", "50"),
      K("0.5"),
      T("L", "s1", 20, "0.5"),
      T("L", "s2", 20, "0.5"),
      T("L", "s3", 20, "0.5"),
      K("0"),
    ]);
    const amounts = effectsOf(results.at(-1)!).flatMap((e) => (e.kind === "haircut" ? [e.amount] : []));
    expect(amounts.reduce((a, b) => a + b, 0n)).toBe(usd("19.999999999"));
    expect(amounts).toEqual([6_666_666_667n, 6_666_666_666n, 6_666_666_666n]);
    expect(checkInvariants(state)).toEqual([]);
  });
});

describe("why clamping is not solvency", () => {
  it("clamping a bankrupt position to zero creates claims the vault can't pay", () => {
    const events = scenario("gap-down-resolve-0");
    const gapIndex = events.findIndex((e) => e.type === "tick" && e.price === "0.05");
    let s = initialState();
    for (const e of events.slice(0, gapIndex)) s = apply(s, e).state;
    const m = structuredClone(s.markets.OUTCOME!);
    m.mark = usd("0.05"); // raw price update, no risk processing
    const claims = positionIds(m).reduce((sum, id) => {
      const e = equity(m.positions[id]!, m.mark);
      return sum + (e < 0n ? 0n : e);
    }, 0n);
    expect(claims - m.vault).toBe(usd("285"));
  });
});

// Seeded fuzz across several markets of different types. apply() asserts every per-market and global
// invariant after every transition and throws on violation.
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

  it("holds every invariant over 300 random multi-market histories", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const markets: { id: string; event: Event; price: (r: () => number, mark: number) => string }[] = [
      { id: "BIN", event: binary("BIN"), price: (r) => (r() < 0.15 ? ["0", "1", "0.01", "0.99"][Math.floor(r() * 4)]! : (r() * 0.999 + 0.0005).toFixed(9)) },
      { id: "MEME", event: { type: "market", id: "MEME", preset: "perp", resolvable: true }, price: (r, mk) => Math.max(1e-9, mk * (r() < 0.1 ? 0.1 + r() * 8 : 0.8 + r() * 0.4)).toFixed(9) },
      { id: "EQ", event: { type: "market", id: "EQ", preset: "perp", resolvable: true, initialLeverage: 5, maintenanceLeverage: 10 }, price: (r, mk) => (mk * (0.9 + r() * 0.2)).toFixed(9) },
    ];
    const start: Record<string, string> = { BIN: "0.5", MEME: "0.00001", EQ: "250" };
    let adls = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
      let s = initialState();
      const step = (e: Event) => {
        const res = apply(s, e);
        if (res.ok && res.effects.some((f) => f.kind === "haircut")) adls++;
        s = res.state;
      };
      for (const m of markets) {
        step(m.event);
        step(K(start[m.id]!, m.id));
      }
      for (const n of names) {
        step({ type: "deposit", account: n, amount: String(30 + Math.floor(r() * 900)) });
        for (const m of markets) step({ type: "allocate", account: n, market: m.id, amount: String(10 + Math.floor(r() * 300)) });
      }
      for (let i = 0; i < 120; i++) {
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
        } else if (roll < 0.8) step(K(m.price(r, mark), m.id));
        else if (roll < 0.9) step(REL(pick(names), r() < 0.5 ? "all" : String(1 + Math.floor(r() * 50)), m.id));
        else step({ type: "allocate", account: pick(names), market: m.id, amount: r() < 0.5 ? "all" : String(1 + Math.floor(r() * 50)) });
      }
      for (const m of markets) {
        const mark = Number(s.markets[m.id]!.mark) / 1e9;
        step(R(m.id === "BIN" ? (r() < 0.5 ? "0" : "1") : m.price(r, mark), m.id));
        for (const n of names) step(REL(n, "all", m.id));
      }
      for (const n of names) step({ type: "withdraw", account: n, amount: "all" });
      expect(marketIds(s).every((id) => s.markets[id]!.vault === 0n)).toBe(true);
      expect(s.totalDeposits - s.totalWithdrawals).toBe(0n);
    }
    expect(adls).toBeGreaterThan(30);
  });
});
