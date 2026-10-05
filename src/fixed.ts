// Fixed-point helpers. Money and prices are nano-USD bigints (9 decimals, the unit Mirror's engine uses),
// so a $0.000005 memecoin is 5_000n and size × price stays exact.

export const DECIMALS = 9;
export const ONE = 10n ** BigInt(DECIMALS);

export function parseFixed(s: string | number): bigint {
  const str = String(s).trim();
  const m = new RegExp(`^(-)?(\\d+)(?:\\.(\\d{1,${DECIMALS}}))?$`).exec(str);
  if (!m) throw new Error(`invalid decimal "${str}" (max ${DECIMALS} decimals)`);
  const [, neg, int, frac = ""] = m;
  const v = BigInt(int!) * ONE + BigInt(frac.padEnd(DECIMALS, "0"));
  return neg ? -v : v;
}

/** Exact decimal string, trailing zeros trimmed down to `minDecimals`. */
export function fmt(v: bigint, minDecimals = 2): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  let frac = (a % ONE).toString().padStart(DECIMALS, "0");
  while (frac.length > minDecimals && frac.endsWith("0")) frac = frac.slice(0, -1);
  return `${neg ? "-" : ""}${a / ONE}${frac ? "." + frac : ""}`;
}

export const fmtUsd = (v: bigint) => fmt(v, 2);
export const fmtPrice = (v: bigint) => fmt(v, 4);

export const abs = (v: bigint) => (v < 0n ? -v : v);
export const sign = (v: bigint) => (v > 0n ? 1n : v < 0n ? -1n : 0n);
export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);
export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b; // a, b >= 0
