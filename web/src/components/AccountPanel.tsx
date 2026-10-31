import { Link } from "@tanstack/react-router";
import { useForm, useSelector } from "@tanstack/react-form";
import { Fragment, useEffect, useState } from "react";
import { api } from "../api";
import { isFixtureMarket } from "../fixtures";
import { clock, num, price, size, tone, usd } from "../format";
import { useMediaQuery } from "../hooks";
import { act, useFeed } from "../queries";
import type { AccountView, MarketView, PositionView } from "../types";
import { useToast } from "./ui";
import { FieldError, FormError, invalid, positive, useServerError } from "./form";
import { RiskList } from "./RiskFeed";
import { Roll } from "./Roll";
import { WhoPaid } from "./WhoPaid";

type Tab = "positions" | "orders" | "fills" | "whopaid" | "holders";

interface Props {
  account: AccountView | undefined;
  markets: Record<string, MarketView>;
  /** The market on screen. Without one (the portfolio), Who paid is the account's own risk history. */
  current?: MarketView;
  signedIn: boolean;
}

export function AccountPanel({ account, markets, current, signedIn }: Props) {
  const [tab, setTab] = useState<Tab>("positions");
  const feed = useFeed();
  const open = account?.positions.filter((p) => p.side !== "flat") ?? [];
  const incidents = current
    ? feed.filter(
        (e) => e.market === current.id && (e.kind === "bankrupt" || e.kind === "liquidation"),
      ).length
    : (account?.risk.length ?? 0);
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "positions", label: "Positions", count: open.length + (account?.spot.length ?? 0) },
    { id: "orders", label: "Open orders", count: account?.orders.length },
    { id: "fills", label: "Fills" },
    { id: "whopaid", label: "Who paid", count: incidents },
    ...(current ? [{ id: "holders" as const, label: "Holders" }] : []),
  ];
  return (
    <div className="panel account-panel" style={{ minHeight: 260 }}>
      <div className="panel-head">
        <div className="tabs">
          {tabs.map((t) => (
            <button
              type="button"
              key={t.id}
              className={tab === t.id ? "on" : ""}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.count ? <span className="count">{t.count}</span> : null}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {tab === "orders" && account && account.orders.length > 0 && <CancelAll />}
      </div>
      <div className="scroll" style={{ flex: 1, maxHeight: 420 }}>
        {tab === "whopaid" && current ? (
          <WhoPaid market={current} feed={feed} account={account} />
        ) : tab === "holders" && current ? (
          <Holders market={current} />
        ) : !signedIn ? (
          <div className="empty">Sign up to get $10,000 of paper USDC and start trading.</div>
        ) : !account ? (
          <div className="empty">Loading…</div>
        ) : tab === "positions" ? (
          <Positions account={account} markets={markets} />
        ) : tab === "whopaid" ? (
          <AccountRisk account={account} />
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
      type="button"
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

function Positions({
  account,
  markets,
}: {
  account: AccountView;
  markets: Record<string, MarketView>;
}) {
  const toast = useToast();
  const [marginFor, setMarginFor] = useState<string | null>(null);
  const phone = useMediaQuery("(max-width: 760px)");
  const open = account.positions.filter((p) => p.side !== "flat");
  if (open.length === 0 && account.spot.length === 0)
    return <div className="empty">No open positions.</div>;

  const close = (p: PositionView) =>
    act<{ status: string; reason: string | null }>("POST", "/api/positions/close", {
      market: p.market,
    })
      .then((r) =>
        toast(
          r.status === "filled" ? `Closed ${p.market}` : `Close ${r.status}: ${r.reason ?? ""}`,
          r.status === "filled" ? "up" : "warn",
        ),
      )
      .catch((e) => toast((e as Error).message, "down"));

  // Phones: one card per position instead of a twelve-column table.
  if (phone)
    return (
      <div className="pos-cards">
        {open.map((p) => {
          const m = markets[p.market];
          const d = m?.priceDecimals ?? 4;
          return (
            <div key={p.market} className="pos-card">
              <div className="pos-card-head">
                <Link to="/trade/$market" params={{ market: p.market }}>
                  <b>{p.market}</b>
                </Link>
                <span className={`badge ${p.side === "long" ? "up" : "down"}`}>
                  {p.side} {p.leverage ? `${p.leverage.toFixed(1)}×` : ""}
                </span>
                <span className="spacer" />
                <Roll
                  className={`mono ${tone(num(p.pnl))}`}
                  text={usd(p.pnl, { sign: true })}
                  value={num(p.pnl)}
                />
              </div>
              <dl className="pos-card-figs">
                <div>
                  <dt>Size</dt>
                  <dd>{size(p.size, m?.szDecimals ?? 4)}</dd>
                </div>
                <div>
                  <dt>Entry</dt>
                  <dd>{price(p.entry, d)}</dd>
                </div>
                <div>
                  <dt>Mark</dt>
                  <dd>{price(p.mark, d)}</dd>
                </div>
                <div>
                  <dt>Liq.</dt>
                  <dd className="warn">
                    {p.liquidationPrice ? price(p.liquidationPrice, d) : "—"}
                  </dd>
                </div>
                <div>
                  <dt>Margin</dt>
                  <dd>{usd(p.collateral)}</dd>
                </div>
                <div>
                  <dt>Funding</dt>
                  <dd className={tone(num(p.funding))}>{usd(p.funding, { sign: true })}</dd>
                </div>
              </dl>
              <div className="pos-card-actions">
                <button
                  type="button"
                  className="btn small"
                  onClick={() => setMarginFor(marginFor === p.market ? null : p.market)}
                >
                  Margin
                </button>
                <button type="button" className="btn small danger" onClick={() => close(p)}>
                  Close
                </button>
              </div>
              {marginFor === p.market && (
                <MarginForm
                  position={p}
                  wallet={account.wallet}
                  onDone={() => setMarginFor(null)}
                />
              )}
            </div>
          );
        })}
        {account.spot.map((s) => (
          <div key={`spot-${s.market}`} className="pos-card">
            <div className="pos-card-head">
              <Link to="/trade/$market" params={{ market: s.market }}>
                <b>{s.market}</b>
              </Link>
              <span className="badge info">spot</span>
              <span className="spacer" />
              <span className="mono">{usd(s.value)}</span>
            </div>
            <dl className="pos-card-figs">
              <div>
                <dt>Tokens</dt>
                <dd>{size(s.tokens, 0)}</dd>
              </div>
              <div>
                <dt>Price</dt>
                <dd>{price(s.price, markets[s.market]?.priceDecimals ?? 9)}</dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
    );

  return (
    <table className="grid">
      <thead>
        <tr>
          <th>Market</th>
          <th className="right">Size</th>
          <th className="right">Entry</th>
          <th className="right">Mark</th>
          <th className="right" title="Approximate price where equity hits maintenance margin">
            Liq.
          </th>
          <th className="right">Margin</th>
          <th className="right">Unrealized</th>
          <th className="right" title="Funding paid (−) or received (+)">
            Funding
          </th>
          <th
            className="right"
            title="ADL transfers: − haircuts you paid for someone else's shortfall, + shortfall covered for you"
          >
            ADL
          </th>
          <th
            className="right"
            title="Equity minus net margin posted: trading, funding and ADL together"
          >
            Total PnL
          </th>
          <th className="right">Lev.</th>
          <th>
            <span className="sr-only">Actions</span>
          </th>
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
                <td className="right mono warn">
                  {p.liquidationPrice ? price(p.liquidationPrice, d) : "—"}
                </td>
                <td className="right mono">{usd(p.collateral)}</td>
                <td className={`right mono ${tone(num(p.unrealized))}`}>
                  <Roll text={usd(p.unrealized, { sign: true })} value={num(p.unrealized)} />
                </td>
                <td className={`right mono ${tone(num(p.funding))}`}>
                  {usd(p.funding, { sign: true })}
                </td>
                <td className={`right mono ${tone(num(p.adl))}`}>
                  {num(p.adl) === 0 ? "—" : usd(p.adl, { sign: true })}
                </td>
                <td className={`right mono ${tone(num(p.pnl))}`}>
                  <Roll text={usd(p.pnl, { sign: true })} value={num(p.pnl)} />
                </td>
                <td className="right mono">{p.leverage ? `${p.leverage.toFixed(1)}×` : "—"}</td>
                <td className="right">
                  <div className="row" style={{ justifyContent: "flex-end", gap: 4 }}>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => setMarginFor(marginFor === p.market ? null : p.market)}
                    >
                      Margin
                    </button>
                    <button type="button" className="btn small danger" onClick={() => close(p)}>
                      Close
                    </button>
                  </div>
                </td>
              </tr>
              {marginFor === p.market && (
                <tr>
                  <td colSpan={12}>
                    <MarginForm
                      position={p}
                      wallet={account.wallet}
                      onDone={() => setMarginFor(null)}
                    />
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

/** The account's own side of ADL: what it paid for others, what others covered for it, and its risk events. */
function AccountRisk({ account }: { account: AccountView }) {
  const l = account.ledger;
  return (
    <div>
      <div className="whopaid-summary">
        <span title="ADL haircuts: your profit (or principal) used to cover someone else's negative equity">
          Haircuts you paid: <b className="mono down">{usd(l.adlPaid)}</b>
        </span>
        <span>
          Your shortfalls others covered: <b className="mono up">{usd(l.adlCovered)}</b>
        </span>
        <span>
          Net funding:{" "}
          <b className={`mono ${tone(num(l.funding))}`}>{usd(l.funding, { sign: true })}</b>
        </span>
        <span>
          Realized trading PnL:{" "}
          <b className={`mono ${tone(num(l.realized))}`}>{usd(l.realized, { sign: true })}</b>
        </span>
      </div>
      <RiskList events={account.risk} />
    </div>
  );
}

/** Add or remove isolated margin. The button pressed sets `dir`, which the amount is checked against. */
function MarginForm({
  position: p,
  wallet,
  onDone,
}: {
  position: PositionView;
  wallet: string;
  onDone: () => void;
}) {
  const toast = useToast();
  const server = useServerError();
  const form = useForm({
    defaultValues: { amount: "", dir: "add" as "add" | "remove" },
    onSubmit: async ({ value }) => {
      server.clear();
      try {
        await act("POST", "/api/margin", {
          market: p.market,
          amount: `${value.dir === "remove" ? "-" : ""}${value.amount}`,
        });
        toast(
          `${value.dir === "add" ? "Added" : "Removed"} $${value.amount} margin on ${p.market}`,
          "up",
        );
        onDone();
      } catch (e) {
        server.fail(e);
      }
    },
  });
  const pending = useSelector(form.store, (s) => s.isSubmitting);
  return (
    <form
      className="margin-form"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void form.handleSubmit();
      }}
    >
      <span className="muted">
        Isolated margin: {usd(p.collateral)}, removable {usd(p.releasable)}
      </span>
      <form.Field
        name="amount"
        validators={{
          onChangeListenTo: ["dir"],
          onChange: ({ value, fieldApi }) => {
            const bad = positive(value, "Amount");
            if (bad) return bad;
            if (fieldApi.form.getFieldValue("dir") === "remove" && num(value) > num(p.releasable))
              return `At most ${usd(p.releasable)} can be removed`;
            if (fieldApi.form.getFieldValue("dir") === "add" && num(value) > num(wallet))
              return `More than your wallet (${usd(wallet)})`;
            return undefined;
          },
        }}
      >
        {(f) => (
          <div className="col" style={{ gap: 2 }}>
            <input
              className={`input mono ${invalid(f) ? "bad" : ""}`}
              style={{ width: 120 }}
              placeholder="USD"
              inputMode="decimal"
              value={f.state.value}
              onChange={(e) => f.handleChange(e.target.value.trim())}
              onBlur={f.handleBlur}
              aria-label="Margin amount in USD"
              aria-invalid={invalid(f)}
            />
            <FieldError field={f} />
          </div>
        )}
      </form.Field>
      <button
        type="submit"
        className="btn small"
        disabled={pending}
        onClick={() => form.setFieldValue("dir", "add")}
      >
        Add
      </button>
      <button
        type="submit"
        className="btn small"
        disabled={pending}
        onClick={() => form.setFieldValue("dir", "remove")}
      >
        Remove
      </button>
      <FormError error={server.error} />
    </form>
  );
}

function Orders({
  account,
  markets,
}: {
  account: AccountView;
  markets: Record<string, MarketView>;
}) {
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
          <th>
            <span className="sr-only">Actions</span>
          </th>
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
                {o.reduceOnly && (
                  <span className="badge" style={{ marginLeft: 6 }}>
                    reduce
                  </span>
                )}
                {o.tif === "alo" && (
                  <span className="badge" style={{ marginLeft: 6 }}>
                    post
                  </span>
                )}
              </td>
              <td className="right mono">{price(o.price, m?.priceDecimals ?? 4)}</td>
              <td className="right mono">{size(o.size, m?.szDecimals ?? 4)}</td>
              <td className="right mono muted">{size(o.filled, m?.szDecimals ?? 4)}</td>
              <td className="right mono">{o.leverage}×</td>
              <td className="right">
                <button
                  type="button"
                  className="btn small"
                  onClick={() =>
                    api("DELETE", `/api/orders/${o.id}`).catch((e) =>
                      toast((e as Error).message, "down"),
                    )
                  }
                >
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

function Fills({
  account,
  markets,
}: {
  account: AccountView;
  markets: Record<string, MarketView>;
}) {
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
                {f.kind === "spot" && (
                  <span className="badge info" style={{ marginLeft: 6 }}>
                    spot
                  </span>
                )}
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
  const sorted = positions.toSorted((a, b) => Math.abs(num(b.size)) - Math.abs(num(a.size)));
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
                <td className={`right mono ${tone(num(p.size))}`}>
                  {size(p.size, market.szDecimals)}
                </td>
                <td className="right mono">{usd(p.collateral)}</td>
                <td className={`right mono ${tone(num(p.adl))}`}>
                  {num(p.adl) === 0 ? "—" : usd(p.adl, { sign: true })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="empty">No open positions in {market.id}.</div>}
      </div>
    </div>
  );
}
