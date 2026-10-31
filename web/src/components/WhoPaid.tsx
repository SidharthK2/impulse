// Who paid: the feed's liquidations, bankruptcies and ADL haircuts, by account and by incident.

import { useMemo } from "react";
import { ago, num, price, usd } from "../format";
import { useNow } from "../hooks";
import type { AccountView, MarketView, RiskEvent } from "../types";
import { KindBadge } from "./ui";

const LOSS_KINDS = new Set(["liquidation", "bankrupt", "haircut", "adl"]);

/** Events from one engine transaction: same market, same time. A bankruptcy and the haircuts that paid for it. */
export interface Incident {
  key: string;
  market: string;
  time: number;
  price: string | null;
  events: RiskEvent[];
  bankrupt: RiskEvent[];
  haircuts: RiskEvent[];
  liquidations: RiskEvent[];
  closes: RiskEvent[];
  other: RiskEvent[];
  shortfall: number;
}

export function incidents(events: RiskEvent[]): Incident[] {
  const by = new Map<string, Incident>();
  for (const e of events) {
    const key = `${e.market}@${e.time}`;
    let i = by.get(key);
    if (!i) {
      i = {
        key,
        market: e.market,
        time: e.time,
        price: null,
        events: [],
        bankrupt: [],
        haircuts: [],
        liquidations: [],
        closes: [],
        other: [],
        shortfall: 0,
      };
      by.set(key, i);
    }
    i.events.push(e);
    i.price ??= e.price;
    if (e.kind === "bankrupt") {
      i.bankrupt.push(e);
      i.shortfall += num(e.amount ?? "0");
    } else if (e.kind === "haircut") i.haircuts.push(e);
    else if (e.kind === "liquidation") i.liquidations.push(e);
    else if (e.kind === "adl") i.closes.push(e);
    else i.other.push(e);
  }
  return [...by.values()].toSorted((a, b) => b.time - a.time);
}

interface Row {
  account: string;
  liquidations: number;
  bankruptcies: number;
  shortfall: number;
  haircuts: number;
  paid: number;
  closes: number;
}

export function byAccount(events: RiskEvent[]): Row[] {
  const rows = new Map<string, Row>();
  const row = (a: string) => {
    let r = rows.get(a);
    if (!r)
      rows.set(
        a,
        (r = {
          account: a,
          liquidations: 0,
          bankruptcies: 0,
          shortfall: 0,
          haircuts: 0,
          paid: 0,
          closes: 0,
        }),
      );
    return r;
  };
  for (const e of events) {
    const a = e.accounts[0];
    if (!a || !LOSS_KINDS.has(e.kind)) continue;
    const r = row(a);
    if (e.kind === "liquidation") r.liquidations++;
    if (e.kind === "bankrupt") {
      r.bankruptcies++;
      r.shortfall += num(e.amount ?? "0");
    }
    if (e.kind === "haircut") {
      r.haircuts++;
      r.paid += num(e.amount ?? "0");
    }
    if (e.kind === "adl") r.closes++;
  }
  return [...rows.values()].toSorted(
    (a, b) => b.paid - a.paid || b.shortfall - a.shortfall || b.liquidations - a.liquidations,
  );
}

/** One bankruptcy and who covered it, as a compact card (also the chart's marker hover). */
export function IncidentCard({
  incident: i,
  market,
  compact = false,
}: {
  incident: Incident;
  market?: MarketView;
  compact?: boolean;
}) {
  const paid = i.haircuts.reduce((s, e) => s + num(e.amount ?? "0"), 0);
  const d = market?.priceDecimals ?? 4;
  const head = i.bankrupt[0] ?? i.liquidations[0] ?? i.other[0] ?? i.closes[0];
  return (
    <div className={`incident ${compact ? "compact" : ""}`}>
      <div className="incident-head">
        {head && <KindBadge kind={head.kind} />}
        <span className="spacer" />
        {i.price && <span className="mono faint">@ {price(i.price, d)}</span>}
      </div>
      {i.bankrupt.map((e) => (
        <div key={e.id} className="incident-line">
          <b>{e.accounts[0]}</b> went bankrupt, <span className="down mono">{usd(e.amount)}</span>{" "}
          short
        </div>
      ))}
      {i.liquidations.map((e) => (
        <div key={e.id} className="incident-line">
          <b>{e.accounts[0]}</b> liquidated
          {e.amount ? <span className="muted">, kept {usd(e.amount)}</span> : null}
        </div>
      ))}
      {i.haircuts.length > 0 && (
        <div className="payers">
          <div className="label">Paid by</div>
          {i.haircuts.map((e) => {
            const v = num(e.amount ?? "0");
            return (
              <div key={e.id} className="payer">
                <span className="who">{e.accounts[0]}</span>
                <span className="bar grow">
                  <i
                    style={{
                      width: `${paid > 0 ? (v / paid) * 100 : 0}%`,
                      background: "var(--down)",
                    }}
                  />
                </span>
                <span className="mono down">{usd(v)}</span>
              </div>
            );
          })}
        </div>
      )}
      {i.closes.length > 0 && (
        <div className="faint small">
          ADL force-closed: {i.closes.map((e) => e.accounts[0]).join(", ")}
        </div>
      )}
      {i.other.map((e) => (
        <div key={e.id} className="incident-line">
          {e.text}
        </div>
      ))}
    </div>
  );
}

export function WhoPaid({
  market,
  feed,
  account,
}: {
  market: MarketView;
  feed: RiskEvent[];
  account?: AccountView;
}) {
  const now = useNow(5000);
  const events = useMemo(
    () => feed.filter((e) => e.market === market.id && LOSS_KINDS.has(e.kind)),
    [feed, market.id],
  );
  const rows = useMemo(() => byAccount(events), [events]);
  const list = useMemo(() => incidents(events), [events]);
  const total = rows.reduce((s, r) => s + r.shortfall, 0);
  if (events.length === 0)
    return (
      <div className="empty">
        Nobody has been liquidated in {market.id} yet. When someone goes bankrupt, the accounts that
        paid for it show up here.
      </div>
    );
  return (
    <div className="whopaid">
      <div className="whopaid-summary">
        <span>
          Shortfall socialized: <b className="mono down">{usd(total)}</b>
        </span>
        <span>
          Bankruptcies: <b className="mono">{rows.reduce((s, r) => s + r.bankruptcies, 0)}</b>
        </span>
        <span>
          Liquidations: <b className="mono">{rows.reduce((s, r) => s + r.liquidations, 0)}</b>
        </span>
        {account && (
          <span>
            You paid overall: <b className="mono down">{usd(account.ledger.adlPaid)}</b>
          </span>
        )}
      </div>
      <div className="whopaid-grid">
        <table className="grid">
          <thead>
            <tr>
              <th>Account</th>
              <th className="right" title="Liquidated with equity ≥ 0">
                Liq.
              </th>
              <th className="right" title="Shortfall left when this account went bankrupt">
                Bankrupt
              </th>
              <th
                className="right"
                title="ADL haircuts this account paid for other people's shortfalls"
              >
                Paid
              </th>
              <th className="right" title="Positions force-closed by ADL">
                ADL closes
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.account} className={r.account === account?.id ? "me" : ""}>
                <td>
                  {r.account} {r.account === account?.id && <span className="badge up">you</span>}
                </td>
                <td className="right mono">{r.liquidations || "—"}</td>
                <td className="right mono">
                  {r.shortfall > 0 ? <span className="down">{usd(r.shortfall)}</span> : "—"}
                </td>
                <td className="right mono">
                  {r.paid > 0 ? <span className="down">{usd(r.paid)}</span> : "—"}
                </td>
                <td className="right mono">{r.closes || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="incidents">
          {list.map((i) => (
            <div key={i.key} className="incident-wrap">
              <div className="faint small">{ago(i.time, now)}</div>
              <IncidentCard incident={i} market={market} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
