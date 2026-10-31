import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AccountPanel } from "../components/AccountPanel";
import { Chart } from "../components/Chart";
import { InfoPanel, MarketBar, SpotPanel } from "../components/Market";
import { BookPanel, OrderBook, Trades } from "../components/OrderBook";
import { OrderForm } from "../components/OrderForm";
import { PreIpoPanel } from "../components/PreIpo";
import { Sheet } from "../components/Sheet";
import { LaunchPanel, SnipePanel } from "../components/Snipe";
import { useMediaQuery } from "../hooks";
import { useAccount, useMarkets } from "../queries";
import type { AccountView, MarketView, PositionView } from "../types";
import { useCanTrade, usePrefs, useUi } from "../store";

export function TradePage() {
  const { market: id } = useParams({ from: "/trade/$market" });
  const navigate = useNavigate();
  const markets = useMarkets() ?? [];
  const account = useAccount();
  const signedIn = useCanTrade();
  const openModal = useUi((s) => s.open);
  const setLastMarket = usePrefs((s) => s.setLastMarket);
  const [picked, setPicked] = useState<{ price: string; n: number } | null>(null);
  const phone = useMediaQuery("(max-width: 760px)");
  const byId = useMemo(() => Object.fromEntries(markets.map((m) => [m.id, m])), [markets]);
  const market = byId[id];

  useEffect(() => {
    if (market) setLastMarket(market.id);
  }, [market?.id, setLastMarket]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (market) document.title = `${market.mark ?? ""} ${market.id} · Impulse`;
  }, [market?.mark, market?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!market)
    return <div className="empty">No market called {id}. Pick one from the markets page.</div>;
  const position = account?.positions.find((p) => p.market === market.id && p.side !== "flat");
  // Until the snipe opens there is no price, book or perp: the snipe panel takes the chart's place.
  const sniping = !!market.snipe;
  const onPick = (m: string) => void navigate({ to: "/trade/$market", params: { market: m } });
  if (phone)
    return (
      <PhoneTrade
        key={market.id}
        market={market}
        markets={markets}
        byId={byId}
        account={account}
        position={position}
        signedIn={signedIn}
        onPick={onPick}
        onSignUp={() => openModal("signup")}
      />
    );
  return (
    <div className="trade" key={market.id}>
      <MarketBar market={market} markets={markets} onPick={onPick} />
      {sniping ? (
        <SnipePanel
          market={market}
          account={account}
          canTrade={signedIn}
          onSignUp={() => openModal("signup")}
        />
      ) : (
        <Chart market={market} position={position} />
      )}
      <div className="book-col">
        {sniping ? (
          <div className="panel grow">
            <div className="empty">
              The book and the perp open with the coin. Until then, every bid waits in the snipe
              pool.
            </div>
          </div>
        ) : (
          <>
            <BookPanel market={market} onPick={(p) => setPicked({ price: p, n: Date.now() })} />
          </>
        )}
      </div>
      <div className="form-col scroll">
        {!sniping && (
          <OrderForm
            market={market}
            account={account}
            signedIn={signedIn}
            picked={picked}
            onSignUp={() => openModal("signup")}
          />
        )}
        {!sniping && market.curve && (
          <SpotPanel market={market} account={account} signedIn={signedIn} />
        )}
        {market.launch && <LaunchPanel market={market} />}
        {market.preipo && <PreIpoPanel market={market} />}
        <InfoPanel market={market} />
      </div>
      <AccountPanel account={account} markets={byId} current={market} signedIn={signedIn} />
    </div>
  );
}

type Pane = "chart" | "book" | "trades" | "info";

/**
 * Phones: one pane at a time (chart, book, trades, info) under the market bar, positions below, and a sticky
 * Long / Short bar that opens the order form in a bottom sheet. Tapping a price in the book opens the sheet on a
 * limit order at that price.
 */
function PhoneTrade(props: {
  market: MarketView;
  markets: MarketView[];
  byId: Record<string, MarketView>;
  account: AccountView | undefined;
  position: PositionView | undefined;
  signedIn: boolean;
  onPick: (id: string) => void;
  onSignUp: () => void;
}) {
  const { market, markets, byId, account, position, signedIn, onPick, onSignUp } = props;
  const [pane, setPane] = useState<Pane>("chart");
  const [sheet, setSheet] = useState<{ side: "buy" | "sell"; kind: "perp" | "spot" } | null>(null);
  const [picked, setPicked] = useState<{ price: string; n: number } | null>(null);
  const sniping = !!market.snipe;
  const panes: [Pane, string][] = [
    ["chart", sniping ? "Snipe" : "Chart"],
    ["book", "Book"],
    ["trades", "Trades"],
    ["info", "Info"],
  ];
  return (
    <div className="trade-m">
      <MarketBar market={market} markets={markets} onPick={onPick} />
      <div className="m-tabs" role="tablist">
        {panes.map(([id, label]) => (
          <button
            type="button"
            key={id}
            role="tab"
            aria-selected={pane === id}
            className={pane === id ? "on" : ""}
            onClick={() => setPane(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className={`m-pane m-pane-${pane}`}>
        {pane === "chart" &&
          (sniping ? (
            <SnipePanel market={market} account={account} canTrade={signedIn} onSignUp={onSignUp} />
          ) : (
            <Chart market={market} position={position} />
          ))}
        {pane === "book" &&
          (sniping ? (
            <div className="empty">
              The book opens with the coin. Until then, every bid waits in the snipe pool.
            </div>
          ) : (
            <OrderBook
              market={market}
              onPick={(p) => {
                setPicked({ price: p, n: Date.now() });
                setSheet({ side: "buy", kind: "perp" });
              }}
            />
          ))}
        {pane === "trades" && <Trades market={market} />}
        {pane === "info" && (
          <div className="m-info">
            {market.launch && <LaunchPanel market={market} />}
            {market.preipo && <PreIpoPanel market={market} />}
            <InfoPanel market={market} />
          </div>
        )}
      </div>
      <AccountPanel account={account} markets={byId} current={market} signedIn={signedIn} />

      {!sniping && market.status === "open" && (
        <div className="m-actions">
          <button
            type="button"
            className="btn buy"
            onClick={() => (signedIn ? setSheet({ side: "buy", kind: "perp" }) : onSignUp())}
          >
            Long
          </button>
          <button
            type="button"
            className="btn sell"
            onClick={() => (signedIn ? setSheet({ side: "sell", kind: "perp" }) : onSignUp())}
          >
            Short
          </button>
        </div>
      )}

      {sheet && (
        <Sheet
          title={`${market.id} · ${sheet.kind === "spot" ? "spot" : "perp"}`}
          onClose={() => (setSheet(null), setPicked(null))}
        >
          {market.curve && (
            <div className="seg sheet-switch">
              <button
                type="button"
                className={sheet.kind === "perp" ? "on" : ""}
                onClick={() => setSheet({ ...sheet, kind: "perp" })}
              >
                Perp
              </button>
              <button
                type="button"
                className={sheet.kind === "spot" ? "on" : ""}
                onClick={() => setSheet({ ...sheet, kind: "spot" })}
              >
                Spot
              </button>
            </div>
          )}
          {sheet.kind === "perp" ? (
            <OrderForm
              market={market}
              account={account}
              signedIn={signedIn}
              picked={picked}
              onSignUp={onSignUp}
              initialSide={sheet.side}
              onDone={() => setSheet(null)}
            />
          ) : (
            <SpotPanel market={market} account={account} signedIn={signedIn} />
          )}
        </Sheet>
      )}
    </div>
  );
}
