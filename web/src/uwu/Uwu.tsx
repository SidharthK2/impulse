// UwU mode at runtime: the mascot in the corner reacting to what happens (fills, liquidations, warnings), the
// sparkle trail, the header switch and the audio mixer. The rest of the app only emits toasts; ui.tsx forwards
// each one as an "impulse:toast" event, and this layer turns them into moods, lines and sounds.

import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type Mood, PulseChan } from "./art";
import { type Sfx, say, sfx, unlock } from "./audio";
import { useUwu } from "./store";

export interface ToastEvent {
  tone: "up" | "down" | "warn" | "info";
  text: string;
}

export const TOAST_EVENT = "impulse:toast";

interface Line {
  ja: string;
  en: string;
  text: string;
}

const LINES: Record<"win" | "lose" | "warn" | "info" | "poke", Line[]> = {
  win: [
    { ja: "やったー！", en: "yatta!", text: "yatta~! ✧(≧▽≦)✧" },
    { ja: "すごい！", en: "sugoi!", text: "sugoi!! ٩(◕‿◕)۶" },
    { ja: "いいね〜", en: "nice!", text: "ii ne~ nice fill ♡" },
  ],
  lose: [
    { ja: "うぅ…", en: "uuu", text: "uuu… (╥﹏╥)" },
    { ja: "えぇ〜ん", en: "waaah", text: "eeen… that one hurt (っ˘̩╭╮˘̩)っ" },
  ],
  warn: [
    { ja: "えっ！？", en: "eh?!", text: "e-eh?! (⊙_⊙;)" },
    { ja: "気をつけて！", en: "careful!", text: "ki wo tsukete! careful~ (°ロ°)" },
  ],
  info: [{ ja: "はーい", en: "okay!", text: "hai~ (｡•̀ᴗ-)✧" }],
  poke: [
    { ja: "にゃ！", en: "nya!", text: "nya! (=^･ω･^=)" },
    { ja: "なに〜？", en: "what?", text: "nani~? (・ω・)" },
    { ja: "くすぐったい！", en: "that tickles!", text: "kusuguttai! that tickles >_<" },
  ],
};

/** Things she mutters when nothing is happening. No voice for these; they'd get old fast. */
const IDLE = [
  "psst… no insurance fund here. when someone goes bust, the winners pay (｡•́︿•̀｡)",
  "⌘K finds any market~ ✧",
  "100x is a lot of x… just saying (・_・;)",
  "the faucet gives $10k paper USDC a minute ♡",
  "limit orders rest on the book. patience is kawaii (◡‿◡✿)",
  "your liquidation price is the dotted line. don't let it get close! (ง •̀_•́)ง",
];

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

const MOOD_OF: Record<ToastEvent["tone"], { mood: Mood; line: keyof typeof LINES; sound: Sfx }> = {
  up: { mood: "happy", line: "win", sound: "win" },
  down: { mood: "sad", line: "lose", sound: "lose" },
  warn: { mood: "shock", line: "warn", sound: "warn" },
  info: { mood: "idle", line: "info", sound: "info" },
};

/** Mounted once in the layout; renders nothing unless UwU mode is on. */
export function UwuLayer() {
  const on = useUwu((s) => s.on);
  useGestures(on);
  if (!on) return null;
  return (
    <>
      <Companion />
      <Sparkles />
    </>
  );
}

/** Unlock audio on the first gesture, and blip on button presses when UI blips are on. */
function useGestures(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const down = (e: PointerEvent) => {
      unlock();
      const t = e.target as HTMLElement | null;
      if (t?.closest("button, a, [role=tab], input[type=checkbox]") && !t.closest(".uwu-companion"))
        sfx("pop");
    };
    window.addEventListener("pointerdown", down, { capture: true });
    return () => window.removeEventListener("pointerdown", down, { capture: true });
  }, [on]);
}

function Companion() {
  const mascot = useUwu((s) => s.mascot);
  const set = useUwu((s) => s.set);
  const [mood, setMood] = useState<Mood>("idle");
  const [bubble, setBubble] = useState<{ line: string; sub?: string; n: number } | null>(null);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastEvent = useRef(0);

  const react = useCallback((m: Mood, line: string, sub?: string, ms = 4200) => {
    clearTimeout(reset.current);
    setMood(m);
    setBubble({ line, sub, n: Date.now() });
    reset.current = setTimeout(() => {
      setMood("idle");
      setBubble(null);
    }, ms);
  }, []);

  // Toasts from anywhere in the app.
  useEffect(() => {
    const on = (e: Event) => {
      const t = (e as CustomEvent<ToastEvent>).detail;
      const m = MOOD_OF[t.tone];
      const l = pick(LINES[m.line]);
      lastEvent.current = Date.now();
      sfx(m.sound);
      if (t.tone !== "info") say(l.ja, l.en);
      react(m.mood, l.text, t.text || undefined, t.tone === "down" ? 6500 : 4200);
    };
    window.addEventListener(TOAST_EVENT, on);
    return () => window.removeEventListener(TOAST_EVENT, on);
  }, [react]);

  // Idle chatter, and a nap after a long quiet spell.
  useEffect(() => {
    lastEvent.current = Date.now();
    const id = setInterval(() => {
      const quiet = Date.now() - lastEvent.current;
      if (quiet > 5 * 60_000) {
        setMood((m) => (m === "idle" ? "sleepy" : m));
        return;
      }
      if (quiet > 40_000 && Math.random() < 0.35) react("idle", pick(IDLE), undefined, 6000);
    }, 30_000);
    return () => clearInterval(id);
  }, [react]);

  useEffect(() => () => clearTimeout(reset.current), []);

  if (!mascot) return null;
  return (
    // She peeks up from behind the status bar, and stands up to talk (or when hovered).
    <div className={`uwu-companion ${bubble || mood !== "idle" ? "up" : ""}`}>
      {bubble && (
        <div className="uwu-bubble" key={bubble.n} role="status">
          <b>{bubble.line}</b>
          {bubble.sub && <span>{bubble.sub}</span>}
        </div>
      )}
      <button
        type="button"
        className="uwu-mascot"
        aria-label="Poke Pulse-chan"
        onClick={() => {
          lastEvent.current = Date.now();
          const l = pick(LINES.poke);
          unlock();
          sfx("poke");
          say(l.ja, l.en);
          react("poke", l.text, undefined, 2200);
        }}
      >
        <PulseChan mood={mood} size={128} />
      </button>
      <button
        type="button"
        className="uwu-hide"
        aria-label="Hide Pulse-chan"
        title="Hide Pulse-chan (bring her back from the audio menu)"
        onClick={() => set({ mascot: false })}
      >
        ×
      </button>
    </div>
  );
}

const GLYPHS = ["✦", "✧", "♡", "⋆", "✩"];
const HUES = ["#ffb6d9", "#c9b6ff", "#9ff0d0", "#ffe27a", "#a9c4ff"];
const POOL = 22;

/** A trail of little stars and hearts behind the pointer: a fixed pool of spans, recycled. */
function Sparkles() {
  const on = useUwu((s) => s.sparkles);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!on || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (!matchMedia("(pointer: fine)").matches) return;
    const el = box.current!;
    const spans = Array.from({ length: POOL }, () => {
      const s = document.createElement("span");
      el.appendChild(s);
      return s;
    });
    let i = 0;
    let last = 0;
    let lx = 0;
    let ly = 0;
    const move = (e: PointerEvent) => {
      const now = performance.now();
      if (now - last < 38 || Math.hypot(e.clientX - lx, e.clientY - ly) < 14) return;
      last = now;
      lx = e.clientX;
      ly = e.clientY;
      const s = spans[i++ % POOL]!;
      s.textContent = pick(GLYPHS);
      s.style.left = `${e.clientX + (Math.random() - 0.5) * 10}px`;
      s.style.top = `${e.clientY + (Math.random() - 0.5) * 10}px`;
      s.style.color = pick(HUES);
      s.style.fontSize = `${9 + Math.random() * 9}px`;
      s.className = "";
      void s.offsetWidth; // restart the animation
      s.className = "go";
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      for (const s of spans) s.remove();
    };
  }, [on]);
  return <div className="uwu-sparkles" ref={box} aria-hidden="true" />;
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

const SparkleIcon = () => (
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
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M6 18l2-2M16 8l2-2" />
  </svg>
);

function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={`uwu-check ${disabled ? "off" : ""}`}>
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked);
          unlock();
          sfx("toggle");
        }}
      />
      <i aria-hidden="true" />
    </label>
  );
}

function AudioMenu() {
  const s = useUwu();
  const { open, setOpen, ref } = usePopover();
  const all = s.music && s.voices && s.trades && s.blips;
  const anyOn = !s.muted && s.volume > 0 && (s.music || s.voices || s.trades || s.blips);
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
        <SpeakerIcon muted={!anyOn} />
        {anyOn && <span className="uwu-dot" />}
      </button>
      {open && (
        <div className="uwu-pop" role="dialog" aria-label="UwU audio">
          <div className="uwu-pop-head">
            <b>UwU audio</b>
            <span>{anyOn ? "ON" : "OFF"}</span>
          </div>
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
              value={Math.round(s.volume * 100)}
              aria-label="Volume"
              onChange={(e) => s.set({ volume: Number(e.target.value) / 100, muted: false })}
              style={{ "--v": `${s.volume * 100}%` } as CSSProperties}
            />
            <span className="mono">{Math.round(s.volume * 100)}%</span>
          </div>
          <Check
            label="All sounds"
            checked={all}
            onChange={(v) => s.set({ music: v, voices: v, trades: v, blips: v, muted: false })}
          />
          <Check label="Background music" checked={s.music} onChange={(v) => s.set({ music: v })} />
          <Check
            label="Character voice"
            checked={s.voices}
            onChange={(v) => s.set({ voices: v })}
          />
          <Check label="Trade sounds" checked={s.trades} onChange={(v) => s.set({ trades: v })} />
          <Check label="UI blips" checked={s.blips} onChange={(v) => s.set({ blips: v })} />
          <div className="uwu-pop-sep" />
          <Check label="Pulse-chan" checked={s.mascot} onChange={(v) => s.set({ mascot: v })} />
          <Check
            label="Sparkle trail"
            checked={s.sparkles}
            onChange={(v) => s.set({ sparkles: v })}
          />
        </div>
      )}
    </div>
  );
}

/** The header's UwU switch, plus the audio and sparkle tools while the mode is on. */
export function UwuControls() {
  const on = useUwu((s) => s.on);
  const sparkles = useUwu((s) => s.sparkles);
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
          if (!on) {
            unlock();
            // The store flips first, so this plays in the new mode.
            setTimeout(() => sfx("win"), 0);
          }
        }}
      >
        <span className="uwu-switch-face">{on ? "UwU" : "owo"}</span>
      </button>
      {on && (
        <>
          <button
            type="button"
            className={`icon-btn uwu-tool hide-sm ${sparkles ? "active" : ""}`}
            aria-pressed={sparkles}
            aria-label="Sparkle trail"
            title="Sparkle trail"
            onClick={() => set({ sparkles: !sparkles })}
          >
            <SparkleIcon />
          </button>
          <AudioMenu />
        </>
      )}
    </div>
  );
}
