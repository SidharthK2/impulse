import { Link, useNavigate } from "@tanstack/react-router";
import { useForm, useSelector } from "@tanstack/react-form";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { change24h } from "../components/Market";
import { Sparkline } from "../components/Sparkline";
import { displayName, headline } from "../components/status";
import { FieldError, FormError, invalid, useServerError } from "../components/form";
import { useToast } from "../components/ui";
import { incidents } from "../components/WhoPaid";
import { ago, countdown, num, pct, price, tone, usd } from "../format";
import { useNow } from "../hooks";
import { act, useCandles, useFeed, useLeaderboard, useMarkets } from "../queries";
import { useCanTrade, usePrefs, useUi } from "../store";
import type { MarketView } from "../types";

type Category = "all" | "coins" | "preipo" | "crypto" | "prediction";
type SortKey = "volume" | "change" | "oi" | "price" | "name";

const CATEGORIES: { id: Category; label: string; kinds: MarketView["kind"][] }[] = [
  { id: "all", label: "All", kinds: ["attention", "preipo", "perp", "binary"] },
  { id: "coins", label: "Creator coins", kinds: ["attention"] },
  { id: "preipo", label: "Pre-IPO", kinds: ["preipo"] },
  { id: "crypto", label: "Crypto and equities", kinds: ["perp"] },
  { id: "prediction", label: "Prediction", kinds: ["binary"] },
];

// Under "All", the table is grouped into these sections.
const GROUPS = [
  { title: "Creator coins", kinds: ["attention"] },
  { title: "Pre-IPO", kinds: ["preipo"] },
  { title: "Crypto, equities and prediction markets", kinds: ["perp", "binary"] },
] as const;

const KIND: Record<MarketView["kind"], string> = { attention: "coin", preipo: "pre-IPO", perp: "perp", binary: "prediction" };

export function HomePage() {
  const markets = useMarkets() ?? [];
  const now = useNow(1000);
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "volume", desc: true });
  useEffect(() => {
    document.title = "Markets · Impulse";
  }, []);

  const q = query.trim().toLowerCase();

  // Switching category, sort or search swaps the table under the sticky toolbar. If you'd scrolled past the
  // toolbar, keep it pinned and start the new rows right under it, instead of letting a shorter page clamp the
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
    const target = results.getBoundingClientRect().top + window.scrollY - bar.offsetHeight - stuckAt - 12;
    if (window.scrollY > target) window.scrollTo({ top: target });
  }, [category, sort, q]);

  const matches = (m: MarketView) => !q || `${m.id} ${m.name} ${m.base}`.toLowerCase().includes(q);
  const sorted = (xs: MarketView[]) => xs.filter(matches).sort(order(now, sort.key, sort.desc));
  const cat = CATEGORIES.find((c) => c.id === category)!;
  const groups =
    category === "all"
      ? GROUPS.map((g) => ({ title: g.title, items: sorted(markets.filter((m) => (g.kinds as readonly string[]).includes(m.kind))) })).filter((g) => g.items.length > 0)
      : [{ title: "", items: sorted(markets.filter((m) => cat.kinds.includes(m.kind))) }];
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const sortBy = (key: SortKey) => setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: key !== "name" }));

  return (
    <div className="page wide home">
      <Intro markets={markets} />
      <div className="home-grid">
        <div className="home-main">
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
            <input className="input home-search" type="search" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter markets" />
          </div>
          <div ref={resultsRef} className="home-results">
            <table className="grid markets-table">
              <thead>
                <tr>
                  <Th label="Market" k="name" sort={sort} onSort={sortBy} />
                  <Th label="Price" k="price" sort={sort} onSort={sortBy} right />
                  <Th label="24h" k="change" sort={sort} onSort={sortBy} right />
                  <Th label="24h volume" k="volume" sort={sort} onSort={sortBy} right className="hide-sm" />
                  <Th label="Open interest" k="oi" sort={sort} onSort={sortBy} right className="hide-sm" />
                  <th className="right hide-sm">Max lev</th>
                  <th className="hide-md">24h</th>
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.title || "all"}>
                  {g.title && (
                    <tr className="group-row">
                      <td colSpan={7}>
                        {g.title} <span className="faint">{g.items.length}</span>
                      </td>
                    </tr>
                  )}
                  {g.items.map((m) => (
                    <MarketRow key={m.id} market={m} now={now} />
                  ))}
                </tbody>
              ))}
            </table>
            {shown === 0 && <div className="empty">{q ? `No markets match “${query}”.` : "None listed yet."}</div>}
          </div>
        </div>
        <aside className="home-side">
          <SnipingNow markets={markets} now={now} />
          <LaunchBox />
          <RecentPaid now={now} />
        </aside>
      </div>
    </div>
  );
}

function Th({ label, k, sort, onSort, right, className = "" }: { label: string; k: SortKey; sort: { key: SortKey; desc: boolean }; onSort: (k: SortKey) => void; right?: boolean; className?: string }) {
  const on = sort.key === k;
  return (
    <th className={`${right ? "right" : ""} ${className}`} aria-sort={on ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button className={`th-sort ${on ? "on" : ""}`} onClick={() => onSort(k)}>
        {label}
        <span aria-hidden="true">{on ? (sort.desc ? "↓" : "↑") : ""}</span>
      </button>
    </th>
  );
}

/** Sniping coins first (soonest open first), then by the chosen column. */
const order = (now: number, key: SortKey, desc: boolean) => (a: MarketView, b: MarketView) => {
  const sa = a.snipe && a.snipe.opensAt > now ? a.snipe.opensAt : Infinity;
  const sb = b.snipe && b.snipe.opensAt > now ? b.snipe.opensAt : Infinity;
  if (sa !== sb) return sa - sb;
  const val = (m: MarketView): number | string =>
    key === "name" ? m.id.toLowerCase() : key === "price" ? num(headline(m)) : key === "change" ? change24h(m) : key === "oi" ? num(m.openInterestUsd) : num(m.volume24h);
  const x = val(a);
  const y = val(b);
  const cmp = typeof x === "string" ? x.localeCompare(y as string) : (Number.isFinite(x) ? x : -Infinity) - (Number.isFinite(y as number) ? (y as number) : -Infinity);
  return desc ? -cmp : cmp;
};

function Intro({ markets }: { markets: MarketView[] }) {
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
  return (
    <section className="intro">
      <div className="intro-copy">
        <h1 className="wordmark">impulse</h1>
        <p className="intro-line">
          A paper-money exchange for creator coins and pre-IPO perps. There's no insurance fund: when a position goes bankrupt, the other side pays, and you can see who.
        </p>
        <div className="row intro-ctas">
          <Link className="btn primary" to="/trade/$market" params={{ market: start }}>
            Start trading
          </Link>
          <a className="btn" href="#launch">
            Launch a coin
          </a>
        </div>
      </div>
      <dl className="intro-stats">
        <div>
          <dt>Markets</dt>
          <dd>{open.length}</dd>
        </div>
        <div>
          <dt>24h volume</dt>
          <dd>{usd(volume, { compact: true })}</dd>
        </div>
        <div>
          <dt>Open interest</dt>
          <dd>{usd(oi, { compact: true })}</dd>
        </div>
        <div title="Profit (or principal) taken from the winning side to cover other traders' bankruptcies">
          <dt>ADL haircuts paid</dt>
          <dd>{usd(haircuts, { compact: true })}</dd>
        </div>
      </dl>
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

function MarketRow({ market: m, now }: { market: MarketView; now: number }) {
  const navigate = useNavigate();
  const [ref, seen] = useSeen<HTMLTableRowElement>();
  const candles = useCandles(m.id, seen && !m.snipe);
  const sniping = !!m.snipe && m.snipe.opensAt > now;
  const ch = change24h(m);
  const go = () => void navigate({ to: "/trade/$market", params: { market: m.id } });
  return (
    <tr ref={ref} className="click market-row" onClick={go}>
      <td>
        <Link to="/trade/$market" params={{ market: m.id }} className="mr-name" onClick={(e) => e.stopPropagation()}>
          <b>{displayName(m)}</b>
          <span className="mr-kind">{KIND[m.kind]}</span>
          {m.preipo?.status === "public" && <span className="mr-kind">public</span>}
          {m.status === "resolved" && <span className="mr-kind">resolved</span>}
        </Link>
      </td>
      <td className="right mono">{price(headline(m), Math.max(m.priceDecimals, m.snipe ? 6 : 0))}</td>
      <td className={`right mono ${sniping ? "warn" : tone(ch)}`}>{sniping ? `opens ${countdown(m.snipe!.opensAt - now)}` : pct(ch)}</td>
      <td className="right mono hide-sm">{usd(m.volume24h, { compact: true })}</td>
      <td className="right mono hide-sm">{usd(m.openInterestUsd, { compact: true })}</td>
      <td className="right mono hide-sm">{m.maxLeverage}×</td>
      <td className="hide-md mr-spark">{sniping ? <span className="faint small">sniping</span> : <Sparkline candles={candles} decimals={m.priceDecimals} since={now - 24 * 3_600_000} />}</td>
    </tr>
  );
}

/** The coins taking snipe bids right now, soonest open first. */
function SnipingNow({ markets, now }: { markets: MarketView[]; now: number }) {
  const sniping = markets.filter((m) => m.snipe && m.snipe.opensAt > now).sort((a, b) => a.snipe!.opensAt - b.snipe!.opensAt);
  if (sniping.length === 0) return null;
  return (
    <div className="panel side-panel">
      <div className="panel-head">
        <h3>Sniping now</h3>
        <span className="spacer" />
        <span className="faint small">every bid fills at one open price</span>
      </div>
      <ul className="side-list">
        {sniping.slice(0, 4).map((m) => (
          <li key={m.id}>
            <Link to="/trade/$market" params={{ market: m.id }} className="side-row">
              <span>
                <b>{m.id}</b>
                <span className="faint small">
                  {" "}
                  {usd(m.snipe!.total, { compact: true })} · {m.snipe!.snipers} sniper{m.snipe!.snipers === 1 ? "" : "s"}
                </span>
              </span>
              <span className="mono warn">{countdown(m.snipe!.opensAt - now)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The latest bankruptcies and who covered them. */
function RecentPaid({ now }: { now: number }) {
  const feed = useFeed();
  const recent = useMemo(() => incidents(feed.filter((e) => e.kind === "bankrupt" || e.kind === "haircut")).filter((i) => i.bankrupt.length > 0).slice(0, 5), [feed]);
  return (
    <div className="panel side-panel">
      <div className="panel-head">
        <h3>Who paid</h3>
        <span className="spacer" />
        <Link to="/feed" className="small muted">
          All
        </Link>
      </div>
      {recent.length === 0 ? (
        <div className="side-empty faint small">No bankruptcies yet. When one happens, the accounts that covered it are listed here.</div>
      ) : (
        <ul className="side-list">
          {recent.map((i) => {
            const paid = i.haircuts.reduce((s, e) => s + num(e.amount ?? "0"), 0);
            const top = [...i.haircuts].sort((a, b) => num(b.amount ?? "0") - num(a.amount ?? "0"))[0];
            return (
              <li key={i.key}>
                <Link to="/trade/$market" params={{ market: i.market }} className="side-row paid">
                  <span className="paid-what">
                    <b>{i.bankrupt[0]!.accounts[0]}</b> bankrupt on {i.market}
                    <span className="faint small paid-who">
                      {i.haircuts.length > 0 ? `${i.haircuts.length} paid ${usd(paid)}${top ? `, most by ${top.accounts[0]}` : ""}` : "covered by ADL"} · {ago(i.time, now)}
                    </span>
                  </span>
                  <span className="mono down">{usd(i.shortfall)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
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
