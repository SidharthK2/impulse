import { countdown } from "../format";
import type { MarketView } from "../types";

export type Phase = "sniping" | "opening" | "live" | "resolved";

export function phase(m: MarketView, now: number): Phase {
  if (m.status === "resolved") return "resolved";
  if (m.snipe) return now < m.snipe.opensAt ? "sniping" : "opening";
  return "live";
}

/** What the market is called on cards and in the header: question text for binaries, the id otherwise. */
export const displayName = (m: MarketView) => (m.kind === "binary" ? m.name : m.id);

/** The price to headline: the mark, or before a coin opens, where the snipe pool would open it. */
export const headline = (m: MarketView) => m.mark ?? m.snipe?.projectedOpenPrice ?? null;

export function StatusChip({ market, now }: { market: MarketView; now: number }) {
  const p = phase(market, now);
  if (p === "sniping")
    return (
      <span className="chip snipe" title="Bids pool until the open, then all fill at one price">
        <i className="pulse" /> sniping · {countdown(market.snipe!.opensAt - now)}
      </span>
    );
  if (p === "opening") return <span className="chip snipe">opening…</span>;
  if (p === "resolved") return <span className="chip">resolved</span>;
  if (market.preipo) return <span className={`chip ${market.preipo.status === "public" ? "info" : "live"}`}>{market.preipo.status === "public" ? "public" : "private · live"}</span>;
  return (
    <span className="chip live">
      <i className="pulse" /> live
    </span>
  );
}
