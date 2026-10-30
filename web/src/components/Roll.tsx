// Animated numbers: each digit rolls to its new value, and the whole number flashes green or red when it moves.

import { useEffect, useRef } from "react";

const DIGITS = [..."0123456789"];

/** Flash an element's background up/down when a numeric value changes. */
export function useFlash<T extends HTMLElement>(value: number) {
  const ref = useRef<T>(null);
  const prev = useRef(value);
  useEffect(() => {
    const before = prev.current;
    prev.current = value;
    const el = ref.current;
    if (!el || !Number.isFinite(before) || !Number.isFinite(value) || before === value) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const bg = getComputedStyle(el).getPropertyValue(value > before ? "--up-bg" : "--down-bg").trim();
    el.animate([{ backgroundColor: bg }, { backgroundColor: "transparent" }], { duration: 900, easing: "ease-out" });
  }, [value]);
  return ref;
}

/**
 * A formatted number whose digits roll. `value` drives the flash (defaults to parsing `text`); keys run from the
 * right so the units digit stays the same element when the number gets longer.
 */
export function Roll({ text, value, className = "", flash = true }: { text: string; value?: number; className?: string; flash?: boolean }) {
  const v = value ?? Number(text.replace(/[^0-9.\-−]/g, "").replace("−", "-"));
  const ref = useFlash<HTMLSpanElement>(flash ? v : NaN);
  const chars = [...text];
  return (
    <span ref={ref} className={`roll ${className}`} aria-label={text} role="text">
      {chars.map((ch, i) => {
        const key = chars.length - i;
        return /\d/.test(ch) ? (
          <span key={`d${key}`} className="roll-digit" aria-hidden="true">
            <span className="roll-strip" style={{ transform: `translateY(${-Number(ch) * 10}%)` }}>
              {DIGITS.map((d) => (
                <span key={d}>{d}</span>
              ))}
            </span>
          </span>
        ) : (
          <span key={`c${key}`} aria-hidden="true">
            {ch}
          </span>
        );
      })}
    </span>
  );
}
