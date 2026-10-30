// A strip of live prices scrolling along the top of the home page. Hover to pause; each item opens its market.

import { Link } from "@tanstack/react-router";
import { pct, price, tone } from "../format";
import type { MarketView } from "../types";
import { change24h } from "./Market";
import { headline } from "./status";

export function Ticker({ markets }: { markets: MarketView[] }) {
  const items = markets.filter((m) => m.status === "open" && headline(m) !== null).sort((a, b) => Number(b.volume24h) - Number(a.volume24h));
  if (items.length === 0) return <div className="ticker" />;
  // Two copies side by side; the track slides left by one copy's width and repeats seamlessly.
  const row = (copy: number) =>
    items.map((m) => {
      const ch = change24h(m);
      return (
        <Link key={`${copy}-${m.id}`} to="/trade/$market" params={{ market: m.id }} className="tick" tabIndex={copy ? -1 : 0} aria-hidden={copy ? true : undefined}>
          <b>{m.id}</b>
          <span className="mono">{price(headline(m), Math.max(m.priceDecimals, m.snipe ? 6 : 0))}</span>
          {m.snipe ? <span className="mono warn">sniping</span> : <span className={`mono ${tone(ch)}`}>{pct(ch)}</span>}
        </Link>
      );
    });
  return (
    <div className="ticker" aria-label="Live prices">
      <div className="ticker-track" style={{ animationDuration: `${Math.max(20, items.length * 4)}s` }}>
        {row(0)}
        {row(1)}
      </div>
    </div>
  );
}
