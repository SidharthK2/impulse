// How often a websocket channel may update the UI. The server can push faster than anyone can read a number,
// so each subscription goes through a TanStack Pacer throttler: the first push lands at once, later ones at
// most once per window, and the trailing edge always delivers the latest payload.

import { Throttler } from "@tanstack/react-pacer";

const WAIT_MS: Record<string, number> = {
  book: 100, // ~10/s
  trades: 100,
  markets: 250, // ~4/s
  account: 250,
};

/** Wrap a channel listener in its throttle (or return it as is for channels without one). */
export function paced<T>(
  ch: string,
  listener: (data: T) => void,
): { push: (data: T) => void; cancel: () => void } {
  const wait = WAIT_MS[ch.split(":")[0]!];
  if (!wait) return { push: listener, cancel: () => {} };
  const t = new Throttler(listener, { wait, leading: true, trailing: true });
  return { push: (data) => t.maybeExecute(data), cancel: () => t.cancel() };
}
