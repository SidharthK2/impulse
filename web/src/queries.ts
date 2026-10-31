// Server data: REST through TanStack Query, and every websocket push written straight into the Query cache.
// With dev fixtures on, fixture markets, events and holdings are merged into what the server returns.

import { QueryClient, type QueryKey, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { ApiError, api, live } from "./api";
import {
  fixtureCall,
  fixtureCandles,
  isFixtureMarket,
  setRealMarketIds,
  useFixtureWorld,
} from "./fixtures";
import { normalizeAccount, normalizeEvents, normalizeMarkets } from "./normalize";
import { paced } from "./pacing";
import { useSession } from "./store";
import type {
  AccountView,
  BookView,
  Candle,
  FillView,
  LeaderRow,
  MarketView,
  RiskEvent,
} from "./types";

export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: Infinity, retry: 1, refetchOnWindowFocus: false } },
});

/** A query whose REST answer seeds the cache and whose websocket channel keeps it current. */
function useLive<T>(
  key: QueryKey,
  ch: string | null,
  path: string | null,
  shape: (raw: unknown) => T,
) {
  const qc = useQueryClient();
  const hash = JSON.stringify(key);
  useEffect(() => {
    if (!ch) return;
    // Throttled per channel (pacing.ts); only the payloads that get through are normalized and cached.
    const p = paced<unknown>(ch, (raw) => qc.setQueryData(key, shape(raw)));
    const off = live.subscribe(ch, p.push);
    return () => {
      off();
      p.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ch, hash]);
  // Channels without a REST route (book, trades) just wait for their first push.
  return useQuery({
    queryKey: key,
    queryFn: async () => (path ? shape(await api("GET", path)) : new Promise<T>(() => {})),
    enabled: !!ch,
  });
}

const same = <T>(x: unknown) => x as T;

export function useMarkets(): MarketView[] | undefined {
  const real = useLive(["markets"], "markets", "/api/markets", normalizeMarkets).data;
  const fx = useFixtureWorld((s) => s.snap?.markets);
  return useMemo(() => {
    if (real) setRealMarketIds(real.map((m) => m.id));
    if (!fx) return real;
    const ids = new Set((real ?? []).map((m) => m.id));
    return [...(real ?? []), ...fx.filter((m) => !ids.has(m.id))];
  }, [real, fx]);
}

export function useFeed(): RiskEvent[] {
  const real = useLive(["feed"], "feed", "/api/feed", normalizeEvents).data;
  const fx = useFixtureWorld((s) => s.snap?.events);
  return useMemo(() => {
    if (!fx) return real ?? [];
    return [...(real ?? []), ...fx].sort((a, b) => b.time - a.time || b.id - a.id);
  }, [real, fx]);
}

export function useAccount(): AccountView | undefined {
  const key = useSession((s) => s.key);
  const real = useLive(
    ["account", key],
    key ? "account" : null,
    "/api/account",
    normalizeAccount,
  ).data;
  const snap = useFixtureWorld((s) => s.snap);
  return useMemo(() => {
    if (!snap) return real ?? undefined;
    const base: AccountView = real ?? {
      id: "you",
      bot: false,
      createdAt: Date.now(),
      nextFaucet: 0,
      wallet: "10000.00",
      deposited: "10000.00",
      withdrawn: "0",
      equity: "10000.00",
      pnl: "0",
      positions: [],
      ledger: { realized: "0", funding: "0", adlPaid: "0", adlCovered: "0" },
      spot: [],
      orders: [],
      fills: [],
      risk: [],
      snipes: [],
    };
    const mine = snap.events.filter((e) => e.accounts.includes("you"));
    return {
      ...base,
      positions: [...base.positions, ...snap.positions],
      spot: [...base.spot, ...snap.spot],
      snipes: [...base.snipes, ...snap.snipes],
      risk: [...base.risk, ...mine].sort((a, b) => b.time - a.time),
    };
  }, [real, snap]);
}

export function useBook(id: string): BookView | undefined {
  const fixture = isFixtureMarket(id);
  const real = useLive(["book", id], fixture ? null : `book:${id}`, null, same<BookView>).data;
  const fx = useFixtureWorld((s) => (fixture ? s.snap?.books[id] : undefined));
  return fixture ? fx : real;
}

export function useTrades(id: string): FillView[] {
  const fixture = isFixtureMarket(id);
  const real = useLive(
    ["trades", id],
    fixture ? null : `trades:${id}`,
    null,
    same<FillView[]>,
  ).data;
  const fx = useFixtureWorld((s) => (fixture ? s.snap?.trades[id] : undefined));
  return (fixture ? fx : real) ?? [];
}

/** 1m mark candles: the REST history, with each websocket push (the latest two candles) merged in. Pass
 * `enabled: false` to hold off loading (the home page waits until a card scrolls into view). */
export function useCandles(id: string, enabled = true): Candle[] | undefined {
  const fixture = isFixtureMarket(id);
  const qc = useQueryClient();
  useEffect(() => {
    if (fixture || !enabled) return;
    return live.subscribe(`candles:${id}`, (raw) =>
      qc.setQueryData<Candle[]>(["candles", id], (old) => mergeCandles(old, raw as Candle[])),
    );
  }, [id, fixture, qc, enabled]);
  const real = useQuery({
    queryKey: ["candles", id],
    queryFn: () => api<Candle[]>("GET", `/api/markets/${encodeURIComponent(id)}/candles`),
    enabled: enabled && !fixture,
  }).data;
  const snap = useFixtureWorld((s) => (fixture && enabled ? s.snap : null));
  const fx = useMemo(
    () => (fixture && snap ? (fixtureCandles(id) ?? undefined) : undefined),
    [fixture, id, snap],
  );
  return fixture ? fx : real;
}

function mergeCandles(old: Candle[] | undefined, fresh: Candle[]): Candle[] {
  if (!old) return fresh;
  const out = [...old];
  for (const f of fresh) {
    const i = out.findIndex((c) => c.t === f.t);
    if (i >= 0) out[i] = f;
    else if (!out.length || f.t > out[out.length - 1]!.t) out.push(f);
  }
  return out;
}

export function useLeaderboard(): LeaderRow[] {
  return useLive(["leaderboard"], "leaderboard", "/api/leaderboard", same<LeaderRow[]>).data ?? [];
}

/**
 * Send a request. Fixture markets are handled in the browser; with fixtures on, a contract endpoint the server
 * doesn't have yet (404), or one sent while signed out (401), falls through to the fixtures too.
 */
export async function act<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, unknown>,
  opts: { admin?: boolean } = {},
): Promise<T> {
  const local = fixtureCall(method, path, body);
  if (local) return local.value as T;
  try {
    return await api<T>(method, path, body, opts);
  } catch (e) {
    // 404: the server predates this endpoint. 401: signed out, but fixtures can still play it locally.
    if (e instanceof ApiError && (e.status === 404 || e.status === 401)) {
      const fallback = fixtureCall(method, path, body, true);
      if (fallback) return fallback.value as T;
      if (e.status === 404) throw new ApiError(`${path} isn't supported by this server yet`, 404);
    }
    throw e;
  }
}
