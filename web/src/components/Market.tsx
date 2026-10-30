import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { act } from "../queries";
import { compact, countdown, num, pct, price, tone, usd } from "../format";
import { useNow } from "../hooks";
import type { AccountView, MarketView } from "../types";
import { headline } from "./status";
import { Stat, useToast } from "./ui";

const KIND_LABEL: Record<string, string> = { attention: "Creator coins", preipo: "Pre-IPO", perp: "Crypto and equities", binary: "Prediction markets" };

export const change24h = (m: MarketView) => (m.open24h && m.mark ? num(m.mark) / num(m.open24h) - 1 : NaN);

export function MarketPicker({ markets, current, onPick }: { markets: MarketView[]; current: MarketView; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const on = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, []);
  const groups = useMemo(() => {
    const f = markets.filter((m) => (m.id + m.name).toLowerCase().includes(q.toLowerCase()));
    return (["attention", "preipo", "perp", "binary"] as const).map((k) => ({ kind: k, items: f.filter((m) => m.kind === k) })).filter((g) => g.items.length);
  }, [markets, q]);
  return (
    <div className="picker" ref={ref}>
      <button className="picker-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="name">{current.kind === "binary" ? current.name : current.id}</span>
        <span className="faint">▾</span>
      </button>
      {open && (
        <div className="picker-menu">
          <div style={{ padding: 10, display: "flex", gap: 8 }}>
            <input className="input" autoFocus placeholder="Search markets" value={q} onChange={(e) => setQ(e.target.value)} />
            <Link className="btn" to="/" hash="launch" onClick={() => setOpen(false)}>
              + Launch
            </Link>
          </div>
          {groups.map((g) => (
            <div key={g.kind}>
              <div className="group">{KIND_LABEL[g.kind]}</div>
              <table className="grid">
                <tbody>
                  {g.items.map((m) => {
                    const ch = change24h(m);
                    return (
                      <tr
                        key={m.id}
                        className="click"
                        onClick={() => {
                          onPick(m.id);
                          setOpen(false);
                        }}
                      >
                        <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" }}>
                          <b>{m.kind === "binary" ? m.name : m.id}</b>
                          {m.status === "resolved" && <span className="badge info" style={{ marginLeft: 6 }}>resolved</span>}
                        </td>
                        <td className="right mono">{price(headline(m), m.priceDecimals)}</td>
                        <td className={`right mono ${tone(ch)}`}>{pct(ch)}</td>
                        <td className="right mono muted">{m.maxLeverage}×</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function MarketBar({ market, markets, onPick }: { market: MarketView; markets: MarketView[]; onPick: (id: string) => void }) {
  const now = useNow(1000);
  const ch = change24h(market);
  const f = market.funding.ratePerHour;
  return (
    <div className="mbar">
      <MarketPicker markets={markets} current={market} onPick={onPick} />
      <div className="col" style={{ gap: 0 }}>
        <span className="big">{price(headline(market), Math.max(market.priceDecimals, market.mark ? 0 : 6))}</span>
        {!market.mark && market.snipe && <span className="faint small">projected open</span>}
      </div>
      <div className="mbar-stats">
      {market.launch && (
        <>
          <Stat label="Open price" title={`Opened ${new Date(market.launch.openedAt).toLocaleString()}`}>
            {price(market.launch.openPrice, market.priceDecimals)}
          </Stat>
          <Stat label="Launch reserve" title="USDC the snipe pool left in the curve">
            {usd(market.launch.reserve, { compact: true })}
          </Stat>
        </>
      )}
      <Stat label="24h">
        <span className={tone(ch)}>{pct(ch)}</span>
      </Stat>
      <Stat label="Max leverage" title={`Graduation tier ${market.tier}`}>
        {market.maxLeverage}× <span className="faint">tier {market.tier}</span>
      </Stat>
      <Stat label="Funding / h" title="Positive: longs pay shorts. Base rate falls as the market graduates.">
        <span className={f > 0 ? "down" : f < 0 ? "up" : ""}>{(f * 100).toFixed(4)}%</span>
      </Stat>
      <Stat label="Open interest">{usd(market.openInterestUsd, { compact: true })}</Stat>
      <Stat label="24h volume">{usd(market.volume24h, { compact: true })}</Stat>
      <Stat label="ADL rule" title={market.adl === "pnl" ? "Shortfalls are charged pro-rata to opposing profit first (principal protected while profit lasts)" : "Shortfalls are charged pro-rata by opposing position size"}>
        {market.adl === "pnl" ? "capped PnL" : "size pro-rata"}
      </Stat>
      {market.resolvesAt && (
        <Stat label="Resolves in">{countdown(market.resolvesAt - now)}</Stat>
      )}
      {market.heldUntil && market.heldUntil > now && (
        <span className="badge warn" title="An admin override is holding the oracle; the live feed is ignored until it expires">
          oracle held {countdown(market.heldUntil - now)}
        </span>
      )}
      {market.status === "resolved" && <span className="badge info">resolved</span>}
      </div>
    </div>
  );
}

export function InfoPanel({ market }: { market: MarketView }) {
  const g = market.graduation;
  const progress = (a: string, b: string) => Math.min(1, num(a) / Math.max(num(b), 1e-9));
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Market</h3>
        <span className="spacer" />
        <span className="badge">{market.kind}</span>
      </div>
      <div className="panel-body col" style={{ gap: 12 }}>
        {market.kind === "binary" && <div style={{ fontWeight: 600 }}>{market.name}</div>}
        {market.description && <div className="muted" style={{ fontSize: 12 }}>{market.description}</div>}
        <dl className="kv">
          <dt>Oracle</dt>
          <dd style={{ fontFamily: "var(--sans)" }}>{market.url ? <a href={market.url} target="_blank" rel="noreferrer">{market.source.label}</a> : market.source.label}</dd>
          <dt>Maintenance</dt>
          <dd>{(100 / market.maintenanceLeverage).toFixed(1)}% of notional</dd>
          <dt>Base funding</dt>
          <dd>{(market.funding.baseRatePerHour * 100).toFixed(4)}%/h</dd>
          <dt>Positions open</dt>
          <dd>{market.positions}</dd>
          <dt>Open interest</dt>
          <dd>
            {compact(market.openInterest)} {market.base.slice(0, 8)}
          </dd>
          {market.creator && (
            <>
              <dt>Listed by</dt>
              <dd>{market.creator}</dd>
            </>
          )}
        </dl>
        {Math.abs(market.funding.ratePerHour - market.funding.baseRatePerHour) >= 0.005 && (
          <div className="note warn" style={{ fontSize: 11 }}>
            Funding is {(market.funding.ratePerHour * 100).toFixed(2)}%/h because the last trade ({price(market.last, market.priceDecimals)}) is far from the oracle. The premium uses the last trade as the perp price,
            so after a gap a stale print drives funding until someone trades (finding J).
          </div>
        )}
        {g && (
          <div className="col" style={{ gap: 6 }}>
            <div className="label">Leverage graduation</div>
            {g.next ? (
              <>
                <div className="row muted" style={{ fontSize: 12 }}>
                  <span>
                    Next: <b style={{ color: "var(--text)" }}>{g.next.leverage}×</b> needs both
                  </span>
                </div>
                <div className="row" style={{ fontSize: 11 }}>
                  <span className="muted" style={{ width: 52 }}>volume</span>
                  <div className="bar grow">
                    <i style={{ width: `${progress(g.volume, g.next.volume) * 100}%` }} />
                  </div>
                  <span className="mono faint">
                    {compact(g.volume)}/{compact(g.next.volume)}
                  </span>
                </div>
                <div className="row" style={{ fontSize: 11 }}>
                  <span className="muted" style={{ width: 52 }}>depth</span>
                  <div className="bar grow">
                    <i style={{ width: `${progress(g.depth, g.next.depth) * 100}%` }} />
                  </div>
                  <span className="mono faint">
                    {compact(g.depth)}/{compact(g.next.depth)}
                  </span>
                </div>
                <div className="faint" style={{ fontSize: 11 }}>
                  Depth is proxied by open interest{market.curve ? " plus USDC in the curve" : ""}. Tiers never go back down (finding H: leverage outlives the liquidity that earned it).
                </div>
              </>
            ) : (
              <div className="muted">Top tier reached.</div>
            )}
          </div>
        )}
        {market.taper && (
          <div className="col" style={{ gap: 6 }}>
            <div className="label">Pre-resolution taper</div>
            <div className="bar">
              <i style={{ width: `${market.taper.progress * 100}%`, background: "var(--warn)" }} />
            </div>
            <div className="faint" style={{ fontSize: 11 }}>
              Over the last {Math.round(market.taper.seconds / 60)} minutes, margin rises to full collateral against max loss, so nobody is levered into the resolution gap.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function SpotPanel({ market, account, signedIn }: { market: MarketView; account: AccountView | undefined; signedIn: boolean }) {
  const toast = useToast();
  const [usdc, setUsdc] = useState("");
  const [busy, setBusy] = useState(false);
  const c = market.curve!;
  const held = account?.spot.find((s) => s.market === market.id);
  async function run(path: string, body: object, done: string) {
    setBusy(true);
    try {
      await act("POST", path, { market: market.id, ...body });
      toast(done, "up");
      setUsdc("");
    } catch (err) {
      toast((err as Error).message, "down");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>Spot · buy on the curve</h3>
        <span className="spacer" />
        <span className={`badge ${c.oracleWindow === 0 ? "down" : "info"}`}>{c.oracleWindow === 0 ? "instant oracle" : `${c.oracleWindow / 60}m TWAP oracle`}</span>
      </div>
      <div className="panel-body col" style={{ gap: 10 }}>
        <dl className="kv">
          <dt>Spot price</dt>
          <dd>{price(c.price, market.priceDecimals)}</dd>
          <dt>Market cap</dt>
          <dd>{usd(c.marketCap, { compact: true })}</dd>
          <dt>USDC in curve</dt>
          <dd>{usd(c.usdcIn)}</dd>
          <dt>Fee</dt>
          <dd>{(c.feeBps / 100).toFixed(2)}%</dd>
          <dt>You hold</dt>
          <dd>{held ? `${compact(held.tokens)} (${usd(held.value)})` : "—"}</dd>
        </dl>
        <div className="row">
          <input className="input mono" inputMode="decimal" placeholder="USDC" value={usdc} onChange={(e) => setUsdc(e.target.value.trim())} />
          <button className="btn buy" disabled={!signedIn || busy || !(num(usdc) > 0)} onClick={() => run("/api/spot/buy", { usdc }, `Bought ${market.id} with $${usdc}`)}>
            Buy
          </button>
        </div>
        <div className="row" style={{ gap: 4 }}>
          <span className="muted small grow">Sell</span>
          {[0.25, 0.5].map((f) => (
            <button
              key={f}
              className="btn small sell"
              disabled={!signedIn || busy || !held}
              onClick={() => held && run("/api/spot/sell", { tokens: String(Math.floor(num(held.tokens) * f)) }, `Sold ${f * 100}% of ${market.id}`)}
            >
              {f * 100}%
            </button>
          ))}
          <button className="btn small sell" disabled={!signedIn || busy || !held} onClick={() => run("/api/spot/sell", { tokens: "all" }, `Sold all ${market.id}`)}>
            All
          </button>
        </div>
        <div className="faint" style={{ fontSize: 11 }}>
          {c.oracleWindow === 0
            ? "The perp marks to this curve instantly: a spot buy moves the oracle in the same transaction, and buying then selling back costs only fees. That is the pump attack (finding F)."
            : "The perp marks to a time-weighted average of this curve, so a pump only moves the oracle if it's held. A TWAP delays the attack; it doesn't stop it."}
        </div>
      </div>
    </div>
  );
}
