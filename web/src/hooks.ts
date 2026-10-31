import { useEffect, useState } from "react";
import { live } from "./api";

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

/** Whether a media query matches, kept current as the window changes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return matches;
}
