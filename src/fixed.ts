// Fixed-point helpers. Money and prices are micro-USD bigints (6 decimals, like USDC).

export const ONE = 1_000_000n;

export function parseMicro(s: string | number): bigint {
  const str = String(s).trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(str);
  if (!m) throw new Error(`invalid decimal "${str}" (max 6 decimals)`);
  const [, neg, int, frac = ""] = m;
  const v = BigInt(int!) * ONE + BigInt(frac.padEnd(6, "0"));
  return neg ? -v : v;
}

export function fmt(v: bigint, decimals = 2): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const int = a / ONE;
  const frac = (a % ONE).toString().padStart(6, "0").slice(0, decimals);
  return `${neg ? "-" : ""}${int}${decimals > 0 ? "." + frac : ""}`;
}

export const fmtUsd = (v: bigint) => fmt(v, 6).replace(/(\.\d{2}\d*?)0+$/, "$1");
export const fmtPrice = (v: bigint) => fmt(v, 4);

export const abs = (v: bigint) => (v < 0n ? -v : v);
export const sign = (v: bigint) => (v > 0n ? 1n : v < 0n ? -1n : 0n);
export const min = (a: bigint, b: bigint) => (a < b ? a : b);
export const max = (a: bigint, b: bigint) => (a > b ? a : b);
export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b; // a, b >= 0
