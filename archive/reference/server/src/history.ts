// Chart backfill: turn an external price history (coin prices) into the exchange's 1m mark candles.

import type { Exchange } from "./exchange.js";
import { lotPrice, nanoFromFeed } from "./units.js";

export interface PricePoint {
  t: number; // ms
  o: string;
  h: string;
  l: string;
  c: string;
}

/** Prepend history older than the market's first candle, merged into 1m buckets. */
export function candlesFromHistory(x: Exchange, market: string, points: PricePoint[]) {
  const meta = x.markets[market]!;
  const cs = (x.candles[market] ??= []);
  const first = cs[0]?.t ?? Infinity;
  const lot = (s: string) => lotPrice(meta, nanoFromFeed(s));
  const older: typeof cs = [];
  for (const p of [...points].sort((a, b) => a.t - b.t)) {
    const t = Math.floor(p.t / 60_000) * 60_000;
    if (t >= first) break;
    const last = older[older.length - 1];
    if (last && last.t === t) {
      const h = lot(p.h);
      const l = lot(p.l);
      if (h > last.h) last.h = h;
      if (l < last.l) last.l = l;
      last.c = lot(p.c);
    } else older.push({ t, o: lot(p.o), h: lot(p.h), l: lot(p.l), c: lot(p.c), v: 0n });
  }
  x.candles[market] = [...older, ...cs].slice(-1440);
  x.version++;
}
