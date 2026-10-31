// Mark price chart on a 2D canvas: an animated line and area, a crosshair, the viewer's entry and liquidation
// lines, and markers for the risk events that carry a price (who paid, on hover).

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { num, price as fmtPrice } from "../format";
import { useCandles, useFeed } from "../queries";
import { type Range, usePrefs } from "../store";
import type { Candle, MarketView, PositionView, RiskEvent } from "../types";
import { ChartScene } from "../uwu/art";
import { useUwu } from "../uwu/store";
import { ChartMascot } from "../uwu/Uwu";
import { type Incident, IncidentCard, incidents } from "./WhoPaid";

const RANGES: Record<Range, number> = {
  "5m": 5 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};
const MARKER_KINDS = new Set(["liquidation", "bankrupt", "haircut", "adl", "open", "ipo"]);
const PAD = { top: 18, right: 72, bottom: 24, left: 8 };
const HIT = 12;

interface Pt {
  t: number;
  p: number;
}

interface Marker {
  incident: Incident;
  x: number;
  y: number;
  kind: "adl" | "liq" | "open" | "ipo";
  approx: boolean;
}

interface Colors {
  up: string;
  down: string;
  warn: string;
  info: string;
  accent: string;
  text: string;
  muted: string;
  faint: string;
  line: string;
  panel: string;
  mono: string;
}

function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim();
  return {
    up: v("--up"),
    down: v("--down"),
    warn: v("--warn"),
    info: v("--info"),
    accent: v("--accent"),
    text: v("--text"),
    muted: v("--muted"),
    // A skin can give the chart its own grid and label colours (UwU draws over a sky); else the theme's.
    faint: v("--chart-faint") || v("--faint"),
    line: v("--chart-grid") || v("--line"),
    panel: v("--panel"),
    mono: v("--mono"),
  };
}

/** 1, 2 or 5 × a power of ten, giving about `n` steps over `span`. */
function niceStep(span: number, n: number): number {
  const raw = span / Math.max(1, n);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * pow;
}

/** Candle closes (at the end of each minute) where there are no live samples, live samples where there are. */
function buildSeries(
  candles: Candle[] | undefined,
  samples: Pt[],
  from: number,
  now: number,
): Pt[] {
  const s0 = samples.find((s) => s.t >= from);
  const cut = s0?.t ?? Infinity;
  const pts: Pt[] = [];
  const first = candles?.[0];
  if (first && first.t >= from - 60_000 && first.t < cut) pts.push({ t: first.t, p: first.o });
  for (const c of candles ?? []) {
    const t = Math.min(c.t + 60_000, now);
    if (t >= from - 60_000 && t < cut) pts.push({ t, p: c.c });
  }
  for (const s of samples) if (s.t >= cut) pts.push(s);
  return pts.toSorted((a, b) => a.t - b.t);
}

function priceAt(pts: Pt[], t: number): number | null {
  if (!pts.length || t < pts[0]!.t) return null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (t <= b.t) return b.t === a.t ? b.p : a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t);
  }
  return pts[pts.length - 1]!.p;
}

/** `#rrggbb` (or `#rgb`) at an alpha, for canvas fills. Anything else passes through unchanged. */
function alpha(color: string, a: number): string {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((x) => x + x).join("") : m[1]!;
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const markerKind = (i: Incident): Marker["kind"] =>
  i.other.some((e) => e.kind === "open")
    ? "open"
    : i.other.some((e) => e.kind === "ipo")
      ? "ipo"
      : i.bankrupt.length || i.haircuts.length || i.closes.length
        ? "adl"
        : "liq";

const hhmm = (t: number, secs = false) =>
  new Date(t).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    ...(secs && { second: "2-digit" }),
  });

export function Chart({ market, position }: { market: MarketView; position?: PositionView }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const range = usePrefs((s) => s.range);
  const setRange = usePrefs((s) => s.setRange);
  const uwu = useUwu((s) => s.on);
  // The colours depend on the theme and the skin; the frame loop re-reads them when this changes.
  const theme = `${usePrefs((s) => s.theme)}${uwu ? "/uwu" : ""}`;
  const candles = useCandles(market.id);
  const feed = useFeed();
  const samples = useRef<Pt[]>([]);
  const [hover, setHover] = useState<Hover | null>(null);

  const events = useMemo(
    () =>
      incidents(feed.filter((e: RiskEvent) => e.market === market.id && MARKER_KINDS.has(e.kind))),
    [feed, market.id],
  );

  // Live marks between candles, for the short ranges. (The chart is keyed by market, so these start empty.)
  useEffect(() => {
    const p = num(market.mark);
    if (!Number.isFinite(p)) return;
    const now = Date.now();
    const s = samples.current;
    if (s.length && now - s[s.length - 1]!.t < 250) s[s.length - 1] = { t: now, p };
    else s.push({ t: now, p });
    while (s.length && s[0]!.t < now - 15 * 60_000) s.shift();
  }, [market.mark]);

  // Everything the frame loop reads, refreshed after every render without restarting the loop.
  const latest = {
    candles,
    events,
    range,
    theme,
    decimals: market.priceDecimals,
    entry: num(position?.entry),
    liq: num(position?.liquidationPrice),
    mark: num(market.mark),
  };
  const input = useRef(latest);
  useLayoutEffect(() => {
    input.current = latest;
  });

  useEffect(() => {
    const el = canvas.current!;
    const box = wrap.current!;
    const ctx = el.getContext("2d")!;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let w = 0;
    let h = 0;
    let dpr = 1;
    const size = () => {
      const r = box.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      w = Math.max(1, Math.floor(r.width));
      h = Math.max(1, Math.floor(r.height));
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(box);

    const mouse = { x: -1, y: -1, in: false };
    let markers: Marker[] = [];
    let hovered: Marker | null = null;
    let span = RANGES[input.current.range];
    let head = NaN;
    let lo = NaN;
    let hi = NaN;
    let last = performance.now();
    let raf = 0;
    // The theme's colours, re-read when the theme changes.
    let colors = readColors();
    let colorsTheme = input.current.theme;

    const frame = (tf: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(100, tf - last);
      last = tf;
      const ease = (ms: number) => (reduce ? 1 : 1 - Math.exp(-dt / ms));
      const inp = input.current;
      if (inp.theme !== colorsTheme) {
        colors = readColors();
        colorsTheme = inp.theme;
      }
      const c = colors;
      const now = Date.now();
      const target = RANGES[inp.range];
      span = Math.exp(Math.log(span) + (Math.log(target) - Math.log(span)) * ease(140));
      const from = now - span;

      const pts = buildSeries(inp.candles, samples.current, from, now);
      const markTarget = Number.isFinite(inp.mark) ? inp.mark : pts[pts.length - 1]?.p;
      if (markTarget !== undefined) {
        head = Number.isFinite(head) ? head + (markTarget - head) * ease(180) : markTarget;
        pts.push({ t: now, p: head });
      }

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      ctx.font = `11px ${c.mono}`;
      // The price axis is as wide as its widest label (tiny creator coin prices run long).
      const R = Math.max(
        PAD.right,
        Math.ceil(ctx.measureText(fmtPrice(markTarget ?? 0, inp.decimals)).width) + 22,
      );
      const pw = w - PAD.left - R;
      const ph = h - PAD.top - PAD.bottom;
      if (pts.length < 2 || pw < 20 || ph < 20) {
        ctx.fillStyle = c.muted;
        ctx.textAlign = "center";
        ctx.fillText(inp.candles ? "Waiting for prices…" : "Loading…", w / 2, h / 2);
        markers = [];
        return;
      }

      // Y range: visible prices, the entry line and visible markers; eased so new extremes glide in.
      const vis = pts.filter((p) => p.t >= from - 60_000);
      let mn = Math.min(...vis.map((p) => p.p));
      let mx = Math.max(...vis.map((p) => p.p));
      for (const i of inp.events) {
        if (i.time < from || i.price === null) continue;
        mn = Math.min(mn, num(i.price));
        mx = Math.max(mx, num(i.price));
      }
      if (Number.isFinite(inp.entry)) {
        mn = Math.min(mn, inp.entry);
        mx = Math.max(mx, inp.entry);
      }
      const pad = Math.max((mx - mn) * 0.12, Math.abs(mx) * 0.002, 1e-12);
      mn -= pad;
      mx += pad;
      lo = Number.isFinite(lo) ? lo + (mn - lo) * ease(220) : mn;
      hi = Number.isFinite(hi) ? hi + (mx - hi) * ease(220) : mx;
      const X = (t: number) => PAD.left + ((t - from) / span) * pw;
      const Y = (p: number) => PAD.top + (1 - (p - lo) / (hi - lo)) * ph;
      const P = (y: number) => lo + (1 - (y - PAD.top) / ph) * (hi - lo);
      const fmt = (p: number) => fmtPrice(p, inp.decimals);

      // Grid and axes.
      ctx.lineWidth = 1;
      ctx.strokeStyle = c.line;
      ctx.fillStyle = c.faint;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const ps = niceStep(hi - lo, Math.max(2, Math.floor(ph / 56)));
      for (let p = Math.ceil(lo / ps) * ps; p <= hi; p += ps) {
        const y = Math.round(Y(p)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD.left, y);
        ctx.lineTo(PAD.left + pw, y);
        ctx.stroke();
        ctx.fillText(fmt(p), PAD.left + pw + 8, y);
      }
      const ts = span <= 6 * 60_000 ? 60_000 : span <= 2 * 3_600_000 ? 10 * 60_000 : 3 * 3_600_000;
      const tzOff = new Date().getTimezoneOffset() * 60_000;
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";
      for (let t = Math.ceil((from - tzOff) / ts) * ts + tzOff; t <= now; t += ts) {
        const x = Math.round(X(t)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, PAD.top);
        ctx.lineTo(x, PAD.top + ph);
        ctx.stroke();
        if (x > PAD.left + 20 && x < PAD.left + pw - 20) ctx.fillText(hhmm(t), x, h - 7);
      }

      // Line and area, coloured by the move over the window.
      const first = vis[0]!.p;
      const tone = head >= first ? c.up : c.down;
      ctx.save();
      ctx.beginPath();
      ctx.rect(PAD.left, 0, pw, h);
      ctx.clip();
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.p)) : ctx.moveTo(X(p.t), Y(p.p))));
      const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + ph);
      grad.addColorStop(0, alpha(tone, 0.28));
      grad.addColorStop(1, alpha(tone, 0));
      ctx.lineJoin = "round";
      ctx.lineWidth = 1.75;
      ctx.strokeStyle = tone;
      ctx.stroke();
      ctx.lineTo(X(now), PAD.top + ph);
      ctx.lineTo(X(pts[0]!.t), PAD.top + ph);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      // Horizontal lines: entry, liquidation, and the live mark. Off-scale lines pin to the edge with an arrow.
      const hline = (p: number, color: string, label: string, dashed: boolean) => {
        if (!Number.isFinite(p)) return;
        const off = p > hi ? "↑" : p < lo ? "↓" : "";
        const y = off ? (p > hi ? PAD.top + 8 : PAD.top + ph - 8) : Y(p);
        if (!off) {
          ctx.setLineDash(dashed ? [4, 4] : [2, 3]);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(PAD.left, Math.round(y) + 0.5);
          ctx.lineTo(PAD.left + pw, Math.round(y) + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const text = `${label ? `${label} ` : ""}${fmt(p)}${off}`;
        const tw = ctx.measureText(text).width + 10;
        const x0 = label ? PAD.left + pw - tw - 4 : PAD.left + pw + 2;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x0, y - 8, label ? tw : R - 4, 16, 3);
        ctx.fill();
        ctx.fillStyle = c.panel;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(text, x0 + 5, y + 0.5);
      };
      hline(inp.entry, c.info, "entry", true);
      hline(inp.liq, c.warn, "liq", true);
      hline(head, tone, "", false);

      // Pulsing head.
      const hx = X(now);
      const hy = Y(head);
      const pulse = reduce ? 0 : (Math.sin(tf / 320) + 1) / 2;
      ctx.fillStyle = alpha(tone, 0.18 + pulse * 0.2);
      ctx.beginPath();
      ctx.arc(hx, hy, 6 + pulse * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = tone;
      ctx.beginPath();
      ctx.arc(hx, hy, 3, 0, Math.PI * 2);
      ctx.fill();

      // Risk markers.
      markers = [];
      for (const i of inp.events) {
        if (i.time < from || i.time > now + 1000) continue;
        const exact = i.price !== null;
        const p = exact ? num(i.price) : priceAt(pts, i.time);
        if (p === null || !Number.isFinite(p)) continue;
        markers.push({ incident: i, x: X(i.time), y: Y(p), kind: markerKind(i), approx: !exact });
      }
      for (const m of markers) {
        const col =
          m.kind === "adl"
            ? c.down
            : m.kind === "liq"
              ? c.warn
              : m.kind === "open"
                ? c.accent
                : c.info;
        const on = hovered?.incident.key === m.incident.key;
        if (m.kind === "open" || m.kind === "ipo") {
          ctx.setLineDash([3, 3]);
          ctx.strokeStyle = col;
          ctx.beginPath();
          ctx.moveTo(Math.round(m.x) + 0.5, PAD.top);
          ctx.lineTo(Math.round(m.x) + 0.5, PAD.top + ph);
          ctx.stroke();
          ctx.setLineDash([]);
        }
        const label =
          m.kind === "adl"
            ? m.incident.bankrupt.length
              ? "ADL"
              : "HC"
            : m.kind === "liq"
              ? "L"
              : m.kind === "open"
                ? "OPEN"
                : "IPO";
        ctx.font = `600 10px ${c.mono}`;
        const tw = ctx.measureText(label).width + 8;
        const above = m.y - PAD.top > 30;
        const ly = above ? m.y - 20 : m.y + 12;
        ctx.strokeStyle = col;
        ctx.beginPath();
        ctx.moveTo(m.x, m.y);
        ctx.lineTo(m.x, above ? ly + 8 : ly);
        ctx.stroke();
        ctx.fillStyle = col;
        ctx.beginPath();
        ctx.roundRect(m.x - tw / 2, ly - 8, tw, 16, 8);
        ctx.fill();
        ctx.fillStyle = c.panel;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, m.x, ly + 0.5);
        ctx.beginPath();
        ctx.arc(m.x, m.y, on ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = c.panel;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.setLineDash(m.approx ? [2, 2] : []);
        ctx.strokeStyle = col;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.lineWidth = 1;
        ctx.font = `11px ${c.mono}`;
      }

      // Crosshair.
      if (
        mouse.in &&
        mouse.x >= PAD.left &&
        mouse.x <= PAD.left + pw &&
        mouse.y >= PAD.top &&
        mouse.y <= PAD.top + ph
      ) {
        ctx.strokeStyle = c.muted;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(mouse.x) + 0.5, PAD.top);
        ctx.lineTo(Math.round(mouse.x) + 0.5, PAD.top + ph);
        ctx.moveTo(PAD.left, Math.round(mouse.y) + 0.5);
        ctx.lineTo(PAD.left + pw, Math.round(mouse.y) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);
        const t = from + ((mouse.x - PAD.left) / pw) * span;
        const at = priceAt(pts, t);
        const py = fmt(P(mouse.y));
        ctx.fillStyle = c.text;
        ctx.beginPath();
        ctx.roundRect(PAD.left + pw + 2, mouse.y - 8, R - 4, 16, 3);
        ctx.fill();
        ctx.fillStyle = c.panel;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(py, PAD.left + pw + 7, mouse.y + 0.5);
        const tl = `${hhmm(t, span <= 2 * 3_600_000)}${at !== null ? `  ${fmt(at)}` : ""}`;
        const tw = ctx.measureText(tl).width + 12;
        const tx = Math.min(Math.max(mouse.x - tw / 2, PAD.left), PAD.left + pw - tw);
        ctx.fillStyle = c.text;
        ctx.beginPath();
        ctx.roundRect(tx, h - PAD.bottom + 4, tw, 16, 3);
        ctx.fill();
        ctx.fillStyle = c.panel;
        ctx.fillText(tl, tx + 6, h - PAD.bottom + 12.5);
        if (at !== null) {
          ctx.fillStyle = c.text;
          ctx.beginPath();
          ctx.arc(mouse.x, Y(at), 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    raf = requestAnimationFrame(frame);

    const pick = (x: number, y: number) => {
      let best: Marker | null = null;
      let bd = HIT;
      for (const m of markers) {
        const d = Math.hypot(m.x - x, m.y - y);
        const dl = Math.hypot(m.x - x, m.y - 20 - y); // the label pill above the dot
        const dd = Math.min(d, dl);
        if (dd < bd) {
          bd = dd;
          best = m;
        }
      }
      return best;
    };
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      mouse.x = e.clientX - r.left;
      mouse.y = e.clientY - r.top;
      mouse.in = true;
      const m = pick(mouse.x, mouse.y);
      if (m?.incident.key !== hovered?.incident.key) {
        hovered = m;
        setHover(m ? { marker: m, left: m.x, top: m.y, boxWidth: w, boxHeight: h } : null);
      }
      el.style.cursor = m ? "pointer" : "crosshair";
    };
    const leave = () => {
      mouse.in = false;
      hovered = null;
      setHover(null);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerdown", move);
    el.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerdown", move);
      el.removeEventListener("pointerleave", leave);
    };
  }, []);

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        <h3>Mark price</h3>
        <span className="faint small nowrap">{market.source.label}</span>
        <span className="spacer" />
        <div className="tabs">
          {(Object.keys(RANGES) as Range[]).map((r) => (
            <button
              type="button"
              key={r}
              className={r === range ? "on" : ""}
              onClick={() => setRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      </div>
      <div className="chart" ref={wrap}>
        {uwu && <ChartScene />}
        <canvas ref={canvas} aria-label={`${market.id} mark price chart`} role="img" />
        {uwu && <ChartMascot />}
        {hover && <HoverCard hover={hover} market={market} />}
      </div>
    </div>
  );
}

/** The marker under the pointer, where it is, and the chart's size to keep the card inside it. */
type Hover = { marker: Marker; left: number; top: number; boxWidth: number; boxHeight: number };

function HoverCard({ hover, market }: { hover: Hover; market: MarketView }) {
  const W = 280;
  const bw = hover.boxWidth;
  const bh = hover.boxHeight;
  const left = hover.left + 14 + W > bw ? Math.max(4, hover.left - 14 - W) : hover.left + 14;
  const top = Math.min(Math.max(4, hover.top - 40), Math.max(4, bh - 200));
  const i = hover.marker.incident;
  return (
    <div className="chart-hover" style={{ left, top, width: W }}>
      <div className="faint small">
        {new Date(i.time).toLocaleString("en-US", {
          hour12: false,
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })}
        {hover.marker.approx && " · price approximate (event has none)"}
      </div>
      <IncidentCard incident={i} market={market} />
    </div>
  );
}
