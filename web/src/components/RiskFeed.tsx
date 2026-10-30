import { Link } from "@tanstack/react-router";
import { ago, usd } from "../format";
import { useNow } from "../hooks";
import type { RiskEvent } from "../types";
import { KindBadge } from "./ui";

export function RiskList({ events, showMarket = true }: { events: RiskEvent[]; showMarket?: boolean }) {
  const now = useNow(5000);
  if (events.length === 0) return <div className="empty">Nothing yet. Liquidations, ADL and graduations show up here as they happen.</div>;
  return (
    <div className="feed">
      {events.map((e) => (
        <div key={e.id} className="ev">
          <div>
            <KindBadge kind={e.kind} />
          </div>
          <div className="txt">{e.text}</div>
          <div className="meta">
            {showMarket && (
              <Link to="/trade/$market" params={{ market: e.market }}>
                {e.market}
              </Link>
            )}
            {showMarket && " · "}
            {ago(e.time, now)}
            {e.amount && (e.kind === "haircut" || e.kind === "bankrupt") ? ` · ${usd(e.amount)}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
