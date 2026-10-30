// ⌘K (Ctrl K on other platforms) or "/": jump to any market by id, name or base, from anywhere in the app.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { pct, price, tone } from "../format";
import { useMarkets } from "../queries";
import { useUi } from "../store";
import type { MarketView } from "../types";
import { SearchIcon } from "./icons";
import { change24h } from "./Market";
import { displayName, headline } from "./status";

const KIND: Record<MarketView["kind"], string> = { attention: "coin", preipo: "pre-IPO", perp: "perp", binary: "prediction" };

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/** Global shortcuts that open the search. Mount once. */
export function useSearchShortcut() {
  const setSearch = useUi((s) => s.setSearch);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearch(!useUi.getState().search);
      } else if (e.key === "/" && !typing(e.target) && !useUi.getState().search) {
        e.preventDefault();
        setSearch(true);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [setSearch]);
}

export function MarketSearch() {
  const open = useUi((s) => s.search);
  const setSearch = useUi((s) => s.setSearch);
  if (!open) return null;
  return <Palette onClose={() => setSearch(false)} />;
}

function Palette({ onClose }: { onClose: () => void }) {
  const markets = useMarkets() ?? [];
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    const hit = (m: MarketView) => `${m.id} ${m.name} ${m.base}`.toLowerCase();
    return markets
      .filter((m) => !t || hit(m).includes(t))
      .sort((a, b) => (t ? Number(!a.id.toLowerCase().startsWith(t)) - Number(!b.id.toLowerCase().startsWith(t)) : 0) || Number(b.volume24h) - Number(a.volume24h))
      .slice(0, 50);
  }, [markets, q]);
  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const go = (m: MarketView | undefined) => {
    if (!m) return;
    onClose();
    void navigate({ to: "/trade/$market", params: { market: m.id } });
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search markets">
        <div className="palette-input">
          <SearchIcon />
          <input
            autoFocus
            placeholder="Search markets by name or symbol"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search markets"
            aria-controls="palette-results"
            aria-activedescendant={results[sel] ? `pal-${sel}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(results.length - 1, s + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(0, s - 1));
              } else if (e.key === "Enter") go(results[sel]);
              else if (e.key === "Escape") onClose();
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-results" role="listbox" ref={list}>
          {results.length === 0 && <div className="empty">No market matches “{q}”.</div>}
          {results.map((m, i) => {
            const ch = change24h(m);
            return (
              <button
                key={m.id}
                id={`pal-${i}`}
                data-i={i}
                role="option"
                aria-selected={i === sel}
                className={`palette-row ${i === sel ? "on" : ""}`}
                onMouseMove={() => setSel(i)}
                onClick={() => go(m)}
              >
                <span className="palette-name">
                  <b>{displayName(m)}</b>
                  <span className="badge">{KIND[m.kind]}</span>
                </span>
                <span className="mono">{price(headline(m), Math.max(m.priceDecimals, m.snipe ? 6 : 0))}</span>
                <span className={`mono palette-ch ${m.snipe ? "faint" : tone(ch)}`}>{m.snipe ? "sniping" : pct(ch)}</span>
              </button>
            );
          })}
        </div>
        <div className="palette-foot faint small">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> to move
          </span>
          <span>
            <kbd>↵</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}
