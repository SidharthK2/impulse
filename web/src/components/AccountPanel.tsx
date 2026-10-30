import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { isFixtureMarket } from "../fixtures";
import { clock, num, price, size, tone, usd } from "../format";
import { act, useFeed } from "../queries";
import type { AccountView, MarketView, PositionView } from "../types";
import { useToast } from "./ui";
import { Roll } from "./Roll";
import { WhoPaid } from "./WhoPaid";

type Tab = "positions" | "orders" | "fills" | "whopaid" | "holders";

interface Props {
  account: AccountView | undefined;
  markets: Record<string, MarketView>;
  current: MarketView;
  signedIn: boolean;
}

export function AccountPanel({ account, markets, current, signedIn }: Props) {
  const [tab, setTab] = useState<Tab>("positions");
  const feed = useFeed();
  const open = account?.positions.filter((p) => p.side !== "flat") ?? [];
  const incidents = feed.filter((e) => e.market === current.id && (e.kind === "bankrupt" || e.kind === "liquidation")).length;
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "positions", label: "Positions", count: open.length + (account?.spot.length ?? 0) },
    { id: "orders", label: "Open orders", count: account?.orders.length },
    { id: "fills", label: "Fills" },
    { id: "whopaid", label: "Who paid", count: incidents },
    { id: "holders", label: "Holders" },
  ];
  return (
    <div className="panel account-panel" style={{ minHeight: 260 }}>
      <div className="panel-head">
        <div className="tabs">
          {tabs.map((t) => (
            <button key={t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)}>
              {t.label}
              {t.count ? <span className="count">{t.count}</span> : null}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {tab === "orders" && account && account.orders.length > 0 && <CancelAll />}
      </div>
      <div className="scroll" style={{ flex: 1, maxHeight: 420 }}>
        {tab === "whopaid" ? (
          <WhoPaid market={current} feed={feed} account={account} />
        ) : tab === "holders" ? (
          <Holders market={current} />
        ) : !signedIn ? (
          <div className="empty">Sign up to get $10,000 of paper USDC and start trading.</div>
        ) : !account ? (
          <div className="empty">Loading…</div>
        ) : tab === "positions" ? (
          <Positions account={account} markets={markets} />
        ) : tab === "orders" ? (
          <Orders account={account} markets={markets} />
        ) : (
          <Fills account={account} markets={markets} />
        )}
      </div>
    </div>
  );
}

function CancelAll() {
  const toast = useToast();
  return (
    <button
      className="btn small"
      onClick={() =>
        api<{ cancelled: number }>("POST", "/api/orders/cancel-all", {})
          .then((r) => toast(`Cancelled ${r.cancelled} order${r.cancelled === 1 ? "" : "s"}`))
          .catch((e) => toast((e as Error).message, "down"))
      }
    >
      Cancel all
    </button>
  );
}

function Positions({ account, markets }: { account: AccountView; markets: Record<string, MarketView> }) {
  const toast = useToast();
  const [marginFor, setMarginFor] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const open = account.positions.filter((p) => p.side !== "flat");
  if (open.length === 0 && account.spot.length === 0) return <div className="empty">No open positions.</div>;

  const close = (p: PositionView) =>
    act<{ status: string; reason: string | null }>("POST", "/api/positions/close", { market: p.market })
      .then((r) => toast(r.status === "filled" ? `Closed ${p.market}` : `Close ${r.status}: ${r.reason ?? ""}`, r.status === "filled" ? "up" : "warn"))
      .catch((e) => toast((e as Error).message, "down"));
  const margin = (p: PositionView, sign: 1 | -1) =>
    act("POST", "/api/margin", { market: p.market, amount: `${sign < 0 ? "-" : ""}${amount}` })
      .then(() => {
        toast(`${sign > 0 ? "Added" : "Removed"} $${amount} margin on ${p.market}`, "up");
        setAmount("");
        setMarginFor(null);
      })
      .catch((e) => toast((e as Error).message, "down"));

  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Market</th>
          <th className="right">Size</th>
          <th className="right">Entry</th>
          <th className="right">Mark</th>
          <th className="right" title="Approximate price where equity hits maintenance margin">Liq.</th>
          <th className="right">Margin</th>
          <th className="right">Unrealized</th>
          <th className="right" title="Funding paid (−) or received (+)">Funding</th>
          <th className="right" title="ADL transfers: − haircuts you paid for someone else's shortfall, + shortfall covered for you">ADL</th>
          <th className="right" title="Equity minus net margin posted: trading, funding and ADL together">Total PnL</th>
          <th className="right">Lev.</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {open.map((p) => {
          const m = markets[p.market];
          const d = m?.priceDecimals ?? 4;
          return (
            <Fragment key={p.market}>
              <tr>
                <td>
                  <Link to="/trade/$market" params={{ market: p.market }}>
                    {p.market}
                  </Link>{" "}
                  <span className={`badge ${p.side === "long" ? "up" : "down"}`}>{p.side}</span>
                </td>
                <td className="right mono">{size(p.size, m?.szDecimals ?? 4)}</td>
                <td className="right mono">{price(p.entry, d)}</td>
                <td className="right mono">{price(p.mark, d)}</td>
                <td className="right mono warn">{p.liquidationPrice ? price(p.liquidationPrice, d) : "—"}</td>
                <td className="right mono">{usd(p.collateral)}</td>
                <td className={`right mono ${tone(num(p.unrealized))}`}>
                  <Roll text={usd(p.unrealized, { sign: true })} value={num(p.unrealized)} />
                </td>
                <td className={`right mono ${tone(num(p.funding))}`}>{usd(p.funding, { sign: true })}</td>
                <td className={`right mono ${tone(num(p.adl))}`}>{num(p.adl) === 0 ? "—" : usd(p.adl, { sign: true })}</td>
                <td className={`right mono ${tone(num(p.pnl))}`}>
                  <Roll text={usd(p.pnl, { sign: true })} value={num(p.pnl)} />
                </td>
                <td className="right mono">{p.leverage ? `${p.leverage.toFixed(1)}×` : "—"}</td>
                <td className="right">
                  <div className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                    <button className="btn small" onClick={() => setMarginFor(marginFor === p.market ? null : p.market)}>
                      Margin
                    </button>
                    <button className="btn small danger" onClick={() => close(p)}>
                      Close
                    </button>
                  </div>
                </td>
              </tr>
              {marginFor === p.market && (
                <tr>
                  <td colSpan={12}>
                    <div className="row" style={{ maxWidth: 520 }}>
                      <span className="muted">Isolated margin: {usd(p.collateral)}, removable {usd(p.releasable)}</span>
                      <input className="input mono" style={{ width: 120 }} placeholder="USD" value={amount} onChange={(e) => setAmount(e.target.value.trim())} />
                      <button className="btn small" disabled={!(num(amount) > 0)} onClick={() => margin(p, 1)}>
                        Add
                      </button>
                      <button className="btn small" disabled={!(num(amount) > 0)} onClick={() => margin(p, -1)}>
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
        {account.spot.map((s) => (
          <tr key={`spot-${s.market}`}>
            <td>
              <Link to="/trade/$market" params={{ market: s.market }}>
                {s.market}
              </Link>{" "}
              <span className="badge info">spot</span>
            </td>
            <td className="right mono">{size(s.tokens, 0)}</td>
            <td />
            <td className="right mono">{price(s.price, markets[s.market]?.priceDecimals ?? 9)}</td>
            <td />
            <td className="right mono">{usd(s.value)}</td>
            <td colSpan={6} />
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Orders({ account, markets }: { account: AccountView; markets: Record<string, MarketView> }) {
  const toast = useToast();
  if (account.orders.length === 0) return <div className="empty">No open orders.</div>;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Time</th>
          <th>Market</th>
          <th>Side</th>
          <th className="right">Price</th>
          <th className="right">Size</th>
          <th className="right">Filled</th>
          <th className="right">Lev.</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {account.orders.map((o) => {
          const m = markets[o.market];
          return (
            <tr key={o.id}>
              <td className="mono faint">{clock(o.time)}</td>
              <td>{o.market}</td>
              <td className={o.side === "buy" ? "up" : "down"}>
                {o.side}
                {o.reduceOnly && <span className="badge" style={{ marginLeft: 6 }}>reduce</span>}
                {o.tif === "alo" && <span className="badge" style={{ marginLeft: 6 }}>post</span>}
              </td>
              <td className="right mono">{price(o.price, m?.priceDecimals ?? 4)}</td>
              <td className="right mono">{size(o.size, m?.szDecimals ?? 4)}</td>
              <td className="right mono muted">{size(o.filled, m?.szDecimals ?? 4)}</td>
              <td className="right mono">{o.leverage}×</td>
              <td className="right">
                <button className="btn small" onClick={() => api("DELETE", `/api/orders/${o.id}`).catch((e) => toast((e as Error).message, "down"))}>
                  Cancel
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Fills({ account, markets }: { account: AccountView; markets: Record<string, MarketView> }) {
  if (account.fills.length === 0) return <div className="empty">No fills yet.</div>;
  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Time</th>
          <th>Market</th>
          <th>Side</th>
          <th className="right">Price</th>
          <th className="right">Size</th>
          <th className="right">Notional</th>
          <th>Role</th>
          <th>Counterparty</th>
        </tr>
      </thead>
      <tbody>
        {account.fills.map((f) => {
          const m = markets[f.market];
          return (
            <tr key={f.id}>
              <td className="mono faint">{clock(f.time)}</td>
              <td>
                {f.market}
                {f.kind === "spot" && <span className="badge info" style={{ marginLeft: 6 }}>spot</span>}
              </td>
              <td className={f.mySide === "buy" ? "up" : "down"}>{f.mySide}</td>
              <td className="right mono">{price(f.price, m?.priceDecimals ?? 4)}</td>
              <td className="right mono">{size(f.size, m?.szDecimals ?? 4)}</td>
              <td className="right mono">{usd(f.notional)}</td>
              <td className="muted">{f.liquidity}</td>
              <td className="muted">{f.taker === account.id ? f.maker : f.taker}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface PublicPosition {
  account: string;
  size: string;
  collateral: string;
  adl: string;
}

/** The whole market is public: who holds what, so who would absorb the next shortfall. */
function Holders({ market }: { market: MarketView }) {
  const [positions, setPositions] = useState<PublicPosition[]>([]);
  useEffect(() => {
    let alive = true;
    if (isFixtureMarket(market.id)) {
      setPositions([]);
      return;
    }
    const load = () =>
      api<PublicPosition[]>("GET", `/api/markets/${encodeURIComponent(market.id)}/positions`)
        .then((p) => alive && setPositions(p))
        .catch(() => {});
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [market.id]);
  const sorted = [...positions].sort((a, b) => Math.abs(num(b.size)) - Math.abs(num(a.size)));
  return (
    <div>
      <div>
        <table className="grid">
          <thead>
            <tr>
              <th>Holder</th>
              <th className="right">Size</th>
              <th className="right">Collateral</th>
              <th className="right">ADL ±</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((p) => (
              <tr key={p.account}>
                <td>{p.account}</td>
                <td className={`right mono ${tone(num(p.size))}`}>{size(p.size, market.szDecimals)}</td>
                <td className="right mono">{usd(p.collateral)}</td>
                <td className={`right mono ${tone(num(p.adl))}`}>{num(p.adl) === 0 ? "—" : usd(p.adl, { sign: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="empty">No open positions in {market.id}.</div>}
      </div>
    </div>
  );
}
