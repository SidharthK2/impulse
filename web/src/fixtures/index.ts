// Dev-only fixtures: a ticking in-browser world (world.ts) published as immutable snapshots for React.

import { useEffect } from "react";
import { create } from "zustand";
import { usePrefs } from "../store";
import type { AccountView, BookView, Candle, FillView, MarketView, RiskEvent } from "../types";
import { FixtureError, type World, createWorld, handle, tick } from "./world";

export interface Snapshot {
  markets: MarketView[];
  events: RiskEvent[];
  books: Record<string, BookView>;
  trades: Record<string, FillView[]>;
  positions: AccountView["positions"];
  spot: AccountView["spot"];
  snipes: AccountView["snipes"];
}

let world: World | null = null;

function snapshot(w: World): Snapshot {
  return {
    markets: Object.values(w.markets).map((m) => ({ ...m })),
    events: [...w.events],
    books: { ...w.books },
    trades: Object.fromEntries(Object.entries(w.trades).map(([k, v]) => [k, [...v]])),
    positions: w.positions.map((p) => ({ ...p })),
    spot: w.spot.map((s) => ({ ...s })),
    snipes: w.snipes.map((s) => ({ ...s })),
  };
}

export const useFixtureWorld = create<{ snap: Snapshot | null }>()(() => ({ snap: null }));

const publish = () => world && useFixtureWorld.setState({ snap: snapshot(world) });

/** Mount once: runs the fixture clock while fixtures are switched on. */
export function useFixtureDriver() {
  const on = usePrefs((s) => s.fixtures);
  useEffect(() => {
    if (!on) {
      useFixtureWorld.setState({ snap: null });
      return;
    }
    world ??= createWorld(Date.now());
    tick(world, Date.now());
    publish();
    const t = setInterval(() => {
      tick(world!, Date.now());
      publish();
    }, 1000);
    return () => clearInterval(t);
  }, [on]);
}

/** Ids the real server lists; a fixture market with the same id is hidden and never handles requests. */
let realIds = new Set<string>();
export const setRealMarketIds = (ids: string[]) => {
  realIds = new Set(ids);
};

export const isFixtureMarket = (id: string | undefined) =>
  !!id && !realIds.has(id) && !!world?.markets[id] && usePrefs.getState().fixtures;

/** 1m candles for a fixture market (null if it isn't one). */
export function fixtureCandles(id: string): Candle[] | null {
  if (!isFixtureMarket(id)) return null;
  return world!.candles[id]!.map((c) => ({ ...c }));
}

/**
 * Try a request against the fixture world. `force` makes contract endpoints the server lacks (it answered 404)
 * land here too. Returns undefined when the real server should handle it.
 */
export function fixtureCall(
  method: string,
  path: string,
  body: Record<string, unknown> | undefined,
  force = false,
): { value: unknown } | undefined {
  if (!usePrefs.getState().fixtures || !world) return undefined;
  const market = typeof body?.market === "string" ? body.market : undefined;
  if (market && realIds.has(market)) return undefined;
  try {
    const v = handle(world, method, path, body ?? {}, force);
    if (v === undefined) return undefined;
    publish();
    return { value: v };
  } catch (e) {
    if (e instanceof FixtureError) throw new Error(e.message, { cause: e });
    throw e;
  }
}
