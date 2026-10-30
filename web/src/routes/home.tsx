import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { change24h } from "../components/Market";
import { StatusChip, displayName, headline } from "../components/status";
import { Roll } from "../components/Roll";
import { useToast } from "../components/ui";
import { compact, num, pct, price, tone, usd } from "../format";
import { useNow } from "../hooks";
import { act, useMarkets } from "../queries";
import { useCanTrade, useUi } from "../store";
import type { MarketView } from "../types";

const SECTIONS = [
  { id: "coins", title: "Creator coins", lead: "Snipe a coin before it opens: every bid fills at one price. Then it trades on its curve, with a perp beside it.", kinds: ["attention"] },
  { id: "preipo", title: "Pre-IPO", lead: "Perps on private companies. No outside price exists, so ours is set by our own order book until the IPO.", kinds: ["preipo"] },
  { id: "markets", title: "Crypto and prediction markets", lead: "Perps on crypto, equities and Polymarket outcomes, against outside oracles.", kinds: ["perp", "binary"] },
] as const;

export function HomePage() {
  const markets = useMarkets() ?? [];
  const now = useNow(1000);
  useEffect(() => {
    document.title = "Markets · Impulse";
  }, []);
  return (
    <div className="page wide home">
      <section className="hero">
        <div>
          <h1>Trade anything before it lists.</h1>
          <p className="lead">
            Creator coins with a snipe launch, pre-IPO perps priced by our own book, and no insurance fund: when a position goes bankrupt, the other side pays, and you can see exactly who.
            Paper money only.
          </p>
        </div>
        <LaunchBox />
      </section>
      {SECTIONS.map((s) => {
        const items = markets.filter((m) => (s.kinds as readonly string[]).includes(m.kind)).sort(order(now));
        return (
          <section key={s.id} className="market-section">
            <div className="section-head">
              <h2>{s.title}</h2>
              <span className="faint">{items.length}</span>
            </div>
            <p className="muted section-lead">{s.lead}</p>
            {items.length === 0 ? (
              <div className="empty panel">{s.id === "coins" ? "No creator coins yet. Launch one above." : "None listed yet."}</div>
            ) : (
              <div className="cards-grid">
                {items.map((m) => (
                  <MarketCard key={m.id} market={m} now={now} />
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Sniping first (soonest open first), then live markets by 24h volume. */
const order = (now: number) => (a: MarketView, b: MarketView) => {
  const sa = a.snipe && a.snipe.opensAt > now ? a.snipe.opensAt : Infinity;
  const sb = b.snipe && b.snipe.opensAt > now ? b.snipe.opensAt : Infinity;
  if (sa !== sb) return sa - sb;
  return num(b.volume24h) - num(a.volume24h);
};

function MarketCard({ market: m, now }: { market: MarketView; now: number }) {
  const ch = change24h(m);
  const px = headline(m);
  const sniping = !!m.snipe && m.snipe.opensAt > now;
  return (
    <Link to="/trade/$market" params={{ market: m.id }} className={`mcard ${sniping ? "sniping" : ""}`}>
      <div className="mcard-top">
        <span className="mcard-name" title={m.name}>
          {displayName(m)}
        </span>
        <StatusChip market={m} now={now} />
      </div>
      <div className="mcard-price">
        <Roll className="mono big" text={price(px, Math.max(m.priceDecimals, m.mark ? 0 : 6))} value={num(px)} />
        {sniping ? <span className="faint small">projected open</span> : <span className={`mono ${tone(ch)}`}>{pct(ch)}</span>}
      </div>
      <dl className="mcard-stats">
        {m.snipe && sniping ? (
          <>
            <dt>Pool</dt>
            <dd>{usd(m.snipe.total, { compact: true })}</dd>
            <dt>Snipers</dt>
            <dd>{m.snipe.snipers}</dd>
          </>
        ) : m.preipo ? (
          <>
            <dt>Valuation</dt>
            <dd>{usd(m.preipo.impliedValuation, { compact: true })}</dd>
            <dt>Seed</dt>
            <dd>{price(m.preipo.seedPrice, m.priceDecimals)}</dd>
          </>
        ) : m.curve ? (
          <>
            <dt>Mcap</dt>
            <dd>{usd(m.curve.marketCap, { compact: true })}</dd>
            <dt>24h vol</dt>
            <dd>{usd(m.volume24h, { compact: true })}</dd>
          </>
        ) : (
          <>
            <dt>OI</dt>
            <dd>{usd(m.openInterestUsd, { compact: true })}</dd>
            <dt>24h vol</dt>
            <dd>{compact(m.volume24h)}</dd>
          </>
        )}
        <dt>Max lev</dt>
        <dd>{m.maxLeverage}×</dd>
      </dl>
    </Link>
  );
}

function LaunchBox() {
  const toast = useToast();
  const navigate = useNavigate();
  const canTrade = useCanTrade();
  const open = useUi((s) => s.open);
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (location.hash === "#launch") ref.current?.focus();
  }, []);
  const clean = handle.trim().replace(/^@/, "");
  async function launch() {
    if (!canTrade) return open("signup");
    setBusy(true);
    try {
      const m = await act<MarketView>("POST", "/api/attention", { handle: `@${clean}`, oracleWindow: 600, adl: "pnl" });
      toast(m.snipe ? `${m.id} is open for sniping` : `${m.id} listed`, "up");
      void navigate({ to: "/trade/$market", params: { market: m.id } });
    } catch (e) {
      toast((e as Error).message, "down");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form
      id="launch"
      className="panel launch"
      onSubmit={(e) => {
        e.preventDefault();
        void launch();
      }}
    >
      <h3>Launch a coin</h3>
      <p className="muted">Any handle gets a creator coin. Bids pool during a short snipe window, then everyone fills at one open price.</p>
      <div className="row">
        <div className="adorn grow">
          <span className="prefix">@</span>
          <input ref={ref} className="input" placeholder="handle" value={handle} onChange={(e) => setHandle(e.target.value.replace(/\s/g, ""))} aria-label="Handle" />
        </div>
        <button className="btn primary" disabled={busy || clean.length < 2}>
          {busy ? "Launching…" : "Launch"}
        </button>
      </div>
    </form>
  );
}
