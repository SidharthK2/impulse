import { AccountPanel } from "../components/AccountPanel";
import { useMemo } from "react";
import { num, tone, usd } from "../format";
import { useAccount, useMarkets } from "../queries";
import { useCanTrade, useUi } from "../store";

export function PortfolioPage() {
  const account = useAccount();
  const markets = useMarkets() ?? [];
  const signedIn = useCanTrade();
  const open = useUi((s) => s.open);
  const byId = useMemo(() => Object.fromEntries(markets.map((m) => [m.id, m])), [markets]);
  if (!signedIn)
    return (
      <div className="page">
        <h1>Portfolio</h1>
        <p className="lead">Sign up to get $10,000 of paper USDC.</p>
        <button className="btn primary" onClick={() => open("signup")}>
          Sign up
        </button>
      </div>
    );
  return (
    <div className="page wide">
      <h1>Portfolio</h1>
      {account && (
        <div className="cards">
          <div className="card">
            <span className="label">Equity</span>
            <span className="v">{usd(account.equity)}</span>
          </div>
          <div className="card">
            <span className="label">Total PnL</span>
            <span className={`v ${tone(num(account.pnl))}`}>
              {usd(account.pnl, { sign: true })}
            </span>
          </div>
          <div className="card">
            <span className="label">Wallet</span>
            <span className="v">{usd(account.wallet)}</span>
          </div>
          <div className="card">
            <span className="label">ADL haircuts you paid</span>
            <span className="v down">{usd(account.ledger.adlPaid)}</span>
          </div>
        </div>
      )}
      <AccountPanel account={account} markets={byId} signedIn={signedIn} />
    </div>
  );
}
