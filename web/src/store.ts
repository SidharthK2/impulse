// UI state and preferences. Server data lives in the TanStack Query cache (queries.ts), not here.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { getKey, setKey } from "./api";

export type Theme = "dark" | "light";
export type Range = "5m" | "1h" | "1d";
export type BookTab = "book" | "trades";

export interface OrderDefaults {
  type: "market" | "limit";
  unit: "usd" | "coin";
  /** null = the market's max leverage */
  leverage: number | null;
}

interface Prefs {
  theme: Theme;
  lastMarket: string | null;
  order: OrderDefaults;
  range: Range;
  bookTab: BookTab;
  /** Dev only: merge typed fixtures (web/src/fixtures) into server data for contract fields the server lacks. */
  fixtures: boolean;
  setTheme: (t: Theme) => void;
  setLastMarket: (id: string) => void;
  setOrder: (o: Partial<OrderDefaults>) => void;
  setRange: (r: Range) => void;
  setBookTab: (t: BookTab) => void;
  setFixtures: (on: boolean) => void;
}

// Storage can throw (private mode, blocked site data); preferences then just don't survive a reload.
const safeStorage = createJSONStorage(() => ({
  getItem: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // ignore
    }
  },
  removeItem: (k: string) => {
    try {
      localStorage.removeItem(k);
    } catch {
      // ignore
    }
  },
}));

const prefersLight = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      theme: prefersLight ? "light" : "dark",
      lastMarket: null,
      order: { type: "market", unit: "usd", leverage: null },
      range: "1h",
      bookTab: "book",
      fixtures: false,
      setTheme: (theme) => set({ theme }),
      setLastMarket: (lastMarket) => set({ lastMarket }),
      setOrder: (o) => set((s) => ({ order: { ...s.order, ...o } })),
      setRange: (range) => set({ range }),
      setBookTab: (bookTab) => set({ bookTab }),
      setFixtures: (fixtures) => set({ fixtures: import.meta.env.DEV && fixtures }),
    }),
    {
      name: "impulse.prefs",
      storage: safeStorage,
      // A production build never runs on fixtures, whatever a dev session left behind.
      merge: (persisted, current) => {
        const p = { ...current, ...(persisted as Partial<Prefs>) };
        return { ...p, fixtures: import.meta.env.DEV && !!p.fixtures };
      },
    },
  ),
);

// Apply the theme to <html> as soon as it changes, before any component reads its colours (the chart does).
const applyTheme = (t: Theme) => {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = t;
};
applyTheme(usePrefs.getState().theme);
usePrefs.subscribe((s) => applyTheme(s.theme));

interface Session {
  key: string | null;
  signIn: (key: string | null) => void;
}

export const useSession = create<Session>()((set) => ({
  key: getKey(),
  signIn: (key) => {
    setKey(key);
    set({ key });
  },
}));

type Modal = "signup" | null;

export const useUi = create<{ modal: Modal; open: (m: Modal) => void; search: boolean; setSearch: (open: boolean) => void }>()((set) => ({
  modal: null,
  open: (modal) => set({ modal }),
  /** The ⌘K market search. */
  search: false,
  setSearch: (search) => set({ search }),
}));

/** Signed in, or running on fixtures (where the fixture account "you" trades fixture markets). */
export function useCanTrade(): boolean {
  const key = useSession((s) => s.key);
  const fixtures = usePrefs((s) => s.fixtures);
  return !!key || fixtures;
}
