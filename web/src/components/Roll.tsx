// Animated numbers: each digit rolls to its new value, and the whole number flashes green or red when it moves.

import { type CSSProperties, useEffect, useRef } from "react";

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
 * right so the units digit stays the same element when the number gets longer. The rolling strip is CSS generated
 * content, so selecting, copying or reading the number gives its real text.
 */
export function Roll({ text, value, className = "", flash = true }: { text: string; value?: number; className?: string; flash?: boolean }) {
  const v = value ?? Number(text.replace(/[^0-9.\-−]/g, "").replace("−", "-"));
  const ref = useFlash<HTMLSpanElement>(flash ? v : NaN);
  const chars = [...text];
  return (
    <span ref={ref} className={`roll ${className}`}>
      {chars.map((ch, i) => {
        const key = chars.length - i;
        return /\d/.test(ch) ? (
          <span key={`d${key}`} className="roll-digit" style={{ "--d": ch } as CSSProperties}>
            {ch}
          </span>
        ) : (
          <span key={`c${key}`}>{ch}</span>
        );
      })}
    </span>
  );
}
