import { ago, usd } from "../format";
import { useNow } from "../hooks";
import type { RiskEvent } from "../types";
import { KindBadge } from "./ui";

export function RiskList({ events, showMarket = true, onMarket }: { events: RiskEvent[]; showMarket?: boolean; onMarket?: (id: string) => void }) {
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
            {showMarket &&
              (onMarket ? (
                <a href={`#/trade/${encodeURIComponent(e.market)}`} onClick={() => onMarket(e.market)}>
                  {e.market}
                </a>
              ) : (
                e.market
              ))}
            {showMarket && " · "}
            {ago(e.time, now)}
            {e.amount && (e.kind === "haircut" || e.kind === "bankrupt") ? ` · ${usd(e.amount)}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}
