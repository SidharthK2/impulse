// The home page's backdrop: a field of monospace characters with pulse waves (the logo's heartbeat line) drifting
// across it. Drawn on a canvas one text row at a time, about 15 frames a second, only while it's on screen; a
// single still frame for people who prefer reduced motion.

import { useEffect, useRef } from "react";
import { usePrefs } from "../store";

// One period of the logo's line, as (x, y) with x in [0, 1] and y in [-1, 1] (negative is up).
const SHAPE: [number, number][] = [
  [0, 0],
  [0.3, 0],
  [0.4, -0.95],
  [0.56, 1],
  [0.66, -0.35],
  [0.74, 0],
  [1, 0],
];

function shape(u: number): number {
  for (let i = 1; i < SHAPE.length; i++) {
    const [x1, y1] = SHAPE[i]!;
    const [x0, y0] = SHAPE[i - 1]!;
    if (u <= x1) return y0 + ((y1 - y0) * (u - x0)) / (x1 - x0 || 1);
  }
  return 0;
}

/** Cheap deterministic hash in [0, 1) for the background grain. */
const grain = (c: number, r: number, k: number) => {
  let h = (c * 374761393 + r * 668265263 + k * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

// Waves: vertical position (fraction of height), amplitude (rows), period (columns), speed (columns/s), phase.
const WAVES = [
  { y: 0.3, amp: 5, period: 64, speed: 9, phase: 0 },
  { y: 0.58, amp: 7, period: 92, speed: -6, phase: 37 },
  { y: 0.84, amp: 4, period: 48, speed: 12, phase: 11 },
];

export function PulseField({ className = "" }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const theme = usePrefs((s) => s.theme);

  useEffect(() => {
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const css = getComputedStyle(document.documentElement);
    const ink = { grain: css.getPropertyValue("--line").trim(), dim: css.getPropertyValue("--line-2").trim(), mid: css.getPropertyValue("--faint").trim(), hot: css.getPropertyValue("--accent").trim() };
    const font = `12px ${css.getPropertyValue("--mono").trim() || "monospace"}`;
    let cw = 7.2;
    const ch = 14;
    let cols = 0;
    let rows = 0;
    let w = 0;
    let h = 0;

    const size = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      w = r.width;
      h = r.height;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.font = font;
      cw = ctx.measureText("M").width || 7.2;
      cols = Math.ceil(w / cw) + 1;
      rows = Math.ceil(h / ch) + 1;
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.font = font;
      ctx.textBaseline = "top";
      // Per row: background grain, the flat stretches, the spike bands, and their hottest cells, each one string.
      const blank = () => Array.from({ length: rows }, () => new Array<string>(cols).fill(" "));
      const bg = blank();
      const flat = blank();
      const body = blank();
      const hot = blank();
      const k = Math.floor(t * 0.6);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grain(c, r, k) < 0.05) bg[r]![c] = "·";
      for (const wv of WAVES) {
        const base = wv.y * rows;
        for (let c = 0; c < cols; c++) {
          const u = ((((c + wv.phase - wv.speed * t) / wv.period) % 1) + 1) % 1;
          const y = base + shape(u) * wv.amp;
          // Flat stretches are a thin faint dash; the spike (where the line is moving) is a dense glyph band.
          const steep = Math.abs(shape(Math.min(1, u + 0.01)) - shape(Math.max(0, u - 0.01))) > 0.02 || Math.abs(shape(u)) > 0.05;
          if (!steep) {
            const r = Math.round(y);
            if (r >= 0 && r < rows && (c & 1) === 0) flat[r]![c] = "-";
            continue;
          }
          const r0 = Math.floor(y - 2);
          for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r0 + 4); r++) {
            const d = Math.abs(r - y);
            if (d < 0.6) hot[r]![c] = "#";
            else if (d < 1.2) body[r]![c] = "x";
            else if (d < 2) body[r]![c] = body[r]![c] === " " ? "+" : body[r]![c]!;
          }
        }
      }
      const line = (rowsOf: string[][], color: string, alpha: number) => {
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha;
        for (let r = 0; r < rows; r++) ctx.fillText(rowsOf[r]!.join(""), 0, r * ch);
      };
      line(bg, ink.grain, 1);
      line(flat, ink.dim, 1);
      line(body, ink.mid, 0.55);
      line(hot, ink.hot, 0.45);
      ctx.globalAlpha = 1;
    };

    size();
    const ro = new ResizeObserver(() => {
      size();
      draw(performance.now() / 1000);
    });
    ro.observe(el);

    let raf = 0;
    let last = 0;
    let visible = true;
    const io = new IntersectionObserver(([e]) => (visible = !!e?.isIntersecting));
    io.observe(el);
    const frame = (ms: number) => {
      raf = requestAnimationFrame(frame);
      if (!visible || document.hidden || ms - last < 66) return;
      last = ms;
      draw(ms / 1000);
    };
    if (reduce) draw(0);
    else raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [theme]);

  return <canvas ref={canvas} className={`pulse-field ${className}`} aria-hidden="true" />;
}
