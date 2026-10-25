// House bots so a lone user has someone to trade with.
//  - maker: quotes a ladder around the oracle on every market, skewed against its inventory. It is an ordinary
//    account with no special treatment, so ADL haircuts it like anyone else.
//  - noise traders: open and close random leveraged positions against the book, so markets have volume (and
//    graduate) and gaps have somebody to liquidate.

import { leverageNow } from "../../src/engine.js";
import { abs } from "../../src/fixed.js";
import type { Exchange, MarketMeta } from "./exchange.js";
import { coinsFromLots, dec, usd } from "./units.js";

export const MM = "maker";
const MM_DEPOSIT = "2000000";
const TRADERS: { id: string; deposit: string; aggression: number }[] = [
  { id: "ape", deposit: "25000", aggression: 0.9 },
  { id: "degen", deposit: "10000", aggression: 1 },
  { id: "whale", deposit: "150000", aggression: 0.4 },
  { id: "scalper", deposit: "20000", aggression: 0.6 },
];

interface Ladder {
  offsets: number[]; // perps and attention: fraction of price; binaries: absolute price
  usd: number[]; // notional per level
  maxInventoryUsd: number;
}

const LADDERS: Record<MarketMeta["kind"], Ladder> = {
  perp: { offsets: [0.0005, 0.0012, 0.0025, 0.005, 0.01, 0.02], usd: [1500, 2500, 4000, 7000, 12000, 20000], maxInventoryUsd: 250_000 },
  binary: { offsets: [0.005, 0.01, 0.02, 0.035, 0.055, 0.08], usd: [300, 500, 900, 1500, 2500, 4000], maxInventoryUsd: 40_000 },
  attention: { offsets: [0.004, 0.01, 0.02, 0.04, 0.07, 0.12], usd: [60, 120, 250, 500, 900, 1500], maxInventoryUsd: 6_000 },
};

export class Bots {
  enabled = true;
  private timers: NodeJS.Timeout[] = [];
  private cursor = 0;

  constructor(
    private x: Exchange,
    private log: (s: string) => void,
  ) {}

  ensureAccounts() {
    if (!this.x.accounts[MM]) {
      this.x.createAccount(MM, { bot: true });
      this.x.deposit(MM, MM_DEPOSIT);
    }
    for (const t of TRADERS) {
      if (this.x.accounts[t.id]) continue;
      this.x.createAccount(t.id, { bot: true });
      this.x.deposit(t.id, t.deposit);
    }
  }

  start() {
    const guard = (fn: () => void) => () => {
      if (!this.enabled) return;
      try {
        fn();
      } catch (err) {
        this.log(`bots: ${(err as Error).stack ?? err}`);
      }
    };
    // Requote a few markets per second rather than all at once.
    this.timers.push(setInterval(guard(() => this.requoteSome(3)), 1000));
    this.timers.push(setInterval(guard(() => this.noise()), 2500));
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private requoteSome(n: number) {
    const ids = Object.keys(this.x.markets).sort();
    for (let i = 0; i < Math.min(n, ids.length); i++) {
      this.quote(ids[this.cursor++ % ids.length]!);
    }
  }

  /** Replace the market maker's ladder in one market. */
  quote(id: string) {
    const meta = this.x.markets[id]!;
    const m = this.x.state.markets[id]!;
    this.x.cancelAll(MM, id);
    if (m.status !== "open" || m.mark === null) return;
    const wallet = this.x.state.accounts[MM]?.wallet ?? 0n;
    if (wallet < 500_000n * 10n ** 9n) this.x.deposit(MM, "1000000");

    const ladder = LADDERS[meta.kind];
    const scale = 10 ** meta.szDecimals;
    const mark = (Number(m.mark) * scale) / 1e9; // coin price
    const tick = Number(meta.tick) / 1e9;
    const pos = m.positions[MM]?.size ?? 0n;
    const invUsd = (Number(pos) * Number(m.mark)) / 1e9;
    const skew = Math.max(-1, Math.min(1, invUsd / ladder.maxInventoryUsd));
    // Lean against inventory: long → lower both sides, so asks fill first.
    const center = meta.kind === "binary" ? mark - skew * 0.01 : mark * (1 - skew * ladder.offsets[1]!);
    const lev = Number(leverageNow(m).initial);
    const hi = meta.kind === "binary" ? 1 - tick : Infinity;

    ladder.offsets.forEach((off, i) => {
      const d = meta.kind === "binary" ? off : center * off;
      const notional = ladder.usd[i]!;
      if (skew < 0.98) this.place(meta, "buy", Math.max(tick, Math.floor((center - d) / tick) * tick), notional, lev);
      if (skew > -0.98) this.place(meta, "sell", Math.min(hi, Math.ceil((center + d) / tick) * tick), notional, lev);
    });
  }

  private place(meta: MarketMeta, side: "buy" | "sell", price: number, notional: number, leverage: number) {
    if (!(price > 0) || !Number.isFinite(price)) return;
    const priceNano = BigInt(Math.round(price * 1e9 / Number(meta.tick))) * meta.tick;
    if (priceNano <= 0n) return;
    const lots = BigInt(Math.max(1, Math.floor(((notional / price) * 10 ** meta.szDecimals))));
    try {
      this.x.placeOrder(MM, { market: meta.id, side, type: "limit", tif: "alo", price: dec(priceNano), size: coinsFromLots(meta, lots), leverage });
    } catch {
      // crossed a user's resting order, or margin: skip this level
    }
  }

  /** One random action by one noise trader. */
  noise() {
    const t = TRADERS[Math.floor(Math.random() * TRADERS.length)]!;
    if (Math.random() > t.aggression) return;
    const wallet = this.x.state.accounts[t.id]?.wallet ?? 0n;
    const open = Object.values(this.x.state.markets).filter((m) => m.status === "open" && (m.positions[t.id]?.size ?? 0n) !== 0n);

    if (open.length > 0 && (Math.random() < 0.35 || open.length >= 4)) {
      const m = open[Math.floor(Math.random() * open.length)]!;
      const meta = this.x.markets[m.id]!;
      const size = m.positions[t.id]!.size;
      try {
        this.x.placeOrder(t.id, { market: m.id, side: size > 0n ? "sell" : "buy", type: "market", size: coinsFromLots(meta, abs(size)), reduceOnly: true, slippage: 0.03 });
      } catch {
        // no liquidity right now
      }
      return;
    }

    if (wallet < 50n * 10n ** 9n) {
      if (open.length === 0) {
        const refill = TRADERS.find((x) => x.id === t.id)!.deposit;
        this.x.deposit(t.id, refill);
        this.log(`${t.id} is broke; refilled $${refill}`);
      }
      return;
    }

    const candidates = Object.values(this.x.markets).filter((meta) => {
      const m = this.x.state.markets[meta.id]!;
      return m.status === "open" && m.mark !== null && this.x.books[meta.id]!.bids.length > 0 && this.x.books[meta.id]!.asks.length > 0;
    });
    if (candidates.length === 0) return;
    const meta = candidates[Math.floor(Math.random() * candidates.length)]!;
    const m = this.x.state.markets[meta.id]!;
    const maxLev = Number(leverageNow(m).initial);
    const lev = 1 + Math.floor(Math.random() ** 0.7 * maxLev);
    const budget = (Number(wallet) / 1e9) * (0.03 + Math.random() * 0.15);
    const price = (Number(m.mark) * 10 ** meta.szDecimals) / 1e9;
    const lots = BigInt(Math.floor(((budget * Math.min(lev, maxLev)) / price) * 10 ** meta.szDecimals));
    if (lots <= 0n) return;
    // Mild momentum: follow the last few minutes of the chart more often than not.
    const cs = this.x.candles[meta.id] ?? [];
    const recent = cs.slice(-5);
    const drift = recent.length > 1 ? Number(recent[recent.length - 1]!.c - recent[0]!.o) : 0;
    const side = Math.random() < (drift > 0 ? 0.6 : drift < 0 ? 0.4 : 0.5) ? "buy" : "sell";
    try {
      this.x.placeOrder(t.id, { market: meta.id, side, type: "market", size: coinsFromLots(meta, lots), leverage: Math.min(lev, maxLev), slippage: 0.03 });
    } catch {
      // insufficient balance for this size, or no liquidity
    }
  }

  summary() {
    return [MM, ...TRADERS.map((t) => t.id)].map((id) => ({ id, wallet: usd(this.x.state.accounts[id]?.wallet ?? 0n) }));
  }
}
