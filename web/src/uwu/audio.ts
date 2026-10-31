// UwU mode's sound: chiptune background music and Anya's voice clips, from web/public/uwu/ (fetched by
// `make uwu-assets`, never committed). When those files are missing, a synthesized chime or music-box loop
// plays in their place, so the mode still works on a fresh checkout.

import { useUwu } from "./store";

const BASE = "/uwu/";
const TRACKS = ["music/frivolous.mp3", "music/chiploop.mp3"];
export type Cue = "win" | "lose" | "warn" | "info" | "poke";
const CLIPS: Record<Cue, string[]> = {
  win: ["voice/win-1.mp3", "voice/win-2.mp3"],
  lose: ["voice/lose-1.mp3"],
  warn: ["voice/warn-1.mp3"],
  info: ["voice/info-1.mp3"],
  poke: ["voice/poke-1.mp3", "voice/poke-2.mp3", "voice/poke-3.mp3"],
};
/** Music sits under the voice. */
const MUSIC_LEVEL = 0.35;

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;

const audible = () => {
  const s = useUwu.getState();
  return s.on && !s.muted && s.volume > 0;
};
/** Squared, so the slider feels linear to the ear. */
const level = () => {
  const v = useUwu.getState().volume;
  return v * v;
};

let unlocked = false;

/** Browsers only start audio after a gesture; the first pointerdown (or the UwU switch) calls this. */
export function unlock() {
  unlocked = true;
  if (ctx?.state === "suspended") void ctx.resume();
  syncMusic();
}

// ---------- voice clips ----------

let clip: HTMLAudioElement | null = null;

export function cue(kind: Cue) {
  const s = useUwu.getState();
  if (!audible() || !s.voice) return;
  clip?.pause();
  const a = new Audio(BASE + pick(CLIPS[kind]));
  a.volume = Math.min(1, level());
  a.addEventListener("error", () => synth(kind), { once: true });
  a.play().catch(() => {});
  clip = a;
}

// ---------- music ----------

let music: HTMLAudioElement | null = null;
let track = 0;
let fallback = false;

function syncMusic() {
  const s = useUwu.getState();
  const want = unlocked && audible() && s.music;
  if (fallback) {
    musicBox(want);
    return;
  }
  if (!want) {
    music?.pause();
    return;
  }
  if (!music) {
    music = new Audio(BASE + TRACKS[track]);
    music.addEventListener("ended", () => {
      track = (track + 1) % TRACKS.length;
      music!.src = BASE + TRACKS[track];
      void music!.play().catch(() => {});
    });
    music.addEventListener("error", () => {
      // No music files: play the synthesized lullaby instead.
      fallback = true;
      music = null;
      syncMusic();
    });
  }
  music.volume = Math.min(1, level() * MUSIC_LEVEL);
  if (music.paused) void music.play().catch(() => {});
}

useUwu.subscribe((s, prev) => {
  if (
    s.on !== prev.on ||
    s.muted !== prev.muted ||
    s.volume !== prev.volume ||
    s.music !== prev.music
  )
    syncMusic();
  if (s.volume !== prev.volume) {
    if (clip) clip.volume = Math.min(1, level());
    if (out) out.gain.value = level();
  }
  if (!s.on || s.muted || !s.voice) clip?.pause();
});

// ---------- fallbacks: Web Audio synth ----------

let ctx: AudioContext | null = null;
let out: GainNode | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  if (!ctx) {
    ctx = new AudioContext();
    out = ctx.createGain();
    out.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  out!.gain.value = level();
  return ctx;
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** A music-box tine: a sine with a quick bright partial, struck and left to ring. */
function tine(f: number, t: number, dur = 1.2, gain = 0.18) {
  if (!ctx || !out) return;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(out);
  for (const [mult, amp] of [
    [1, 1],
    [3.01, 0.18],
  ] as const) {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.value = f * mult;
    og.gain.value = amp;
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

function synth(kind: Cue) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + 0.01;
  const notes: Record<Cue, number[]> = {
    win: [84, 88, 91, 96],
    lose: [76, 72, 67],
    warn: [81, 76],
    info: [88, 95],
    poke: [91, 96],
  };
  notes[kind].forEach((n, i) => tine(hz(n), t + i * (kind === "lose" ? 0.18 : 0.06), 0.8, 0.14));
}

// Four bars of Fmaj7 → Em7 → Dm7 → Cmaj7, arpeggiated, for when the music files are missing.
const CHORDS = [
  [53, 57, 60, 64],
  [52, 55, 59, 62],
  [50, 53, 57, 60],
  [48, 52, 55, 59],
];
let timer: ReturnType<typeof setInterval> | null = null;

function musicBox(on: boolean) {
  if (!on) {
    if (timer) clearInterval(timer);
    timer = null;
    return;
  }
  const c = audio();
  if (!c || timer) return;
  const step = 60 / 76 / 2;
  let next = c.currentTime + 0.1;
  let i = 0;
  timer = setInterval(() => {
    if (next < c.currentTime - 0.5) next = c.currentTime + 0.05;
    while (next < c.currentTime + 0.3) {
      const chord = CHORDS[Math.floor(i / 8) % 4]!;
      tine(hz(chord[[0, 1, 2, 3, 2, 1, 2, 3][i % 8]!]! + 12), next, 1.1, 0.05);
      next += step;
      i++;
    }
  }, 100);
}
