// UwU mode at runtime. The rest of the app only emits toasts; ui.tsx forwards each one as an "impulse:toast"
// event. UwuLayer (always mounted) turns them into voice clips; ChartMascot (inside the chart) turns them into
// Anya's moods and speech bubbles. UwuControls is the header switch and the audio menu.

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { type Mood, PulseChan } from "./art";
import { type Cue, cue, unlock } from "./audio";
import { useUwu } from "./store";

export interface ToastEvent {
  tone: "up" | "down" | "warn" | "info";
  text: string;
}

export const TOAST_EVENT = "impulse:toast";

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

const REACT: Record<ToastEvent["tone"], { mood: Mood; cue: Cue; lines: string[] }> = {
  up: {
    mood: "happy",
    cue: "win",
    lines: ["waku waku! ✧(≧▽≦)✧", "sugoi!! ٩(◕‿◕)۶", "nice fill ♡"],
  },
  down: { mood: "sad", cue: "lose", lines: ["uuu… (╥﹏╥)", "that one hurt… (っ˘̩╭╮˘̩)っ"] },
  warn: { mood: "shock", cue: "warn", lines: ["e-eh?! (⊙_⊙;)", "careful~! (°ロ°)"] },
  info: { mood: "smug", cue: "info", lines: ["heh. (￣▽￣)", "hai~ (｡•̀ᴗ-)✧"] },
};

/** Things she mutters when nothing is happening. */
const IDLE = [
  "psst… no insurance fund here. when someone goes bust, the winners pay",
  "⌘K finds any market~",
  "100x is a lot of x… just saying (・_・;)",
  "the faucet gives $10k paper USDC a minute ♡",
  "the dotted line is your liquidation price. stay away from it!",
];

/** Mounted once in the layout: unlocks audio on the first gesture and voices every toast. */
export function UwuLayer() {
  const on = useUwu((s) => s.on);
  useEffect(() => {
    if (!on) return;
    const down = () => unlock();
    const toast = (e: Event) => cue(REACT[(e as CustomEvent<ToastEvent>).detail.tone].cue);
    window.addEventListener("pointerdown", down, { capture: true, once: true });
    window.addEventListener(TOAST_EVENT, toast);
    return () => {
      window.removeEventListener("pointerdown", down, { capture: true });
      window.removeEventListener(TOAST_EVENT, toast);
    };
  }, [on]);
  return null;
}

const SPRITE = (m: Mood) => `/uwu/anya/${m}.png`;
const SPRITES: Mood[] = ["idle", "happy", "sad", "shock", "poke", "smug", "sleepy"];

/** Anya, sitting in the bottom-left of the chart, reacting to what happens. Pulse-chan if the art is missing. */
export function ChartMascot() {
  const [mood, setMood] = useState<Mood>("idle");
  const [bubble, setBubble] = useState<{ line: string; sub?: string; n: number } | null>(null);
  const [art, setArt] = useState<"anya" | "svg">("anya");
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastEvent = useRef(0);

  // Load every pose up front so a reaction never flashes an empty frame.
  useEffect(() => {
    for (const m of SPRITES) new Image().src = SPRITE(m);
  }, []);

  const react = useCallback((m: Mood, line: string, sub?: string, ms = 4000) => {
    clearTimeout(reset.current);
    setMood(m);
    setBubble({ line, sub, n: Date.now() });
    reset.current = setTimeout(() => {
      setMood("idle");
      setBubble(null);
    }, ms);
  }, []);

  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<ToastEvent>).detail;
      const r = REACT[t.tone];
      lastEvent.current = Date.now();
      react(r.mood, pick(r.lines), t.text || undefined, t.tone === "down" ? 6000 : 4000);
    };
    window.addEventListener(TOAST_EVENT, on);
    return () => window.removeEventListener(TOAST_EVENT, on);
  }, [react]);

  // Idle chatter now and then, and a deadpan stare after a long quiet spell.
  useEffect(() => {
    lastEvent.current = Date.now();
    const id = setInterval(() => {
      const quiet = Date.now() - lastEvent.current;
      if (quiet > 5 * 60_000) setMood((m) => (m === "idle" ? "sleepy" : m));
      else if (quiet > 60_000 && Math.random() < 0.25) react("idle", pick(IDLE), undefined, 6000);
    }, 30_000);
    return () => {
      clearInterval(id);
      clearTimeout(reset.current);
    };
  }, [react]);

  return (
    <div className="uwu-mascot-wrap">
      {bubble && (
        <div className="uwu-bubble" key={bubble.n} role="status">
          <b>{bubble.line}</b>
          {bubble.sub && <span>{bubble.sub}</span>}
        </div>
      )}
      <button
        type="button"
        className={`uwu-mascot mood-${mood}`}
        aria-label="Poke Anya"
        onClick={() => {
          lastEvent.current = Date.now();
          unlock();
          cue("poke");
          react(
            "poke",
            pick(["hehe~ ♡", "anya is watching the chart!", "waku waku!"]),
            undefined,
            2500,
          );
        }}
      >
        {art === "anya" ? (
          <img
            key={mood}
            src={SPRITE(mood)}
            alt=""
            draggable={false}
            onError={() => setArt("svg")}
          />
        ) : (
          <PulseChan mood={mood} size={120} />
        )}
      </button>
    </div>
  );
}

// ---------- header controls ----------

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) =>
      ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", click);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", click);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return { open, setOpen, ref };
}

const SpeakerIcon = ({ muted }: { muted: boolean }) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M4 9h4l5-4v14l-5-4H4z" />
    {muted ? (
      <path d="m17 9 5 6m0-6-5 6" />
    ) : (
      <path d="M17 8.5a5 5 0 0 1 0 7M19.5 6a8.5 8.5 0 0 1 0 12" />
    )}
  </svg>
);

function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="uwu-check">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <i aria-hidden="true" />
    </label>
  );
}

function AudioMenu() {
  const s = useUwu();
  const { open, setOpen, ref } = usePopover();
  const silent = s.muted || s.volume === 0 || (!s.music && !s.voice);
  return (
    <div className="uwu-pop-wrap" ref={ref}>
      <button
        type="button"
        className={`icon-btn uwu-tool ${open ? "active" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="UwU audio"
        title="UwU audio"
        onClick={() => {
          unlock();
          setOpen(!open);
        }}
      >
        <SpeakerIcon muted={silent} />
        {!silent && <span className="uwu-dot" />}
      </button>
      {open && (
        <div className="uwu-pop" role="dialog" aria-label="UwU audio">
          <div className="uwu-vol">
            <button
              type="button"
              className="icon-btn"
              aria-label={s.muted ? "Unmute" : "Mute"}
              onClick={() => s.set({ muted: !s.muted })}
            >
              <SpeakerIcon muted={s.muted || s.volume === 0} />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              value={s.muted ? 0 : Math.round(s.volume * 100)}
              aria-label="Volume"
              onChange={(e) => s.set({ volume: Number(e.target.value) / 100, muted: false })}
              style={{ "--v": `${s.muted ? 0 : s.volume * 100}%` } as CSSProperties}
            />
            <span className="mono">{s.muted ? 0 : Math.round(s.volume * 100)}%</span>
          </div>
          <Check label="Music" checked={s.music} onChange={(v) => s.set({ music: v })} />
          <Check label="Anya's voice" checked={s.voice} onChange={(v) => s.set({ voice: v })} />
        </div>
      )}
    </div>
  );
}

/** The header's UwU switch, plus the audio menu while the mode is on. */
export function UwuControls() {
  const on = useUwu((s) => s.on);
  const set = useUwu((s) => s.set);
  return (
    <div className="uwu-controls">
      <button
        type="button"
        className={`uwu-switch ${on ? "on" : ""}`}
        aria-pressed={on}
        title={on ? "Back to the regular look" : "UwU mode"}
        onClick={() => {
          set({ on: !on });
          // The click is the gesture that lets the music start.
          if (!on) unlock();
        }}
      >
        {on ? "UwU" : "owo"}
      </button>
      {on && <AudioMenu />}
    </div>
  );
}
