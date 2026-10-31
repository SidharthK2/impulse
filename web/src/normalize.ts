// Older servers (the TypeScript paper exchange) predate parts of the API contract. Everything the UI reads goes
// through these, so a missing field becomes its empty value instead of a crash.

import type { AccountView, MarketView, RiskEvent } from "./types";

type Loose<T> = Partial<T> & Record<string, unknown>;

export function normalizeMarket(raw: Loose<MarketView>): MarketView {
  const m = raw as MarketView;
  return {
    ...m,
    kind: m.kind ?? "perp",
    source: m.source ?? { kind: "unknown", label: "unknown" },
    funding: m.funding ?? { enabled: false, ratePerHour: 0, baseRatePerHour: 0 },
    bounds: m.bounds ?? [null, null],
    graduation: m.graduation ?? null,
    taper: m.taper ?? null,
    curve: m.curve ?? null,
    snipe: m.snipe ?? null,
    launch: m.launch ?? null,
    preipo: m.preipo ?? null,
    settings: Array.isArray(m.settings) ? m.settings : [],
  };
}

export function normalizeEvent(raw: Loose<RiskEvent>): RiskEvent {
  const e = raw as RiskEvent;
  return { ...e, accounts: e.accounts ?? [], amount: e.amount ?? null, price: e.price ?? null };
}

export function normalizeAccount(raw: unknown): AccountView | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as AccountView;
  return {
    ...a,
    positions: a.positions ?? [],
    spot: a.spot ?? [],
    orders: a.orders ?? [],
    triggers: a.triggers ?? [],
    fills: a.fills ?? [],
    reserved: a.reserved ?? "0",
    available: a.available ?? a.wallet,
    risk: (a.risk ?? []).map((e) => normalizeEvent(e as Loose<RiskEvent>)),
    snipes: a.snipes ?? [],
  };
}

export const normalizeMarkets = (xs: unknown) =>
  Array.isArray(xs) ? xs.map((m) => normalizeMarket(m as Loose<MarketView>)) : [];
export const normalizeEvents = (xs: unknown) =>
  Array.isArray(xs) ? xs.map((e) => normalizeEvent(e as Loose<RiskEvent>)) : [];
