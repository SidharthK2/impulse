// Seeded random event histories for the differential test (TS engine vs Rust engine). Each history is built by
// driving the TS engine, so sizes and prices track the live marks, and it deliberately includes events the
// engine rejects (unknown accounts, over-withdrawals, trades without collateral) so rejection reasons are
// compared too.

import { type Event, type State, apply, initialState } from "../../reference/engine/engine.js";

export function rng(seed: number) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 2 ** 32;
  };
}

export function randomHistory(seed: number): Event[] {
  const r = rng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
  const names = ["a", "b", "c", "d", "e"];
  const events: Event[] = [];
  let s: State = initialState();
  const step = (e: Event) => {
    events.push(e);
    const res = apply(s, e);
    s = res.state;
  };
  const adl = seed % 2 === 0 ? "pnl" : "size";
  const taper = seed % 3 === 0 ? { resolvesAt: 20_000, taperSeconds: 10_000 } : {};
  const priced: { id: string; event: Event; start: string; move: (mk: number) => string }[] = [
    {
      id: "BIN",
      event: { type: "market", id: "BIN", preset: "binary", adl, ...taper },
      start: "0.5",
      move: () => (r() < 0.15 ? pick(["0", "1", "0.01", "0.99"]) : (r() * 0.999 + 0.0005).toFixed(9)),
    },
    {
      id: "MEME",
      event: { type: "market", id: "MEME", preset: "perp", resolvable: true, adl, funding: seed % 5 !== 0 },
      start: "0.00001",
      move: (mk) => Math.max(1e-9, mk * (r() < 0.1 ? 0.1 + r() * 8 : 0.8 + r() * 0.4)).toFixed(9),
    },
    {
      id: "EQ",
      event: { type: "market", id: "EQ", preset: "perp", resolvable: true, initialLeverage: 5, maintenanceLeverage: 10, adl },
      start: "250",
      move: (mk) => (mk * (0.9 + r() * 0.2)).toFixed(9),
    },
  ];
  for (const m of priced) {
    step(m.event);
    step({ type: "tick", market: m.id, price: m.start });
  }
  step({ type: "market", id: "ATTN", preset: "attention", oracleWindow: pick([0, 60, 300]), adl, feeBps: pick([0, 100, 250]) });
  // A creator coin with a snipe window: bids before the open, trading after it.
  step({ type: "market", id: "COIN", preset: "attention", launch: true, oracleWindow: pick([0, 60, 600]), adl, feeBps: pick([0, 100]) });
  for (const n of names) {
    step({ type: "deposit", account: n, amount: String(30 + Math.floor(r() * 900)) });
    for (const m of priced) step({ type: "allocate", account: n, market: m.id, amount: String(10 + Math.floor(r() * 300)) });
    step({ type: "deposit", account: n, amount: String(100 + Math.floor(r() * 3000)) });
    step({ type: "spotBuy", account: n, market: "ATTN", amount: String(50 + Math.floor(r() * 1000)) });
    step({ type: "allocate", account: n, market: "ATTN", amount: String(10 + Math.floor(r() * 300)) });
    step({ type: "allocate", account: n, market: "COIN", amount: String(10 + Math.floor(r() * 300)) });
    if (r() < 0.8) step({ type: "snipe", account: n, market: "COIN", amount: r() < 0.05 ? "all" : String(1 + Math.floor(r() * 3000)) });
  }
  const steps = 80 + Math.floor(r() * 120);
  const openAt = Math.floor(r() * (steps / 2));
  for (let i = 0; i < steps; i++) {
    if (i === openAt) step({ type: "open", market: "COIN" });
    const roll0 = r();
    if (roll0 < 0.04) {
      // things the engine must refuse, identically
      step(
        pick<Event>([
          { type: "withdraw", account: pick(names), amount: "999999" },
          { type: "allocate", account: "nobody", market: "EQ", amount: "1" },
          { type: "trade", market: "EQ", buyer: "a", seller: "a", size: 1, price: "250" },
          { type: "trade", market: "NOPE", buyer: "a", seller: "b", size: 1, price: "1" },
          { type: "tick", market: "ATTN", price: "1" },
          { type: "tick", market: "BIN", price: "1.5" },
          { type: "release", account: "z", market: "EQ", amount: "all" },
          { type: "spotSell", account: pick(names), market: "ATTN", tokens: "999999999999" },
          { type: "advance", seconds: 0 },
          { type: "market", id: "EQ", preset: "perp" },
          { type: "market", id: "BAD", preset: "perp", initialLeverage: 5, maintenanceLeverage: 2 },
          { type: "resolve", market: "ATTN", price: "1" },
          { type: "open", market: "ATTN" },
          { type: "snipe", account: "a", market: "EQ", amount: "1" },
          { type: "snipe", account: pick(names), market: "COIN", amount: "5" },
          { type: "snipe", account: "nobody", market: "COIN", amount: "5" },
          { type: "market", id: "BADL", preset: "perp", launch: true },
          { type: "book", market: "BIN", mid: "1.5" },
          { type: "book", market: "NOPE", mid: null },
        ]),
      );
      continue;
    }
    if (roll0 < 0.3) {
      const cm = r() < 0.5 ? "ATTN" : "COIN";
      const a = pick(names);
      const roll = r();
      const mark = s.markets[cm]!.mark!;
      if (cm === "COIN" && !s.markets.COIN!.launch!.open && roll < 0.3) step({ type: "snipe", account: a, market: "COIN", amount: String(1 + Math.floor(r() * 500)) });
      else if (roll < 0.35) {
        const b = pick(names.filter((n) => n !== a));
        const size = BigInt(Math.max(1, Math.floor((5 + r() * 300) / (Number(mark) / 1e9))));
        step({ type: "trade", market: cm, buyer: a, seller: b, size: size.toString(), price: (Number(mark) / 1e9).toFixed(9) });
      } else if (roll < 0.6) step({ type: "spotBuy", account: a, market: cm, amount: r() < 0.2 ? "all" : String(1 + Math.floor(r() * 2000)) });
      else if (roll < 0.8) step({ type: "spotSell", account: a, market: cm, tokens: r() < 0.5 ? "all" : String(1 + Math.floor(r() * 1e6)) });
      else step({ type: "advance", seconds: 1 + Math.floor(r() * 600) });
      continue;
    }
    const m = pick(priced);
    const mk = s.markets[m.id]!.mark;
    const mark = mk === null ? 1 : Number(mk) / 1e9;
    const roll = r();
    if (roll < 0.42) {
      const buyer = pick(names);
      const seller = pick(names.filter((n) => n !== buyer));
      const px = m.id === "BIN" ? Math.min(1, Math.max(0, mark + (r() - 0.5) * 0.02)) : mark * (0.99 + r() * 0.02);
      const notional = 5 + r() * 200;
      const size = Math.max(1, Math.floor(notional / Math.max(px, 1e-9)));
      step({ type: "trade", market: m.id, buyer, seller, size, price: Math.max(px, 1e-9).toFixed(9) });
    } else if (roll < 0.72) step({ type: "tick", market: m.id, price: m.move(mark) });
    else if (roll < 0.82) step({ type: "release", account: pick(names), market: m.id, amount: r() < 0.5 ? "all" : String(1 + Math.floor(r() * 50)) });
    else if (roll < 0.9) step({ type: "allocate", account: pick(names), market: m.id, amount: r() < 0.5 ? "all" : String(1 + Math.floor(r() * 50)) });
    else if (roll < 0.95) {
      // the exchange's book mid: near the mark, or gone (a side empty)
      const mid = m.id === "BIN" ? Math.min(1, Math.max(0, mark + (r() - 0.5) * 0.04)) : mark * (0.97 + r() * 0.06);
      step({ type: "book", market: m.id, mid: r() < 0.2 ? null : Math.max(mid, 1e-9).toFixed(9) });
    } else step({ type: "advance", seconds: 1 + Math.floor(r() * 900) });
  }
  step({ type: "advance", seconds: 25_000 });
  for (const m of priced) {
    const mk = s.markets[m.id]!.mark;
    const mark = mk === null ? 1 : Number(mk) / 1e9;
    step({ type: "resolve", market: m.id, price: m.id === "BIN" ? (r() < 0.5 ? "0" : "1") : m.move(mark) });
    step({ type: "book", market: m.id, mid: null }); // refused: resolved
    for (const n of names) step({ type: "release", account: n, market: m.id, amount: "all" });
  }
  for (const n of names) {
    step({ type: "spotSell", account: n, market: "ATTN", tokens: "all" });
    step({ type: "spotSell", account: n, market: "COIN", tokens: "all" });
    step({ type: "withdraw", account: n, amount: "all" });
  }
  return events;
}
