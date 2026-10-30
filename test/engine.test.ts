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
  maintenanceMargin,
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
    // Size pro-rata charges frank $110.20 against a profit of only $90: $20.20 comes out of his principal.
    expect(fx).toContainEqual({ kind: "haircut", market: "OUTCOME", account: "frank", amount: usd("110.2"), fromPrincipal: usd("20.2") });
    expect(fx).toContainEqual({ kind: "haircut", market: "OUTCOME", account: "hank", amount: usd("165.3"), fromPrincipal: 0n });
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
    expect(fx).toContainEqual({ kind: "haircut", market: "PEPE", account: "ana", amount: usd("75"), fromPrincipal: 0n });
    expect(fx).toContainEqual({ kind: "haircut", market: "PEPE", account: "eve", amount: usd("25"), fromPrincipal: 0n });
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

describe("ADL policies", () => {
  const withPolicy = (events: Event[], adl: "size" | "pnl") => events.map((e) => (e.type === "market" ? { ...e, adl } : e));
  const haircutsAt = (events: Event[], adl: "size" | "pnl") => {
    const { steps } = replay(withPolicy(events, adl));
    return steps.flatMap((s) => effectsOf(s.result)).flatMap((f) => (f.kind === "haircut" ? [[f.account, f.amount, f.fromPrincipal] as const] : []));
  };

  it("pnl rule protects frank's principal in scenario B and charges the bigger winner more", () => {
    const res = haircutsAt(scenario("gap-down-resolve-1"), "pnl").filter(([a]) => a === "frank" || a === "hank");
    // Shortfall $275.50 split over positive PnL (frank $90, hank $282): no principal touched.
    expect(res.every(([, , principal]) => principal === 0n)).toBe(true);
    expect(res.reduce((sum, [, h]) => sum + h, 0n)).toBe(usd("275.5"));
    const frank = res.find(([a]) => a === "frank")![1];
    expect(frank).toBeLessThan(usd("90"));
  });

  it("scenario G: when profits can't cover the shortfall, both rules must touch principal", () => {
    const size = haircutsAt(scenario("principal-fallback"), "size");
    const pnl = haircutsAt(scenario("principal-fallback"), "pnl");
    const principal = (h: typeof size) => h.reduce((sum, [, , p]) => sum + p, 0n);
    expect(principal(size)).toBe(usd("333.333333333"));
    expect(principal(pnl)).toBe(usd("230")); // $500 shortfall − $270 total positive PnL
    expect(pnl.find(([a]) => a === "s2")![1]).toBe(usd("270") + usd("51.685393258"));
  });

  it("rejects unknown policies", () => {
    expect(run([{ type: "market", id: "Y", adl: "queue" as "size" }]).results[0]!.ok).toBe(false);
  });
});

describe("leverage graduation", () => {
  const { steps, final } = replay(scenario("graduation-blowup"));

  it("graduates on volume and depth, and never goes back down", () => {
    const tiers = steps.flatMap((s) => effectsOf(s.result)).flatMap((f) => (f.kind === "graduation" ? [f.tier] : []));
    expect(tiers).toEqual([1, 2]);
    expect(final.markets.HYPE!.tier).toBe(2); // whales left, depth collapsed, leverage stays 10x
  });

  it("a 20% gap bankrupts a 9x long that tier 0 would never have allowed", () => {
    const gap = steps.find((s) => s.event.type === "tick" && s.event.price === "0.80")!;
    expect(effectsOf(gap.result)).toContainEqual({ kind: "bankrupt", market: "HYPE", account: "carl", size: 9000n, shortfall: usd("800") });
    const atLaunch = run([perp(), ...fund("carl", "1000"), ...fund("dina", "2000"), K("1"), T("carl", "dina", 9000, "1")]);
    expect(atLaunch.results.at(-1)!.ok).toBe(false); // 9x is over the 3x launch limit
  });
});

describe("pre-resolution taper", () => {
  const taper = (extra: Partial<Extract<Event, { type: "market" }>> = {}): Event => ({ type: "market", id: M, preset: "binary", resolvesAt: 1000, taperSeconds: 500, funding: false, ...extra });
  const adv = (seconds: number): Event => ({ type: "advance", seconds });

  it("rejects resolution before the scheduled time and taper on non-resolvable markets", () => {
    expect(run([taper(), K("0.5"), R("1")]).results.at(-1)!.ok).toBe(false);
    expect(run([taper(), K("0.5"), adv(1000), R("1")]).results.at(-1)!.ok).toBe(true);
    expect(run([{ type: "market", id: M, preset: "perp", resolvesAt: 10, taperSeconds: 5 }]).results[0]!.ok).toBe(false);
  });

  it("ramps maintenance margin up to the full max loss at resolution", () => {
    const base = [taper(), ...fund("l", "1000"), ...fund("s", "1000"), K("0.06"), T("l", "s", 300, "0.06")];
    const shortMM = (events: Event[]) => {
      const m = run(events).state.markets[M]!;
      return maintenanceMargin(m, m.positions.s!);
    };
    expect(shortMM(base)).toBe(usd("3")); // normal: 300 × 0.06 / 6
    expect(shortMM([...base, adv(750)])).toBe(usd("142.5")); // halfway through the taper: 3 + (282 − 3) / 2
    expect(shortMM([...base, adv(1000)])).toBe(usd("282")); // at resolvesAt: the full max loss, 300 × (1 − 0.06)
    const thin = run([taper(), ...fund("l", "1000"), ...fund("s", "10"), K("0.06"), T("l", "s", 300, "0.06"), adv(1000)]);
    expect(thin.state.markets[M]!.positions.s!.size).toBe(0n); // couldn't keep up: liquidated during the taper
  });

  it("scenario I: no ADL anywhere; the topped-up short pays the long in full", () => {
    const { steps, final } = replay(scenario("resolution-taper"));
    const fx = steps.flatMap((s) => effectsOf(s.result));
    expect(fx.some((f) => f.kind === "haircut" || f.kind === "bankrupt")).toBe(false);
    expect(fx.find((f) => f.kind === "liquidation")).toMatchObject({ market: "NOTOPUP", account: "gina" });
    const hal = final.markets.TOPUP!.positions.hal!;
    expect(hal.realized).toBe(usd("282")); // 300 × (1 − 0.06), no haircut
  });
});

describe("funding", () => {
  it("is an exact transfer, base rate plus premium, held while the market is inactive", () => {
    const { state, results } = run([perp(), ...fund("a", "400"), ...fund("b", "400"), K("1"), T("a", "b", 1000, "1.02"), { type: "advance", seconds: 3600 }]);
    const f = effectsOf(results.at(-1)!).find((e) => e.kind === "funding")!;
    expect(f).toMatchObject({ rate: 500_000n + 2_500_000n, payers: "long", total: usd("3") }); // 0.05% + (2% / 8) per hour on $1,000
    const m = state.markets[M]!;
    expect(m.positions.a!.funding).toBe(-usd("3"));
    expect(m.positions.b!.funding).toBe(usd("3"));
  });

  it("negative premium flips the payer once it outweighs the base rate", () => {
    const { results } = run([perp(), ...fund("a", "400"), ...fund("b", "400"), K("1"), T("a", "b", 100, "0.95"), { type: "advance", seconds: 3600 }]);
    expect(effectsOf(results.at(-1)!).find((e) => e.kind === "funding")).toMatchObject({ payers: "short" });
  });

  it("can be switched off per market", () => {
    const { results } = run([{ type: "market", id: M, preset: "perp", funding: false }, ...fund("a", "400"), ...fund("b", "400"), K("1"), T("a", "b", 1000, "1"), { type: "advance", seconds: 3600 }]);
    expect(effectsOf(results.at(-1)!).some((e) => e.kind === "funding")).toBe(false);
  });

  it("scenario J: launch funding liquidates a long on day 3 with no trading", () => {
    const { steps } = replay(scenario("funding-drain"));
    const advances = steps.filter((s) => s.event.type === "advance");
    expect(advances.findIndex((s) => effectsOf(s.result).some((f) => f.kind === "liquidation"))).toBe(2);
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

  it("holds every invariant over 300 random multi-market histories, under both ADL policies", () => {
    const names = ["a", "b", "c", "d", "e", "f"];
    const markets: { id: string; event: Event; price: (r: () => number, mark: number) => string }[] = [
      { id: "BIN", event: binary("BIN"), price: (r) => (r() < 0.15 ? ["0", "1", "0.01", "0.99"][Math.floor(r() * 4)]! : (r() * 0.999 + 0.0005).toFixed(9)) },
      { id: "MEME", event: { type: "market", id: "MEME", preset: "perp", resolvable: true }, price: (r, mk) => Math.max(1e-9, mk * (r() < 0.1 ? 0.1 + r() * 8 : 0.8 + r() * 0.4)).toFixed(9) },
      { id: "EQ", event: { type: "market", id: "EQ", preset: "perp", resolvable: true, initialLeverage: 5, maintenanceLeverage: 10 }, price: (r, mk) => (mk * (0.9 + r() * 0.2)).toFixed(9) },
    ];
    const attnWindow = [0, 300];
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
      const adl = seed % 2 === 0 ? "pnl" : "size";
      const taperOn = seed % 3 === 0 ? { resolvesAt: 20_000, taperSeconds: 10_000 } : {};
      for (const m of markets) {
        step(m.event.type === "market" ? { ...m.event, adl, ...(m.id === "BIN" ? taperOn : {}) } : m.event);
        step(K(start[m.id]!, m.id));
      }
      step({ type: "market", id: "ATTN", preset: "attention", oracleWindow: pick(attnWindow), adl });
      for (const n of names) {
        step({ type: "deposit", account: n, amount: String(30 + Math.floor(r() * 900)) });
        for (const m of markets) step({ type: "allocate", account: n, market: m.id, amount: String(10 + Math.floor(r() * 300)) });
        step({ type: "deposit", account: n, amount: String(100 + Math.floor(r() * 3000)) });
        step({ type: "spotBuy", account: n, market: "ATTN", amount: String(50 + Math.floor(r() * 1000)) });
        step({ type: "allocate", account: n, market: "ATTN", amount: String(10 + Math.floor(r() * 300)) });
      }
      for (let i = 0; i < 120; i++) {
        if (r() < 0.25) {
          // curve market: perp trades at the mark, spot pumps and dumps, time passing
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
        } else if (roll < 0.8) step(K(m.price(r, mark), m.id));
        else if (roll < 0.9) step(REL(pick(names), r() < 0.5 ? "all" : String(1 + Math.floor(r() * 50)), m.id));
        else step({ type: "allocate", account: pick(names), market: m.id, amount: r() < 0.5 ? "all" : String(1 + Math.floor(r() * 50)) });
      }
      step({ type: "advance", seconds: 25_000 }); // past any scheduled resolution; accrues funding everywhere
      for (const m of markets) {
        const mark = Number(s.markets[m.id]!.mark) / 1e9;
        step(R(m.id === "BIN" ? (r() < 0.5 ? "0" : "1") : m.price(r, mark), m.id));
        for (const n of names) step(REL(n, "all", m.id));
      }
      for (const n of names) step({ type: "withdraw", account: n, amount: "all" });
      expect(marketIds(s).filter((id) => id !== "ATTN").every((id) => s.markets[id]!.vault === 0n)).toBe(true);
    }
    expect(adls).toBeGreaterThan(30);
  });
});

describe("curve-priced markets (Mirror attention design)", () => {
  const attn = (opts: Partial<Extract<Event, { type: "market" }>> = {}): Event => ({ type: "market", id: "A", preset: "attention", feeBps: 0, ...opts });
  const buy = (account: string, amount: string): Event => ({ type: "spotBuy", account, market: "A", amount });

  it("reproduces Mirror's published curve prices", () => {
    // Mirror docs: $10k demand → $0.0000450, $20k → $0.0001250, $100k → $0.0022050 (we round 1 nano in the curve's favour).
    for (const [demand, price] of [["10000", "0.000045"], ["20000", "0.000125"], ["100000", "0.002205"]] as const) {
      const { state } = run([attn(), { type: "deposit", account: "x", amount: demand }, buy("x", "all")]);
      expect(usd(price) - state.markets.A!.mark!).toBeLessThanOrEqual(1n);
    }
  });

  it("rejects external ticks on curve markets", () => {
    expect(run([attn(), { type: "tick", market: "A", price: "1" }]).results[1]!.ok).toBe(false);
  });

  it("a buy-then-sell round trip returns the USDC minus fees", () => {
    const { state } = run([
      attn({ feeBps: 100 }),
      { type: "deposit", account: "x", amount: "1000" },
      buy("x", "all"),
      { type: "spotSell", account: "x", market: "A", tokens: "all" },
    ]);
    const back = state.accounts.x!.wallet;
    expect(back).toBeLessThan(usd("1000"));
    expect(back).toBeGreaterThan(usd("979")); // two 1% fees, plus rounding in the curve's favour
  });

  it("a TWAP oracle ignores a pump until time passes", () => {
    const { state, results } = run([attn({ oracleWindow: 600 }), { type: "deposit", account: "x", amount: "5000" }, buy("x", "all")]);
    expect(state.markets.A!.mark).toBe(usd("0.000005")); // spot moved, mark did not
    expect(effectsOf(results.at(-1)!).some((f) => f.kind === "mark")).toBe(false);
    const later = apply(state, { type: "advance", seconds: 300 });
    expect(later.ok && later.state.markets.A!.mark! > usd("0.000005")).toBe(true);
  });

  it("scenario F: an instant-oracle pump bankrupts the shorts inside the pump transaction", () => {
    const { steps, final } = replay(scenario("attention-pump"));
    const pump = steps.find((s) => s.event.type === "spotBuy" && s.event.account === "mallory")!;
    expect(effectsOf(pump.result).filter((f) => f.kind === "bankrupt").map((f) => (f.kind === "bankrupt" ? f.account : ""))).toEqual(["v1", "v2"]);
    const mallory = final.accounts.mallory!;
    expect(mallory.withdrawn - mallory.deposited).toBe(usd("1900.499932236")); // $2,000 of victim collateral − $99.50 fees
  });
});

describe("pump attack sweep", async () => {
  const { runAttack } = await import("../src/attack.js");

  it("instant oracle: a modest pump extracts all victim collateral for fees only", () => {
    const r = runAttack({ pump: 5_000, window: 0, feeBps: 100, retrace: 0 });
    expect(r.victimLoss).toBe(r.victimCollateral);
    const gap = r.victimCollateral - r.attackerFees - r.attackerPnl; // curve rounds a few nano-dollars in its own favour
    expect(gap >= 0n && gap < usd("0.001")).toBe(true);
  });

  it("TWAP without arbitrage only delays the attack", () => {
    expect(runAttack({ pump: 5_000, window: 3600, feeBps: 100, retrace: 0 }).attackerPnl).toBeGreaterThan(0n);
  });

  it("TWAP with strong arbitrage makes the attack unprofitable", () => {
    for (const pump of [2_000, 5_000, 20_000]) {
      expect(runAttack({ pump, window: 600, feeBps: 100, retrace: 0.9 }).attackerPnl).toBeLessThan(0n);
    }
  });
});

describe("creator-coin launch", () => {
  const C = "COIN";
  const launch = (feeBps = 100): Event => ({ type: "market", id: C, preset: "attention", launch: true, feeBps, oracleWindow: 600 });
  const snipe = (account: string, amount: string): Event => ({ type: "snipe", account, market: C, amount });

  it("$100,000 of bids opens at $0.000125 and sells 800,000,000 tokens", () => {
    const { state, results } = run([
      launch(0),
      { type: "deposit", account: "a", amount: "100000" },
      { type: "deposit", account: "b", amount: "100000" },
      snipe("a", "75000"),
      snipe("b", "25000"),
      { type: "open", market: C },
    ]);
    expect(results.every((r) => r.ok)).toBe(true);
    const open = (results.at(-1) as Extract<Result, { ok: true }>).effects.find((e) => e.kind === "open")!;
    expect(open).toMatchObject({ price: 125_000n, sniped: usd("100000"), tokens: 800_000_000n, reserve: usd("80000") });
    const m = state.markets[C]!;
    expect(m.curve).toMatchObject({ x: usd("25000"), y: 200_000_000n });
    expect(m.mark).toBe(125_000n); // the oracle starts at the open price, TWAP or not
    expect(state.accounts.a!.spot[C]).toBe(600_000_000n);
    expect(state.accounts.b!.spot[C]).toBe(200_000_000n);
    expect(m.launch).toEqual({ open: true, bids: {}, reserve: usd("80000") });
    expect(checkInvariants(state)).toEqual([]);
  });

  it("holds bids and the launch reserve inside the conservation invariant, fee included", () => {
    const { state, results } = run([launch(100), { type: "deposit", account: "a", amount: "1000" }, snipe("a", "1000")]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(state.accounts.a!.wallet).toBe(0n);
    expect(state.fees).toBe(usd("10")); // the 1% spot fee is charged on snipes too
    expect(state.markets[C]!.launch!.bids.a).toBe(usd("990"));
    const after = apply(state, { type: "open", market: C });
    expect(after.ok).toBe(true);
    const s = (after as Extract<Result, { ok: true }>).state;
    const m = s.markets[C]!;
    expect(m.curve!.x - m.curve!.x0 + m.launch!.reserve).toBe(usd("990"));
    expect(checkInvariants(s)).toEqual([]);
  });

  it("rejects trading before the open and bids after it", () => {
    const { results } = run([
      launch(),
      ...fund("a", "1000", C),
      ...fund("b", "1000", C),
      { type: "deposit", account: "a", amount: "100" },
      { type: "spotBuy", account: "a", market: C, amount: "10" },
      T("a", "b", 1000, "0.000005", C),
      snipe("a", "50"),
      { type: "open", market: C },
      snipe("a", "50"),
      { type: "open", market: C },
      { type: "spotBuy", account: "a", market: C, amount: "10" },
    ]);
    const reasons = results.map((r) => (r.ok ? "ok" : r.reason));
    expect(reasons.slice(6)).toEqual([
      "COIN is in its snipe window: trading starts at the open",
      "COIN is in its snipe window: trading starts at the open",
      "ok",
      "ok",
      "COIN is already open",
      "COIN is already open",
      "ok",
    ]);
  });
});

describe("funding premium", () => {
  const rate = (s: State) => s.markets[M]!.fundingRate;
  const base = 500_000n; // 0.05%/h at tier 0

  it("reads the book mid, so a gap with a stale last trade doesn't pin funding at its cap", () => {
    const { state, results } = run([perp(), ...fund("a", "1000"), ...fund("b", "1000"), K("100"), T("a", "b", 1, "100"), K("50")]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(rate(state)).toBe(base + 40_000_000n); // last trade 100 vs mark 50: the premium caps at 4%/h

    const requoted = apply(state, { type: "book", market: M, mid: "50.2" });
    expect(requoted.ok).toBe(true);
    expect(rate(requoted.state)).toBe(base + 500_000n); // (50.2 − 50) / 50 / 8 = 0.05%/h
    expect(requoted.state.markets[M]!.mid).toBe(usd("50.2"));

    const emptied = apply(requoted.state, { type: "book", market: M, mid: null }); // a side of the book is empty
    expect(rate(emptied.state)).toBe(base + 40_000_000n); // back to the last trade
  });

  it("refuses a mid outside the market's bounds or on a resolved market", () => {
    const { results } = run([binary(), { type: "book", market: M, mid: "1.5" }, K("0.5"), R("1"), { type: "book", market: M, mid: null }]);
    expect(results.map((r) => (r.ok ? "ok" : r.reason))).toEqual(["ok", "price 1.5 outside [0.0000, 1.0000] for X", "ok", "ok", "X is resolved"]);
  });
});
