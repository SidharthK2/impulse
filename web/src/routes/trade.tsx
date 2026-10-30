import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AccountPanel } from "../components/AccountPanel";
import { Chart } from "../components/Chart";
import { InfoPanel, MarketBar, SpotPanel } from "../components/Market";
import { OrderBook, Trades } from "../components/OrderBook";
import { OrderForm } from "../components/OrderForm";
import { useAccount, useMarkets } from "../queries";
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
  const byId = useMemo(() => Object.fromEntries(markets.map((m) => [m.id, m])), [markets]);
  const market = byId[id];

  useEffect(() => {
    if (market) setLastMarket(market.id);
  }, [market?.id, setLastMarket]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (market) document.title = `${market.mark ?? ""} ${market.id} · Impulse`;
  }, [market?.mark, market?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!market) return <div className="empty">No market called {id}. Pick one from the markets page.</div>;
  const position = account?.positions.find((p) => p.market === market.id && p.side !== "flat");
  const onPick = (m: string) => void navigate({ to: "/trade/$market", params: { market: m } });
  return (
    <div className="trade" key={market.id}>
      <MarketBar market={market} markets={markets} onPick={onPick} />
      <Chart market={market} position={position} />
      <div className="book-col">
        <OrderBook market={market} onPick={(p) => setPicked({ price: p, n: Date.now() })} />
        <Trades market={market} />
      </div>
      <div className="form-col scroll">
        <OrderForm market={market} account={account} signedIn={signedIn} picked={picked} onSignUp={() => openModal("signup")} />
        {market.curve && <SpotPanel market={market} account={account} signedIn={signedIn} />}
        <InfoPanel market={market} />
      </div>
      <AccountPanel account={account} markets={byId} current={market} signedIn={signedIn} />
    </div>
  );
}
