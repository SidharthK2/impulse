import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { api, live } from "../api";
import type { Candle, MarketView, PositionView } from "../types";

const INTERVALS = [1, 5, 15] as const;
type Interval = (typeof INTERVALS)[number];

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
// lightweight-charts renders UTC; shift so the axis reads in local time.
const local = (ms: number) => (Math.floor(ms / 1000) - new Date(ms).getTimezoneOffset() * 60) as UTCTimestamp;

function bucket(cs: Candle[], minutes: Interval): Candle[] {
  if (minutes === 1) return cs;
  const out: Candle[] = [];
  const size = minutes * 60_000;
  for (const c of cs) {
    const t = Math.floor(c.t / size) * size;
    const last = out[out.length - 1];
    if (last && last.t === t) {
      last.h = Math.max(last.h, c.h);
      last.l = Math.min(last.l, c.l);
      last.c = c.c;
      last.v += c.v;
    } else out.push({ ...c, t });
  }
  return out;
}

export function Chart({ market, position }: { market: MarketView; position?: PositionView }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const series = useRef<{ candles: ISeriesApi<"Candlestick">; volume: ISeriesApi<"Histogram"> } | null>(null);
  const lines = useRef<IPriceLine[]>([]);
  const raw = useRef<Candle[]>([]);
  const [interval, setInterval_] = useState<Interval>(1);
  const intervalRef = useRef<Interval>(1);
  intervalRef.current = interval;

  const draw = (fit: boolean) => {
    const s = series.current;
    if (!s) return;
    const cs = bucket(raw.current, intervalRef.current);
    const up = css("--up");
    const down = css("--down");
    s.candles.setData(cs.map((c) => ({ time: local(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));
    s.volume.setData(cs.map((c) => ({ time: local(c.t), value: c.v, color: c.c >= c.o ? `${up}55` : `${down}55` })));
    if (fit && cs.length) chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, cs.length - 150), to: cs.length + 4 });
  };

  useEffect(() => {
    if (!el.current) return;
    const c = createChart(el.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted"), fontFamily: css("--sans"), fontSize: 11 },
      grid: { vertLines: { color: css("--line") }, horzLines: { color: css("--line") } },
      rightPriceScale: { borderColor: css("--line") },
      timeScale: { borderColor: css("--line"), timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 },
    });
    const minMove = Number(market.tick);
    const candles = c.addSeries(CandlestickSeries, {
      upColor: css("--up"),
      downColor: css("--down"),
      wickUpColor: css("--up"),
      wickDownColor: css("--down"),
      borderVisible: false,
      priceFormat: { type: "price", precision: market.priceDecimals, minMove },
    });
    const volume = c.addSeries(HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    c.priceScale("vol").applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
    chart.current = c;
    series.current = { candles, volume };
    lines.current = [];
    raw.current = [];

    let alive = true;
    api<Candle[]>("GET", `/api/markets/${encodeURIComponent(market.id)}/candles`)
      .then((cs) => {
        if (!alive) return;
        raw.current = cs;
        draw(true);
      })
      .catch(() => {});
    const off = live.subscribe(`candles:${market.id}`, (data) => {
      const fresh = data as Candle[];
      if (!raw.current.length) return;
      for (const f of fresh) {
        const i = raw.current.findIndex((x) => x.t === f.t);
        if (i >= 0) raw.current[i] = f;
        else if (f.t > raw.current[raw.current.length - 1]!.t) raw.current.push(f);
      }
      draw(false);
    });
    return () => {
      alive = false;
      off();
      c.remove();
      chart.current = null;
      series.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.id]);

  useEffect(() => draw(true), [interval]);

  // Entry, liquidation and bankruptcy lines for the viewer's position.
  const entry = position?.entry;
  const liq = position?.liquidationPrice;
  const bust = position?.bankruptcyPrice;
  useEffect(() => {
    const s = series.current;
    if (!s) return;
    for (const l of lines.current) s.candles.removePriceLine(l);
    lines.current = [];
    const add = (p: string | null | undefined, color: string, title: string) => {
      if (!p) return;
      lines.current.push(s.candles.createPriceLine({ price: Number(p), color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title }));
    };
    add(entry, css("--info"), "entry");
    add(liq, css("--warn"), "liq");
    add(bust, css("--down"), "bankrupt");
  }, [entry, liq, bust, market.id]);

  return (
    <div className="panel chart-panel">
      <div className="panel-head">
        <h3>Mark price</h3>
        <span className="faint" style={{ fontSize: 11 }}>
          oracle: {market.source.label}
        </span>
        <span className="spacer" />
        <div className="tabs">
          {INTERVALS.map((i) => (
            <button key={i} className={i === interval ? "on" : ""} onClick={() => setInterval_(i)}>
              {i}m
            </button>
          ))}
        </div>
      </div>
      <div className="chart" ref={el} />
    </div>
  );
}
