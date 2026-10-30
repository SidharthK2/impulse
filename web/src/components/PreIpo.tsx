// Pre-IPO markets: no outside price exists, so the mark comes from our own order book until the IPO.

import { ago, num, pct, price, tone, usd } from "../format";
import { useNow } from "../hooks";
import type { MarketView } from "../types";
import { Roll } from "./Roll";

/** Shown wherever a market's price comes from our own book rather than an outside oracle. */
export function BookPricedBadge({ market }: { market: MarketView }) {
  if (market.source.kind !== "book") return null;
  return (
    <span className="badge book" title="No outside oracle: the mark is the mid of this market's own order book">
      <span className="hide-sm">price set by our order book</span>
      <span className="show-sm">our book</span>
    </span>
  );
}

export function PreIpoPanel({ market }: { market: MarketView }) {
  const now = useNow(5000);
  const p = market.preipo!;
  const d = market.priceDecimals;
  const sinceSeed = num(market.mark) / num(p.seedPrice) - 1;
  const sinceIpo = p.ipoPrice ? num(market.mark) / num(p.ipoPrice) - 1 : NaN;
  const pub = p.status === "public";
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Pre-IPO</h3>
        <span className="spacer" />
        <span className={`chip ${pub ? "info" : "live"}`}>{pub ? "public" : "private"}</span>
      </div>
      <div className="panel-body col" style={{ gap: 10 }}>
        <div className="valuation">
          <span className="label">Implied valuation</span>
          <Roll className="mono v" text={usd(p.impliedValuation, { compact: true })} value={num(p.impliedValuation)} />
          <span className="faint small">mark × 1,000,000,000 shares</span>
        </div>
        <dl className="kv">
          <dt>Seed price</dt>
          <dd>{price(p.seedPrice, d)}</dd>
          <dt>Since seed</dt>
          <dd className={tone(sinceSeed)}>{pct(sinceSeed, 1)}</dd>
          <dt>Status</dt>
          <dd>{pub ? `public${p.ipoAt ? ` · ${ago(p.ipoAt, now)}` : ""}` : "private"}</dd>
          {pub && (
            <>
              <dt>IPO price</dt>
              <dd>{price(p.ipoPrice, d)}</dd>
              <dt>Since IPO</dt>
              <dd className={tone(sinceIpo)}>{pct(sinceIpo, 1)}</dd>
            </>
          )}
        </dl>
        <div className="faint small">
          {pub
            ? "The IPO repriced this market in one step. Anyone on the wrong side of the gap was liquidated or bankrupt, and the other side paid the shortfall (see Who paid)."
            : "Nothing outside sets this price. It moves only when people trade here, and it will gap to wherever the IPO prices."}
        </div>
      </div>
    </div>
  );
}
