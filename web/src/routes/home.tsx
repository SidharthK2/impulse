import { Link } from "@tanstack/react-router";
import { change24h } from "../components/Market";
import { pct, price, tone } from "../format";
import { useMarkets } from "../queries";

export function HomePage() {
  const markets = useMarkets() ?? [];
  return (
    <div className="page wide">
      <h1>Markets</h1>
      <div className="panel">
        <table className="grid">
          <tbody>
            {markets.map((m) => (
              <tr key={m.id}>
                <td>
                  <Link to="/trade/$market" params={{ market: m.id }}>
                    {m.id}
                  </Link>
                </td>
                <td className="right mono">{price(m.mark, m.priceDecimals)}</td>
                <td className={`right mono ${tone(change24h(m))}`}>{pct(change24h(m))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
