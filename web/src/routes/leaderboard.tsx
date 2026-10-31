import { num, tone, usd } from "../format";
import { useAccount, useLeaderboard } from "../queries";

// ---------- leaderboard ----------

export function LeaderboardPage() {
  const me = useAccount()?.id;
  const rows = useLeaderboard();
  return (
    <div className="page">
      <h1>Leaderboard</h1>
      <p className="lead">
        Total PnL since sign-up, marked to the oracle. The haircuts column is how much of each
        account's profit (or principal) went to cover other people's bankruptcies.
      </p>
      <div className="panel x-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>#</th>
              <th>Account</th>
              <th className="right">Equity</th>
              <th className="right">PnL</th>
              <th className="right">ADL haircuts paid</th>
              <th className="right">Open positions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id} style={r.id === me ? { background: "var(--panel-2)" } : undefined}>
                <td className="muted">{i + 1}</td>
                <td>
                  {r.id} {r.bot && <span className="badge">bot</span>}{" "}
                  {r.id === me && <span className="badge up">you</span>}
                </td>
                <td className="right mono">{usd(r.equity)}</td>
                <td className={`right mono ${tone(num(r.pnl))}`}>{usd(r.pnl, { sign: true })}</td>
                <td className="right mono">
                  {num(r.haircuts) > 0 ? <span className="down">{usd(r.haircuts)}</span> : "—"}
                </td>
                <td className="right mono">{r.open}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty">Loading…</div>}
      </div>
    </div>
  );
}
