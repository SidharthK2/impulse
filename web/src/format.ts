const usdFmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });

export const num = (s: string | number | null | undefined) => (s === null || s === undefined || s === "" ? NaN : Number(s));

export function usd(s: string | number | null | undefined, opts: { sign?: boolean; compact?: boolean } = {}): string {
  const v = num(s);
  if (!Number.isFinite(v)) return "—";
  const body = opts.compact && Math.abs(v) >= 10_000 ? compactFmt.format(Math.abs(v)) : usdFmt.format(Math.abs(v));
  const sign = v < 0 ? "−" : opts.sign && v > 0 ? "+" : "";
  return `${sign}$${body}`;
}

/** Price with the market's tick precision; tiny prices keep their significant digits. */
export function price(s: string | number | null | undefined, decimals: number): string {
  const v = num(s);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function size(s: string | number | null | undefined, decimals: number): string {
  const v = num(s);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-US", { maximumFractionDigits: decimals });
}

export function pct(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(digits)}%`;
}

export function compact(s: string | number | null | undefined): string {
  const v = num(s);
  return Number.isFinite(v) ? compactFmt.format(v) : "—";
}

export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export const clock = (t: number) => new Date(t).toLocaleTimeString("en-US", { hour12: false });

export function countdown(ms: number): string {
  if (ms <= 0) return "now";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "down" : "");

/** Trim a decimal to at most `d` places without float noise, for prefilling inputs. */
export function toInput(v: number, d: number): string {
  if (!Number.isFinite(v)) return "";
  const s = v.toFixed(Math.max(0, d));
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
