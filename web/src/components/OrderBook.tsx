import { useLayoutEffect, useRef } from "react";
import { price, size } from "../format";
import { useBook, useTrades } from "../queries";
import { usePrefs } from "../store";
import { Roll } from "./Roll";
import type { Level, MarketView } from "../types";

const DEPTH = 20;

function Side({
  levels,
  kind,
  market,
  max,
  onPick,
}: {
  levels: Level[];
  kind: "asks" | "bids";
  market: MarketView;
  max: number;
  onPick: (p: string) => void;
}) {
  let cum = 0;
  const rows = levels.slice(0, DEPTH).map((l) => {
    cum += Number(l.size);
    return { ...l, cum };
  });
  return (
    <div className={`rows ${kind}`}>
      {rows.map((l) => (
        <div
          key={l.price}
          className="r"
          onClick={() => onPick(l.price)}
          title={`${l.orders} order${l.orders === 1 ? "" : "s"} — click to use this price`}
        >
          <span className={kind === "asks" ? "down" : "up"}>
            {price(l.price, market.priceDecimals)}
          </span>
          <span>{size(l.size, market.szDecimals)}</span>
          <span className="muted">{size(l.cum, market.szDecimals)}</span>
          <i className="depth" style={{ width: `${max > 0 ? (l.cum / max) * 100 : 0}%` }} />
        </div>
      ))}
    </div>
  );
}

/** The order book and the trade tape as two tabs of one panel. */
export function BookPanel({ market, onPick }: { market: MarketView; onPick: (p: string) => void }) {
  const tab = usePrefs((s) => s.bookTab);
  const setTab = usePrefs((s) => s.setBookTab);
  return (
    <div className="panel book-panel">
      <div className="panel-head">
        <div className="tabs" role="tablist">
          {(
            [
              ["book", "Order book"],
              ["trades", "Trades"],
            ] as const
          ).map(([id, label]) => (
            <button
              type="button"
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "on" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <span className="faint" style={{ fontSize: 11 }}>
          {market.base}
        </span>
      </div>
      {tab === "book" ? <OrderBook market={market} onPick={onPick} /> : <Trades market={market} />}
    </div>
  );
}

export function OrderBook({ market, onPick }: { market: MarketView; onPick: (p: string) => void }) {
  const book = useBook(market.id);
  const bids = book?.bids ?? [];
  const asks = book?.asks ?? [];
  const sum = (ls: Level[]) => ls.slice(0, DEPTH).reduce((s, l) => s + Number(l.size), 0);
  const max = Math.max(sum(bids), sum(asks));
  const bestBid = bids[0] ? Number(bids[0].price) : NaN;
  const bestAsk = asks[0] ? Number(asks[0].price) : NaN;
  const spread = bestAsk - bestBid;
  const mid = (bestAsk + bestBid) / 2;

  // Asks read upward from the spread, so their list starts scrolled to the bottom and stays there as the book
  // updates, unless the user has scrolled up to look at higher asks.
  const asksBox = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = asksBox.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [asks]);
  useLayoutEffect(() => {
    pinned.current = true;
  }, [market.id]);

  return (
    <div className="book">
      <div className="hdr">
        <span>Price</span>
        <span>Size</span>
        <span>Total</span>
      </div>
      <div
        ref={asksBox}
        className="scroll book-asks"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 4;
        }}
      >
        <Side levels={asks} kind="asks" market={market} max={max} onPick={onPick} />
      </div>
      <div className="mid">
        <span>
          mark <Roll className="b" text={price(book?.mark ?? market.mark, market.priceDecimals)} />
        </span>
        <span className="muted">
          spread{" "}
          {Number.isFinite(spread)
            ? `${market.priceDecimals < 6 ? `${price(spread, market.priceDecimals)} ` : ""}(${((spread / mid) * 10_000).toFixed(1)} bps)`
            : "—"}
        </span>
      </div>
      <div className="scroll" style={{ flex: 1 }}>
        <Side levels={bids} kind="bids" market={market} max={max} onPick={onPick} />
      </div>
      {book && bids.length === 0 && asks.length === 0 && (
        <div className="empty">No resting orders</div>
      )}
    </div>
  );
}

export function Trades({ market }: { market: MarketView }) {
  const trades = useTrades(market.id);
  return (
    <div className="tape">
      <div className="hdr">
        <span>Price</span>
        <span>Size</span>
        <span>Time</span>
      </div>
      <div className="scroll" style={{ flex: 1 }}>
        {trades.length === 0 && <div className="empty">No trades yet</div>}
        {trades.map((t) => (
          <div
            key={t.id}
            className="r"
            title={`${t.taker} ${t.side === "buy" ? "bought from" : "sold to"} ${t.maker}${t.kind === "spot" ? " (spot curve)" : ""}`}
          >
            <span className={t.side === "buy" ? "up" : "down"}>
              {price(t.price, market.priceDecimals)}
              {t.kind === "spot" && <span className="faint"> spot</span>}
            </span>
            <span>{size(t.size, market.szDecimals)}</span>
            <span className="faint">
              {new Date(t.time).toLocaleTimeString("en-US", { hour12: false })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
