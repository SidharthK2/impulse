import type { MarketView } from "../types";

/** What the market is called on cards and in the header: question text for binaries, the id otherwise. */
export const displayName = (m: MarketView) => (m.kind === "binary" ? m.name : m.id);

/**
 * The price to headline: until a coin opens, where the snipe pool would open it (the Rust server already reports
 * the untouched curve's price as the mark then), and the mark after that.
 */
export const headline = (m: MarketView) => (m.snipe ? m.snipe.projectedOpenPrice : m.mark);
