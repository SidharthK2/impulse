// Conversions between what users see (coins, USD per coin) and what the engine trades (integer lots, nano-USD per
// lot). A market's lot is 10^-szDecimals coins, Hyperliquid style: BTC trades in 0.00001 BTC lots, a binary
// outcome or an attention token in whole units. Money is nano-USD everywhere, so lots × lot price stays exact.

import { ONE, fmt, parseFixed } from "../../engine/fixed.js";

export { ONE, fmt, parseFixed };

export const pow10 = (n: number) => 10n ** BigInt(n);

/** Parse a non-negative decimal with at most `decimals` places into an integer scaled by 10^decimals. */
export function parseScaled(s: string | number, decimals: number): bigint {
  const str = String(s).trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) throw new Error(`invalid number "${str}"`);
  const [, int, frac = ""] = m;
  const trimmed = frac.replace(/0+$/, "");
  if (trimmed.length > decimals) throw new Error(`"${str}" has more than ${decimals} decimals`);
  return BigInt(int!) * pow10(decimals) + BigInt(trimmed.padEnd(decimals, "0") || "0");
}

/** Exact decimal string of an integer scaled by 10^decimals, trailing zeros trimmed. */
export function fmtScaled(v: bigint, decimals: number): string {
  if (decimals === 0) return v.toString();
  const neg = v < 0n;
  const a = neg ? -v : v;
  const d = pow10(decimals);
  const frac = (a % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / d}${frac ? "." + frac : ""}`;
}

/** Engine decimal string for a nano value (what `parseFixed` reads back). */
export const dec = (v: bigint) => fmt(v, 0);

export interface Lots {
  szDecimals: number;
}

export const lotsFromCoins = (m: Lots, coins: string | number) => parseScaled(coins, m.szDecimals);
export const coinsFromLots = (m: Lots, lots: bigint) => fmtScaled(lots, m.szDecimals);
/** Coin price (nano-USD per coin) → lot price (nano-USD per lot), rounded down to a whole nano. */
export const lotPrice = (m: Lots, coinNano: bigint) => coinNano / pow10(m.szDecimals);
export const coinPrice = (m: Lots, lotNano: bigint) => lotNano * pow10(m.szDecimals);

/**
 * Default tick: five significant figures of the starting price (Hyperliquid's rule), never finer than one nano
 * per lot so every tick converts to an exact lot price.
 */
export function autoTick(coinNano: bigint, szDecimals: number): bigint {
  const digits = coinNano > 0n ? coinNano.toString().length : 1;
  const tick = pow10(Math.max(0, digits - 5));
  return tick > pow10(szDecimals) ? tick : pow10(szDecimals);
}

/** How many decimals a price on this tick needs. */
export function tickDecimals(tick: bigint): number {
  let d = 9;
  let t = tick;
  while (d > 0 && t % 10n === 0n) {
    t /= 10n;
    d -= 1;
  }
  return d;
}

/** Decimal string → nano, accepting floats from JSON feeds (rounded down to 9 decimals). */
export function nanoFromFeed(v: string | number): bigint {
  const s = typeof v === "number" ? v.toFixed(9) : v.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`bad feed price "${s}"`);
  return BigInt(m[1]!) * ONE + BigInt((m[2] ?? "").slice(0, 9).padEnd(9, "0") || "0");
}

export const usd = (v: bigint) => fmt(v, 2);
