// A market card's 24h trend: one thin line in a muted ink, its end dot in the direction colour. The direction is
// also in the card's change figure, so colour never carries it alone; the line has a text summary for readers.

import { useMemo } from "react";
import { price } from "../format";
import type { Candle } from "../types";

const W = 240;
const H = 40;
const POINTS = 48;

export function Sparkline({ candles, decimals, since }: { candles: Candle[] | undefined; decimals: number; since: number }) {
  const shape = useMemo(() => {
    const cs = (candles ?? []).filter((c) => c.t >= since);
    if (cs.length === 0) return null;
    // The first candle's open, then closes downsampled to at most POINTS, always keeping the latest. Starting at the
    // open means even a market with one candle of history draws a line.
    const step = Math.max(1, Math.ceil(cs.length / POINTS));
    const pts = [cs[0]!.o, ...cs.filter((_, i) => i % step === 0 || i === cs.length - 1).map((c) => c.c)];
    const lo = Math.min(...pts);
    const hi = Math.max(...pts);
    const span = hi - lo || Math.abs(hi) * 0.001 || 1;
    const pad = 3; // keep the 2px line and the end dot inside the box
    const xy = pts.map((p, i) => [(i / (pts.length - 1)) * (W - pad * 2) + pad, H - pad - ((p - lo) / span) * (H - pad * 2)] as const);
    const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    const area = `${line}L${xy[xy.length - 1]![0].toFixed(1)},${H}L${xy[0]![0].toFixed(1)},${H}Z`;
    const first = pts[0]!;
    const last = pts[pts.length - 1]!;
    return { line, area, end: xy[xy.length - 1]!, up: last >= first, lo, hi };
  }, [candles, since]);

  if (!shape) return <div className="spark spark-empty">{candles ? "no history yet" : ""}</div>;
  // The SVG stretches to the card's width; the end dot is HTML on top so it stays round.
  return (
    <div className="spark" role="img" aria-label={`24h range ${price(shape.lo, decimals)} to ${price(shape.hi, decimals)}, ${shape.up ? "up" : "down"}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <path d={shape.area} className="spark-area" />
        <path d={shape.line} className="spark-line" vectorEffect="non-scaling-stroke" />
      </svg>
      <i className={`spark-end ${shape.up ? "up" : "down"}`} style={{ left: `${(shape.end[0] / W) * 100}%`, top: `${(shape.end[1] / H) * 100}%` }} />
    </div>
  );
}
