// UwU mode at runtime. The rest of the app only emits toasts; ui.tsx forwards each one as an "impulse:toast"
// event. UwuLayer (always mounted) starts the audio on the first gesture and blips on button presses; ChartMascot
// (inside the chart, so only on the trade page) greets, turns toasts into Anya's poses, speech bubbles and voice,
// and runs her awake → bored → asleep cycle. Her voice only plays while she's on screen. UwuControls is the header
// switch and the audio menu.

import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { type Mood, PulseChan } from "./art";
import { type Cue, blip, cue, play, preload, unlock, whenUnlocked } from "./audio";
import { useUwu } from "./store";

export interface ToastEvent {
  tone: "up" | "down" | "warn" | "info";
  text: string;
}

export const TOAST_EVENT = "impulse:toast";
/** Tells the mascot to greet (fired with the greeting sound). */

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

/**
 * Poses: the sprite files under /uwu/anya/ (WebP, made from the PNGs by make uwu-assets), plus "bored" and "asleep"
 * for her idle cycle.
 */
type Pose = "idle" | "happy" | "sad" | "shock" | "poke" | "smug" | "bored" | "asleep";
const SPRITE_FILE: Record<Pose, string> = {
  idle: "idle",
  happy: "happy",
  sad: "sad",
  shock: "shock",
  poke: "poke",
  smug: "smug",
  bored: "sleepy",
  asleep: "idle",
};
const SVG_MOOD: Record<Pose, Mood> = {
  idle: "idle",
  happy: "happy",
  sad: "sad",
  shock: "shock",
  poke: "poke",
  smug: "smug",
  bored: "sleepy",
  asleep: "sleepy",
};
/** Each sprite file once: they're all mounted at once (see the mascot below). */
const SPRITES = [...new Set(Object.values(SPRITE_FILE))];

const REACT: Record<ToastEvent["tone"], { pose: Pose; cue: Cue; lines: string[] }> = {
  up: { pose: "happy", cue: "win", lines: ["yatta~! ✧(≧▽≦)✧", "sugoi!! ٩(◕‿◕)۶", "nice fill ♡"] },
  down: { pose: "sad", cue: "lose", lines: ["uuu… (╥﹏╥)", "that one hurt… (っ˘̩╭╮˘̩)っ"] },
  warn: { pose: "shock", cue: "warn", lines: ["e-eh?! (⊙_⊙;)", "careful~! (°ロ°)"] },
  info: { pose: "smug", cue: "info", lines: ["heh. (￣▽￣)", "hai~ (｡•̀ᴗ-)✧"] },
};

/** Anya's own lines, for when she's clicked: the clip, what she says, and how she looks saying it. */
const ANYA: { src: string; line: string; pose: Pose }[] = [
  { src: "voice/anya-1.mp3", line: "waku waku!", pose: "happy" },
  { src: "voice/anya-2.mp3", line: "a spy mission?! waku waku!", pose: "happy" },
  { src: "voice/anya-3.mp3", line: "Anya likes peanuts.", pose: "smug" },
  { src: "voice/anya-4.mp3", line: "hi, honey~", pose: "poke" },
  { src: "voice/anya-5.mp3", line: "okeydoke!", pose: "poke" },
  { src: "voice/anya-6.mp3", line: "Anya!", pose: "happy" },
  { src: "voice/anya-7.mp3", line: "nya~", pose: "poke" },
];

/** Things she mutters while awake and nothing is happening. */
const CHATTER = [
  "psst… no insurance fund here. when someone goes bust, the winners pay",
  "⌘K finds any market~",
  "100x is a lot of x… just saying (・_・;)",
  "the faucet gives $10k paper USDC a minute ♡",
  "the dotted line is your liquidation price. stay away from it!",
];
const BORED = ["hmm… so bored… (￣ヘ￣)", "is anyone trading? …anyone?", "*stares at the chart* …"];
const SLEEP = ["zzz… peanuts…", "zzz… waku… waku…", "zzz… (－_－) zzZ"];
const WOKEN = [
  "h-huh?! Anya wasn't sleeping!",
  "w-what?! the chart moved?!",
  "five more minutes… (；￣Д￣)",
];

/** How long she stays awake, then bored, without anything happening. */
const BORED_AFTER = 45_000;
const ASLEEP_AFTER = 120_000;
/** Poke her this many times this fast and she snaps. */
const SPAM = { count: 5, within: 4_000 };

/** What blips when pressed (not Anya: she has her own sounds). */
const BLIPS =
  "button, a[href], [role=button], [role=tab], [role=switch], [role=menuitem], [role=option], input[type=checkbox], input[type=radio], .uwu-check";

/** Mounted once in the layout: unlocks audio on the first gesture, and blips on button presses. */
export function UwuLayer() {
  const on = useUwu((s) => s.on);
  useEffect(() => {
    if (!on) return;
    // The first click or key press, whichever comes first.
    const down = () => {
      window.removeEventListener("pointerup", down, { capture: true });
      window.removeEventListener("keydown", down, { capture: true });
      unlock();
    };
    const press = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (e.button === 0 && t?.closest(BLIPS) && !t.closest(".uwu-mascot-wrap")) blip();
    };
    // pointerup, not pointerdown: a touch only counts as a gesture that may start audio once the finger lifts.
    window.addEventListener("pointerup", down, { capture: true });
    window.addEventListener("keydown", down, { capture: true });
    window.addEventListener("pointerdown", press, { capture: true });
    return () => {
      window.removeEventListener("pointerup", down, { capture: true });
      window.removeEventListener("keydown", down, { capture: true });
      window.removeEventListener("pointerdown", press, { capture: true });
    };
  }, [on]);
  return null;
}

/** Her first line is always konnichiwa: once a page load, and again each time UwU mode is switched on. */
let greeted = false;
const HELLO = "voice/greet-2.mp3";

type Phase = "awake" | "bored" | "asleep";

/**
 * Anya, sitting in the bottom-left of the chart. Awake, she reacts to trades and chats now and then; left alone
 * she gets bored, then falls asleep. Clicking her plays her own lines (and startles her awake); trades wake her
 * too. Pulse-chan (SVG) stands in if the art is missing.
 */
export function ChartMascot() {
  const [phase, setPhase] = useState<Phase>("awake");
  /** A reaction's pose, shown over the phase's resting pose until it times out. */
  const [reaction, setReaction] = useState<Pose | null>(null);
  const [bubble, setBubble] = useState<{ line: string; sub?: string; n: number } | null>(null);
  /** Sprite files that failed to load: their poses show Pulse-chan, and switching to one tries the file again. */
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  /** The nodding-off clip; without it she sleeps in her sitting pose, dimmed. */
  const [sleepClip, setSleepClip] = useState(true);
  const reset = useRef<ReturnType<typeof setTimeout>>(undefined);
  const quietSince = useRef(0);
  const phaseRef = useRef<Phase>("awake");
  const pokes = useRef<number[]>([]);
  const lastLine = useRef(-1);
  /** Counts clicks, so a clip that finishes loading late only extends its own click's bubble. */
  const clicks = useRef(0);
  const greetedAt = useRef(0);

  const goTo = useCallback((p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  }, []);

  /** Keep the current reaction and bubble up for `ms` from now. */
  const hold = useCallback((ms: number) => {
    clearTimeout(reset.current);
    reset.current = setTimeout(() => {
      setReaction(null);
      setBubble(null);
    }, ms);
  }, []);

  const say = useCallback(
    (line: string, opts: { pose?: Pose; sub?: string; ms?: number } = {}) => {
      setReaction(opts.pose ?? null);
      setBubble({ line, sub: opts.sub, n: Date.now() });
      hold(opts.ms ?? 4000);
    },
    [hold],
  );

  /** Something happened: she's awake, and the quiet clock restarts. */
  const wake = useCallback(() => {
    quietSince.current = Date.now();
    if (phaseRef.current !== "awake") goTo("awake");
  }, [goTo]);

  // Konnichiwa, as soon as she's on screen and audio may play (the first tap or key press, if none came yet).
  useEffect(
    () =>
      whenUnlocked(() => {
        if (greeted) return;
        greeted = true;
        greetedAt.current = Date.now();
        preload(ANYA.map((a) => a.src));
        void play(HELLO, "greet");
        wake();
        say("konnichiwa~! ✧", { pose: "happy", ms: 3000 });
      }),
    [say, wake],
  );

  // Trades: she reacts, and says so.
  useEffect(() => {
    const onToast = (e: Event) => {
      const t = (e as CustomEvent<ToastEvent>).detail;
      const r = REACT[t.tone];
      const wasAsleep = phaseRef.current === "asleep";
      void cue(r.cue);
      wake();
      say(wasAsleep ? `${pick(WOKEN)} …${pick(r.lines)}` : pick(r.lines), {
        pose: r.pose,
        sub: t.text || undefined,
        ms: t.tone === "down" ? 6000 : 4000,
      });
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, [say, wake]);

  // The idle cycle: awake (chatting now and then) → bored → asleep.
  useEffect(() => {
    quietSince.current = Date.now();
    const id = setInterval(() => {
      const quiet = Date.now() - quietSince.current;
      const p = phaseRef.current;
      if (p === "awake" && quiet > BORED_AFTER) {
        goTo("bored");
        void cue("idle");
        say(pick(BORED), { ms: 5000 });
      } else if (p === "bored" && quiet > ASLEEP_AFTER) {
        goTo("asleep");
        say(pick(SLEEP), { ms: 5000 });
      } else if (p === "awake" && quiet > 15_000 && Math.random() < 0.3) {
        void cue("idle");
        say(pick(CHATTER), { ms: 6000 });
      } else if (p === "asleep" && Math.random() < 0.15) {
        say(pick(SLEEP), { ms: 4000 });
      }
    }, 10_000);
    return () => {
      clearInterval(id);
      clearTimeout(reset.current);
    };
  }, [goTo, say]);

  const click = async () => {
    unlock();
    // The tap that let audio start is answered by her greeting.
    if (Date.now() - greetedAt.current < 1000) return;
    const now = Date.now();
    pokes.current = [...pokes.current.filter((t) => now - t < SPAM.within), now];
    const from = phaseRef.current;
    wake();
    if (pokes.current.length >= SPAM.count) {
      pokes.current = [];
      say("baka!! stop poking Anya! (╬ Ò﹏Ó)", { pose: "shock", ms: 3000 });
      void play("voice/lose-3.mp3", "warn");
      return;
    }
    if (from === "asleep") {
      say(pick(WOKEN), { pose: "shock", ms: 3000 });
      void cue("warn");
      return;
    }
    // Her own lines, never the same one twice in a row.
    let i = Math.floor(Math.random() * ANYA.length);
    if (i === lastLine.current) i = (i + 1) % ANYA.length;
    lastLine.current = i;
    const a = ANYA[i]!;
    // React on the click itself; the clip can take a moment to load the first time.
    const id = ++clicks.current;
    say(from === "bored" ? `oh! ${a.line}` : a.line, { pose: a.pose, ms: 2500 });
    const dur = await play(a.src, "info");
    if (id === clicks.current && dur * 1000 + 900 > 2500) hold(dur * 1000 + 900);
  };

  const pose: Pose = reaction ?? (phase === "awake" ? "idle" : phase);
  const file = SPRITE_FILE[pose];
  const sleeping = pose === "asleep" && sleepClip;
  // Switching to a pose whose file failed tries it again (state adjusted while rendering, as React suggests for
  // reacting to a change).
  const [shown, setShown] = useState(file);
  if (file !== shown) {
    setShown(file);
    if (broken.has(file)) {
      const next = new Set(broken);
      next.delete(file);
      setBroken(next);
    }
  }
  return (
    <div className="uwu-mascot-wrap">
      {bubble && (
        <div
          className={`uwu-bubble ${phase === "asleep" && !reaction ? "dream" : ""}`}
          key={bubble.n}
          role="status"
        >
          <b>{bubble.line}</b>
          {bubble.sub && <span>{bubble.sub}</span>}
        </div>
      )}
      <button
        type="button"
        className={`uwu-mascot pose-${pose}`}
        aria-label={phase === "asleep" ? "Wake Anya up" : "Poke Anya"}
        onClick={() => void click()}
      >
        {sleeping && (
          <video
            className="uwu-sleep"
            src="/uwu/anya/asleep.mp4"
            autoPlay
            loop
            muted
            playsInline
            onError={() => setSleepClip(false)}
          />
        )}
        {/* Every pose stays mounted and decoded, the current one shown: a pose change is a class swap, with no
            image to load or decode, so even rapid clicks switch instantly. */}
        {SPRITES.map(
          (f) =>
            !broken.has(f) && (
              <img
                key={f}
                src={`/uwu/anya/${f}.webp`}
                className={f === file && !sleeping ? "on" : undefined}
                alt=""
                draggable={false}
                decoding="async"
                onLoad={(e) => void e.currentTarget.decode().catch(() => {})}
                onError={() => setBroken((b) => new Set(b).add(f))}
              />
            ),
        )}
        {!sleeping && broken.has(file) && <PulseChan mood={SVG_MOOD[pose]} size={120} />}
        {pose === "asleep" && (
          <span className="uwu-zzz" aria-hidden="true">
            <i>z</i>
            <i>z</i>
            <i>Z</i>
          </span>
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
  const silent = s.muted || s.volume === 0 || (!s.music && !s.voice && !s.blips);
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
          <Check label="UI blips" checked={s.blips} onChange={(v) => s.set({ blips: v })} />
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
          if (!on) {
            greeted = false;
            unlock();
          }
        }}
      >
        {on ? "UwU" : "owo"}
      </button>
      {on && <AudioMenu />}
    </div>
  );
}
