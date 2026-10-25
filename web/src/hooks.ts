import { useEffect, useState } from "react";
import { live } from "./api";

/** Latest payload on a websocket channel (null channel = not subscribed). */
export function useChannel<T>(ch: string | null): T | undefined {
  const [data, setData] = useState<T | undefined>(undefined);
  useEffect(() => {
    setData(undefined);
    if (!ch) return;
    return live.subscribe(ch, (d) => setData(d as T));
  }, [ch]);
  return data;
}

export function useConnected(): boolean {
  const [c, setC] = useState(live.connected);
  useEffect(() => {
    const off = live.onStatus(setC);
    setC(live.connected); // the socket may have opened between render and subscribe
    return () => {
      off();
    };
  }, []);
  return c;
}

/** Re-render every `ms` (for countdowns and "x seconds ago"). */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function useHashRoute(): [string[], (path: string) => void] {
  const parse = () => location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(parse);
  useEffect(() => {
    const on = () => setParts(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = (path: string) => {
    location.hash = `#/${path}`;
  };
  return [parts, go];
}
