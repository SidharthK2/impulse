import { Link, useNavigate } from "@tanstack/react-router";
import { useForm, useSelector } from "@tanstack/react-form";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { change24h } from "../components/Market";
import { Sparkline } from "../components/Sparkline";
import { StatusChip, displayName, headline } from "../components/status";
import { FieldError, FormError, invalid, useServerError } from "../components/form";
import { Roll } from "../components/Roll";
import { KindBadge, useToast } from "../components/ui";
import { PulseField } from "../components/PulseField";
import { Ticker } from "../components/Ticker";
import { incidents } from "../components/WhoPaid";
import { ago, compact, countdown, num, pct, price, tone, usd } from "../format";
import { useNow } from "../hooks";
import { act, useCandles, useFeed, useLeaderboard, useMarkets } from "../queries";
import { useCanTrade, usePrefs, useUi } from "../store";
import type { MarketView } from "../types";

type Category = "all" | "coins" | "preipo" | "crypto" | "prediction";
type Sort = "volume" | "change" | "newest";

const CATEGORIES: { id: Category; label: string; kinds: MarketView["kind"][] }[] = [
  { id: "all", label: "All", kinds: ["attention", "preipo", "perp", "binary"] },
  { id: "coins", label: "Creator coins", kinds: ["attention"] },
  { id: "preipo", label: "Pre-IPO", kinds: ["preipo"] },
  { id: "crypto", label: "Crypto and equities", kinds: ["perp"] },
  { id: "prediction", label: "Prediction", kinds: ["binary"] },
];

const SECTIONS = [
  { id: "coins", title: "Creator coins", lead: "Snipe a coin before it opens: every bid fills at one price. Then it trades on its curve, with a perp beside it.", kinds: ["attention"] },
  { id: "preipo", title: "Pre-IPO", lead: "Perps on private companies. No outside price exists, so ours is set by our own order book until the IPO.", kinds: ["preipo"] },
  { id: "markets", title: "Crypto and prediction markets", lead: "Perps on crypto, equities and Polymarket outcomes, against outside oracles.", kinds: ["perp", "binary"] },
] as const;

export function HomePage() {
  const markets = useMarkets() ?? [];
  const now = useNow(1000);
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("volume");
  useEffect(() => {
    document.title = "Impulse · paper-trading MicroPerps exchange";
  }, []);

  const q = query.trim().toLowerCase();

  // Switching category, sort or search swaps the list under the sticky toolbar. If you'd scrolled past the
  // toolbar, keep it pinned and start the new list right under it, instead of letting a shorter page clamp the
  // scroll and jump. Runs before paint; .home-results is at least a viewport tall, so the target is reachable.
  const toolbarRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);
  useLayoutEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const bar = toolbarRef.current;
    const results = resultsRef.current;
    if (!bar || !results) return;
    const stuckAt = Number.parseFloat(getComputedStyle(bar).top) || 0;
    const target = results.getBoundingClientRect().top + window.scrollY - bar.offsetHeight - stuckAt - 12; // a little air under the toolbar
    if (window.scrollY > target) window.scrollTo({ top: target });
  }, [category, sort, q]);
  const matches = (m: MarketView) => !q || `${m.id} ${m.name} ${m.base}`.toLowerCase().includes(q);
  const sorted = (xs: MarketView[]) => xs.filter(matches).sort(order(now, sort));
  const sections =
    category === "all"
      ? SECTIONS.map((s) => ({ ...s, items: sorted(markets.filter((m) => (s.kinds as readonly string[]).includes(m.kind))) }))
      : [{ id: category, title: CATEGORIES.find((c) => c.id === category)!.label, lead: "", items: sorted(markets.filter((m) => CATEGORIES.find((c) => c.id === category)!.kinds.includes(m.kind))) }];
  const shown = sections.reduce((n, s) => n + s.items.length, 0);

  return (
    <div className="page wide home">
      <Hero markets={markets} now={now} />
      <Spotlight markets={markets} now={now} />

      <div ref={toolbarRef} className="home-toolbar" role="search">
        <div className="tabs cat-tabs" role="tablist" aria-label="Market category">
          {CATEGORIES.map((c) => {
            const n = c.id === "all" ? markets.length : markets.filter((m) => c.kinds.includes(m.kind)).length;
            return (
              <button key={c.id} role="tab" aria-selected={category === c.id} className={category === c.id ? "on" : ""} onClick={() => setCategory(c.id)}>
                {c.label}
                <span className="count">{n}</span>
              </button>
            );
          })}
        </div>
        <span className="spacer" />
        <input className="input home-search" type="search" placeholder="Search markets" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search markets" />
        <select className="input home-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort markets">
          <option value="volume">24h volume</option>
          <option value="change">24h change</option>
          <option value="newest">Newest</option>
        </select>
      </div>

      <div ref={resultsRef} className="home-results">
        {shown === 0 && q ? <div className="empty panel">No markets match “{query}”.</div> : null}
        {sections.map((s) =>
          s.items.length === 0 && (q || category !== "all") ? null : (
            <section key={s.id} className="market-section">
              <div className="section-head">
                <h2>{s.title}</h2>
                <span className="faint">{s.items.length}</span>
              </div>
              {s.lead && <p className="muted section-lead">{s.lead}</p>}
              {s.items.length === 0 ? (
                <div className="empty panel">{s.id === "coins" ? "No creator coins yet. Launch one above." : "None listed yet."}</div>
              ) : (
                <div className="cards-grid">
                  {s.items.map((m) => (
                    <MarketCard key={m.id} market={m} now={now} />
                  ))}
                </div>
              )}
            </section>
          ),
        )}
      </div>
    </div>
  );
}

/** Sniping coins first (soonest open first), then by the chosen sort. */
const order = (now: number, sort: Sort) => (a: MarketView, b: MarketView) => {
  const sa = a.snipe && a.snipe.opensAt > now ? a.snipe.opensAt : Infinity;
  const sb = b.snipe && b.snipe.opensAt > now ? b.snipe.opensAt : Infinity;
  if (sa !== sb) return sa - sb;
  if (sort === "change") return (Number.isFinite(change24h(b)) ? change24h(b) : -Infinity) - (Number.isFinite(change24h(a)) ? change24h(a) : -Infinity);
  if (sort === "newest") return b.createdAt - a.createdAt;
  return num(b.volume24h) - num(a.volume24h);
};

function Hero({ markets, now }: { markets: MarketView[]; now: number }) {
  const lastMarket = usePrefs((s) => s.lastMarket);
  const leaders = useLeaderboard();
  const feed = useFeed();
  const open = markets.filter((m) => m.status === "open");
  const volume = open.reduce((s, m) => s + num(m.volume24h), 0);
  const oi = open.reduce((s, m) => s + num(m.openInterestUsd), 0);
  // All-time haircuts from the leaderboard; the recent feed is a floor when there's no leaderboard (fixtures only).
  const haircuts = Math.max(
    leaders.reduce((s, r) => s + num(r.haircuts), 0),
    feed.filter((e) => e.kind === "haircut").reduce((s, e) => s + num(e.amount ?? "0"), 0),
  );
  const start = lastMarket && markets.some((m) => m.id === lastMarket) ? lastMarket : (markets.find((m) => m.kind === "perp")?.id ?? markets[0]?.id ?? "BTC-PERP");
  // The preview shows the coin opening soonest, else the busiest live perp.
  const featured =
    markets.filter((m) => m.snipe && m.snipe.opensAt > now).sort((a, b) => a.snipe!.opensAt - b.snipe!.opensAt)[0] ??
    open.filter((m) => !m.snipe && m.kind === "perp").sort((a, b) => num(b.volume24h) - num(a.volume24h))[0] ??
    open[0];
  return (
    <section className="landing">
      <Ticker markets={markets} />
      <div className="landing-stage">
        <PulseField />
        <div className="landing-inner">
          <div className="landing-copy">
            <span className="eyebrow">
              <i className="pulse" /> paper-money exchange · live
            </span>
            <h1 className="wordmark">impulse</h1>
            <ul className="claims">
              <li>
                <b>snipe launches</b>, one open price for every bid
              </li>
              <li>
                <b>pre-IPO perps</b> priced by our own order book
              </li>
              <li>
                <b>no insurance fund</b>: the other side pays, by name
              </li>
              <li>
                <b>paper money</b>, real matching and margin
              </li>
            </ul>
            <div className="row hero-ctas">
              <Link className="btn primary lg" to="/trade/$market" params={{ market: start }}>
                Start trading →
              </Link>
              <a className="btn ghost lg" href="#launch">
                Launch a coin
              </a>
            </div>
          </div>
          {featured && <Preview market={featured} now={now} />}
        </div>
        <div className="kpis landing-kpis">
          <div className="kpi">
            <span className="label">Markets</span>
            <span className="v mono">{open.length}</span>
          </div>
          <div className="kpi">
            <span className="label">24h volume</span>
            <Roll className="v mono" text={usd(volume, { compact: true })} value={volume} flash={false} />
          </div>
          <div className="kpi">
            <span className="label">Open interest</span>
            <Roll className="v mono" text={usd(oi, { compact: true })} value={oi} flash={false} />
          </div>
          <div className="kpi" title="ADL haircuts: profit (or principal) taken from the winning side to cover other traders' bankruptcies">
            <span className="label">ADL haircuts paid</span>
            <Roll className="v mono down" text={usd(haircuts, { compact: true })} value={haircuts} flash={false} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** A live market in a frame, standing in for a product screenshot: price, 24h line, and the latest risk event. */
function Preview({ market: m, now }: { market: MarketView; now: number }) {
  const feed = useFeed();
  const sniping = !!m.snipe && m.snipe.opensAt > now;
  const candles = useCandles(m.id, !m.snipe);
  const px = headline(m);
  const ch = change24h(m);
  const latest = feed.find((e) => ["bankrupt", "haircut", "liquidation", "open", "ipo", "listing"].includes(e.kind));
  return (
    <Link to="/trade/$market" params={{ market: m.id }} className="preview" aria-label={`Open ${m.id}`}>
      <div className="preview-bar">
        <span className="preview-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="faint small">impulse / trade / {m.id}</span>
      </div>
      <div className="preview-body">
        <div className="preview-head">
          <b>{displayName(m)}</b>
          <StatusChip market={m} now={now} />
        </div>
        <div className="preview-price">
          <Roll className="mono" text={price(px, Math.max(m.priceDecimals, m.snipe ? 6 : 0))} value={num(px)} />
          {sniping ? <span className="faint small">projected open</span> : <span className={`mono ${tone(ch)}`}>{pct(ch)}</span>}
        </div>
        {sniping ? (
          <div className="preview-snipe">
            <span className="label">Opens in</span>
            <span className="mono">{countdown(m.snipe!.opensAt - now)}</span>
            <span className="faint small">
              {usd(m.snipe!.total)} from {m.snipe!.snipers} sniper{m.snipe!.snipers === 1 ? "" : "s"}
            </span>
          </div>
        ) : (
          <div className="preview-chart">
            <Sparkline candles={candles} decimals={m.priceDecimals} since={now - 24 * 3_600_000} />
          </div>
        )}
        <dl className="preview-stats">
          <dt>Open interest</dt>
          <dd>{usd(m.openInterestUsd, { compact: true })}</dd>
          <dt>24h volume</dt>
          <dd>{usd(m.volume24h, { compact: true })}</dd>
          <dt>Max leverage</dt>
          <dd>{m.maxLeverage}×</dd>
        </dl>
        {latest && (
          <div className="preview-event">
            <KindBadge kind={latest.kind} />
            <span className="preview-event-text">{latest.text}</span>
            <span className="faint small">{ago(latest.time, now)}</span>
          </div>
        )}
      </div>
    </Link>
  );
}

/** The coin opening soonest, and the latest bankruptcies with who covered them. */
function Spotlight({ markets, now }: { markets: MarketView[]; now: number }) {
  const feed = useFeed();
  const sniping = markets.filter((m) => m.snipe && m.snipe.opensAt > now).sort((a, b) => a.snipe!.opensAt - b.snipe!.opensAt);
  const next = sniping[0];
  const recent = useMemo(() => incidents(feed.filter((e) => e.kind === "bankrupt" || e.kind === "haircut")).filter((i) => i.bankrupt.length > 0).slice(0, 4), [feed]);
  return (
    <section className={`spotlight ${next ? "three" : ""}`}>
      {next ? (
        <Link to="/trade/$market" params={{ market: next.id }} className="panel snipe-spot">
          <div className="snipe-spot-head">
            <span className="chip snipe">
              <i className="pulse" /> Sniping now
            </span>
            {sniping.length > 1 && <span className="faint small">+{sniping.length - 1} more</span>}
          </div>
          <div className="snipe-spot-body">
            <div>
              <div className="snipe-spot-name">{next.id}</div>
              <div className="muted small">Every bid fills at one open price. No front-running the launch.</div>
            </div>
            <div className="snipe-spot-clock">
              <span className="label">Opens in</span>
              <span className="mono">{countdown(next.snipe!.opensAt - now)}</span>
            </div>
          </div>
          <dl className="snipe-spot-stats">
            <dt>Pool</dt>
            <dd>{usd(next.snipe!.total)}</dd>
            <dt>Snipers</dt>
            <dd>{next.snipe!.snipers}</dd>
            <dt>Projected open</dt>
            <dd>{price(next.snipe!.projectedOpenPrice, Math.max(next.priceDecimals, 6))}</dd>
          </dl>
          <span className="btn primary snipe-spot-cta">Snipe {next.id} →</span>
        </Link>
      ) : null}

      <LaunchBox />

      <div className="panel paid-spot">
        <div className="panel-head">
          <h3>Who paid, live</h3>
          <span className="spacer" />
          <Link to="/feed" className="small">
            All →
          </Link>
        </div>
        {recent.length === 0 ? (
          <div className="empty">No bankruptcies yet. When one happens, the traders who covered it show up here.</div>
        ) : (
          <ul className="paid-list">
            {recent.map((i) => {
              const paid = i.haircuts.reduce((s, e) => s + num(e.amount ?? "0"), 0);
              const top = [...i.haircuts].sort((a, b) => num(b.amount ?? "0") - num(a.amount ?? "0"))[0];
              return (
                <li key={i.key}>
                  <Link to="/trade/$market" params={{ market: i.market }} className="paid-row">
                    <span className="paid-what">
                      <b>{i.bankrupt[0]!.accounts[0]}</b> went bankrupt on <span className="mono">{i.market}</span>
                    </span>
                    <span className="mono down">{usd(i.shortfall)}</span>
                    <span className="faint small paid-who">
                      {i.haircuts.length > 0 ? `${i.haircuts.length} paid ${usd(paid)}${top ? `, most by ${top.accounts[0]}` : ""}` : "covered by ADL"} · {ago(i.time, now)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Whether an element has scrolled into view (once true, stays true). */
function useSeen<T extends Element>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver(([e]) => e?.isIntersecting && setSeen(true), { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

function MarketCard({ market: m, now }: { market: MarketView; now: number }) {
  const ch = change24h(m);
  const px = headline(m);
  const sniping = !!m.snipe && m.snipe.opensAt > now;
  const [ref, seen] = useSeen<HTMLAnchorElement>();
  const candles = useCandles(m.id, seen && !m.snipe);
  return (
    <Link ref={ref} to="/trade/$market" params={{ market: m.id }} className={`mcard ${sniping ? "sniping" : ""}`}>
      <div className="mcard-top">
        <span className="mcard-name" title={m.name}>
          {displayName(m)}
        </span>
        <StatusChip market={m} now={now} />
      </div>
      <div className="mcard-price">
        <Roll className="mono big" text={price(px, Math.max(m.priceDecimals, m.snipe ? 6 : 0))} value={num(px)} />
        {sniping ? <span className="faint small">projected open</span> : <span className={`mono ${tone(ch)}`}>{pct(ch)}</span>}
      </div>
      {sniping ? (
        <div className="spark spark-empty">
          <span className="mono">{countdown(m.snipe!.opensAt - now)}</span> to the open
        </div>
      ) : (
        <Sparkline candles={candles} decimals={m.priceDecimals} since={now - 24 * 3_600_000} />
      )}
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

const HANDLE = /^[A-Za-z0-9_]{2,20}$/;

function LaunchBox() {
  const toast = useToast();
  const navigate = useNavigate();
  const canTrade = useCanTrade();
  const open = useUi((s) => s.open);
  const server = useServerError();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (location.hash === "#launch") ref.current?.focus();
  }, []);
  const form = useForm({
    defaultValues: { handle: "" },
    onSubmit: async ({ value }) => {
      server.clear();
      try {
        const m = await act<MarketView>("POST", "/api/attention", { handle: `@${value.handle.replace(/^@/, "")}`, oracleWindow: 600, adl: "pnl" });
        toast(m.snipe ? `${m.id} is open for sniping` : `${m.id} listed`, "up");
        void navigate({ to: "/trade/$market", params: { market: m.id } });
      } catch (e) {
        server.fail(e);
      }
    },
  });
  const pending = useSelector(form.store, (s) => s.isSubmitting);
  return (
    <form
      id="launch"
      className="panel launch"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!canTrade) return open("signup");
        void form.handleSubmit();
      }}
    >
      <h3>Launch a coin</h3>
      <p className="muted">Any handle gets a creator coin. Bids pool during a short snipe window, then everyone fills at one open price.</p>
      <form.Field
        name="handle"
        validators={{
          onChange: ({ value }) => {
            const h = value.replace(/^@/, "");
            if (!h) return "Enter a handle";
            if (!HANDLE.test(h)) return "2–20 letters, digits or _";
            return undefined;
          },
        }}
      >
        {(f) => (
          <div className="col" style={{ gap: 4 }}>
            <div className="row">
              <div className="adorn grow">
                <span className="prefix">@</span>
                <input
                  ref={ref}
                  className={`input ${invalid(f) ? "bad" : ""}`}
                  placeholder="handle"
                  value={f.state.value}
                  onChange={(e) => f.handleChange(e.target.value.replace(/\s/g, ""))}
                  onBlur={f.handleBlur}
                  aria-label="Handle"
                  aria-invalid={invalid(f)}
                />
              </div>
              <button type="submit" className="btn primary" disabled={pending}>
                {pending ? "Launching…" : "Launch"}
              </button>
            </div>
            <FieldError field={f} />
          </div>
        )}
      </form.Field>
      <FormError error={server.error} />
    </form>
  );
}
