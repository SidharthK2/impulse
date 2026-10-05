// Pump attack on a curve-priced MicroPerp (Mirror's attention-market design).
//
// The attacker holds a perp long against leveraged shorts, buys spot on the curve to push the price the perp
// oracle reads, lets risk processing liquidate/ADL the shorts, then sells the spot back. On a pure xy=k curve a
// buy-then-sell round trip returns the same USDC minus fees, so the only frictions are fees, the oracle's
// smoothing window, and anyone who sells into the pump while the attacker waits. We model those defenders as
// arbitrageurs who sell spot until the price has retraced a fraction of the pump, then buy back after the dump.
//
// Usage: tsx src/attack.ts   (prints the parameter sweep)

import { type Event, type State, apply, equity, initialState, spotPrice } from "./engine.js";
import { ceilDiv, fmt, fmtPrice, parseFixed } from "./fixed.js";

export interface AttackParams {
  pump: number; // USDC the attacker spends on spot
  window: number; // oracle TWAP window, seconds (0 = instant spot)
  feeBps: number; // spot fee
  retrace: number; // fraction of the pump that defenders/arbitrageurs sell back while the attacker waits
  organic?: number; // USDC of organic spot demand before the attack (sets the starting price)
  victimCollateral?: number; // per short, 3 shorts at ~2.85x
}

export interface AttackResult {
  params: AttackParams;
  startPrice: bigint;
  peakMark: bigint;
  victimCollateral: bigint;
  victimLoss: bigint; // collateral the shorts lost
  attackerPnl: bigint; // attacker's total change in wealth
  attackerFees: bigint;
  liquidations: number;
  bankruptcies: number;
}

const usd = (n: number) => n.toFixed(6);

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  while (x * x > n) x--;
  while ((x + 1n) * (x + 1n) <= n) x++;
  return x;
}

export function runAttack(params: AttackParams): AttackResult {
  const { pump, window, feeBps, retrace } = params;
  const organic = params.organic ?? 20_000;
  const C = params.victimCollateral ?? 1_000;
  const M = "ATTN";
  const holders = ["h1", "h2", "h3", "h4"];
  const victims = ["v1", "v2", "v3"];
  const sold: Record<string, bigint> = {};

  let s: State = initialState();
  let peakMark = 0n;
  let attackerFees = 0n;
  let liquidations = 0;
  let bankruptcies = 0;
  const step = (e: Event) => {
    const r = apply(s, e);
    if (!r.ok) throw new Error(`attack setup step rejected: ${JSON.stringify(e)}: ${r.reason}`);
    for (const f of r.effects) {
      if (f.kind === "spot" && f.account === "attacker") attackerFees += f.fee;
      if (f.kind === "liquidation") liquidations++;
      if (f.kind === "bankrupt") bankruptcies++;
    }
    s = r.state;
    const mark = s.markets[M]!.mark!;
    if (mark > peakMark) peakMark = mark;
  };

  // 1. Market and organic demand, then let the oracle settle on the organic price.
  step({ type: "market", id: M, preset: "attention", feeBps, oracleWindow: window });
  for (const h of holders) {
    step({ type: "deposit", account: h, amount: usd(organic / holders.length) });
    step({ type: "spotBuy", account: h, market: M, amount: "all" });
  }
  step({ type: "advance", seconds: window + 1 });
  const startPrice = s.markets[M]!.mark!;
  peakMark = startPrice;

  // 2. Shorts open ~2.85x against the attacker's 3x long at the oracle price.
  const priceStr = fmt(startPrice, 9);
  const sizeEach = BigInt(Math.floor((C * 3 * 0.95) / (Number(startPrice) / 1e9)));
  for (const v of victims) {
    step({ type: "deposit", account: v, amount: usd(C) });
    step({ type: "allocate", account: v, market: M, amount: "all" });
  }
  const attackerPerp = C * victims.length * 0.95 + 1; // ~3x on total notional
  step({ type: "deposit", account: "attacker", amount: usd(attackerPerp + pump) });
  step({ type: "allocate", account: "attacker", market: M, amount: usd(attackerPerp) });
  for (const v of victims) step({ type: "trade", market: M, buyer: "attacker", seller: v, size: sizeEach.toString(), price: priceStr });
  const attackerStart = s.accounts.attacker!.deposited;

  // 3. Pump. With an instant oracle, risk runs inside this transition.
  step({ type: "spotBuy", account: "attacker", market: M, amount: usd(pump) });

  // 4. Hold while the TWAP catches up; defenders sell into the pump. With an instant oracle the attacker
  //    unwinds in the very next transition, before anyone can react.
  if (window > 0) {
    const steps = 10;
    // On xy=k, price = k / y², so the token reserve at a target price is sqrt(k / target).
    const c = s.markets[M]!.curve!;
    const pumped = spotPrice(c);
    const target = pumped - ((pumped - startPrice) * BigInt(Math.round(retrace * 1000))) / 1000n;
    let toSell = retrace > 0 ? isqrt((c.x * c.y) / target) - c.y : 0n;
    for (const h of holders) {
      const sell = toSell < (s.accounts[h]!.spot[M] ?? 0n) ? toSell : s.accounts[h]!.spot[M]!;
      if (sell > 0n) step({ type: "spotSell", account: h, market: M, tokens: sell.toString() });
      sold[h] = sell;
      toSell -= sell;
    }
    for (let i = 0; i < steps; i++) step({ type: "advance", seconds: Math.ceil(window / steps) });
  }
  step({ type: "spotSell", account: "attacker", market: M, tokens: "all" });
  // Arbitrageurs who sold into the pump buy the same tokens back after the dump, pocketing the spread.
  for (const h of holders) {
    if (!sold[h]) continue;
    const c = s.markets[M]!.curve!;
    const net = ceilDiv(c.x * c.y, c.y - sold[h]!) - c.x;
    const gross = ceilDiv(net * 10_000n, 10_000n - c.feeBps);
    step({ type: "spotBuy", account: h, market: M, amount: fmt(gross, 9) });
  }

  // 5. Let the oracle settle back, then mark everyone.
  step({ type: "advance", seconds: window + 1 });
  const m = s.markets[M]!;
  const perpEquity = (id: string) => (m.positions[id] ? equity(m.positions[id]!, m.mark) : 0n);
  const victimCollateral = parseFixed(usd(C)) * BigInt(victims.length);
  const victimLoss = victimCollateral - victims.reduce((sum, v) => sum + perpEquity(v), 0n);
  const attackerPnl = s.accounts.attacker!.wallet + perpEquity("attacker") - attackerStart;
  return { params, startPrice, peakMark, victimCollateral, victimLoss, attackerPnl, attackerFees, liquidations, bankruptcies };
}

const money = (v: bigint) => `${v < 0n ? "-" : ""}$${(Math.abs(Number(v)) / 1e9).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function main() {
  const rows: AttackResult[] = [];
  for (const window of [0, 600, 3600])
    for (const feeBps of [30, 100])
      for (const retrace of window === 0 ? [0] : [0, 0.5, 0.9])
        for (const pump of [2_000, 5_000, 20_000]) rows.push(runAttack({ pump, window, feeBps, retrace }));

  console.log("Pump attack on a curve-priced MicroPerp: organic demand $20k (start price ~$0.000125),");
  console.log("3 shorts × $1,000 at ~2.85x vs the attacker's long. Victims' total collateral: $3,000.\n");
  console.log("oracle    fee  retrace     pump    peak mark   liq/bk  victims lost  attacker fees  attacker PnL");
  for (const r of rows) {
    const p = r.params;
    console.log(
      [
        (p.window === 0 ? "instant" : `TWAP ${p.window / 60}m`).padEnd(8),
        `${(p.feeBps / 100).toFixed(1)}%`.padStart(4),
        `${Math.round(p.retrace * 100)}%`.padStart(8),
        `$${p.pump.toLocaleString()}`.padStart(8),
        fmtPrice(r.peakMark).padStart(11),
        `${r.liquidations}/${r.bankruptcies}`.padStart(7),
        money(r.victimLoss).padStart(13),
        money(r.attackerFees).padStart(14),
        money(r.attackerPnl).padStart(13),
      ].join("  "),
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

