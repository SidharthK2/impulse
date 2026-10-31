// UwU mode preferences: the skin switch and the audio mixer. Kept apart from the main
// prefs (store.ts) so the whole mode can be dropped or moved without touching them.

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface UwuPrefs {
  on: boolean;
  /** 0..1, the master volume */
  volume: number;
  muted: boolean;
  music: boolean;
  /** Anya's voice and the trade sounds */
  voice: boolean;
  set: (p: Partial<Omit<UwuPrefs, "set">>) => void;
}

const storage = createJSONStorage(() => ({
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

export const useUwu = create<UwuPrefs>()(
  persist(
    (set) => ({
      on: false,
      volume: 0.6,
      muted: false,
      music: true,
      voice: true,
      set: (p) => set(p),
    }),
    {
      name: "impulse.uwu",
      storage,
      // v1 dropped the sparkle trail, the mascot switch and the per-sound switches, and turned sound on by
      // default: keep only whether the mode is on.
      version: 1,
      migrate: (old) => ({ on: !!(old as { on?: boolean } | null)?.on }) as UwuPrefs,
    },
  ),
);

// The skin is an attribute on <html> (index.html sets it before first paint too), so the CSS can restyle
// everything, and the chart re-reads its colours when it changes.
const apply = (on: boolean) => {
  if (typeof document === "undefined") return;
  if (on) document.documentElement.dataset.skin = "uwu";
  else delete document.documentElement.dataset.skin;
};
apply(useUwu.getState().on);
useUwu.subscribe((s) => apply(s.on));
