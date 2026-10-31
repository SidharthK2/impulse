// UwU mode's sound: chiptune background music and voice clips, from web/public/uwu/ (fetched by
// `make uwu-assets`, never committed). Clips come from all over and their loudness differs by 40 dB, so each one
// is decoded with Web Audio, levelled to the same speaking volume, trimmed to a few seconds, and the music ducks
// under it. When the files are missing, a synthesized chime or music-box loop plays in their place.

import { useUwu } from "./store";

const BASE = "/uwu/";
const TRACKS = ["music/frivolous.mp3", "music/chiploop.mp3"];

export type Cue = "greet" | "win" | "lose" | "warn" | "info" | "idle";
/** How many clips each moment has (voice/<cue>-<n>.mp3). Clicking Anya plays her own lines instead (Uwu.tsx). */
const COUNT: Record<Cue, number> = { greet: 2, win: 5, lose: 3, warn: 3, info: 2, idle: 3 };
const clipFor = (kind: Cue) => `voice/${kind}-${1 + Math.floor(Math.random() * COUNT[kind])}.mp3`;

/** Music sits well under the voice, and lower still while she talks. */
const MUSIC_LEVEL = 0.35;
const DUCK = 0.35;
/** Long clips are cut here, with a short fade. */
const MAX_CLIP_S = 3.2;
/** Every clip is levelled to this RMS (over its voiced part), unless that would clip its peak. */
const TARGET_RMS = 0.16;
/** Anya's clips play at half that level. */
const VOICE_LEVEL = 0.5;

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
  const c = audio();
  if (c?.state === "suspended") void c.resume();
  syncMusic();
}

// ---------- Web Audio graph ----------

let ctx: AudioContext | null = null;
let out: GainNode | null = null;

function audio(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  if (!ctx) {
    ctx = new AudioContext();
    out = ctx.createGain();
    out.gain.value = level();
    out.connect(ctx.destination);
  }
  return ctx;
}

// ---------- voice ----------

interface Clip {
  buf: AudioBuffer;
  gain: number;
}
const clips = new Map<string, Promise<Clip | null>>();

/** Decode a clip once and work out the gain that brings its voiced part to TARGET_RMS. */
function load(src: string): Promise<Clip | null> {
  let p = clips.get(src);
  if (!p) {
    const c = audio();
    p = !c
      ? Promise.resolve(null)
      : fetch(BASE + src)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((b) => c.decodeAudioData(b))
          .then((buf) => {
            const d = buf.getChannelData(0);
            const end = Math.min(d.length, Math.floor(MAX_CLIP_S * buf.sampleRate));
            let peak = 0;
            for (let i = 0; i < end; i++) peak = Math.max(peak, Math.abs(d[i]!));
            // RMS over the samples louder than 5% of the peak, so silences don't drag the estimate down.
            let sum = 0;
            let n = 0;
            for (let i = 0; i < end; i++) {
              const v = Math.abs(d[i]!);
              if (v > peak * 0.05) {
                sum += v * v;
                n++;
              }
            }
            const rms = n ? Math.sqrt(sum / n) : 0;
            const gain = rms > 0 ? Math.min(TARGET_RMS / rms, 0.95 / peak, 40) : 1;
            return { buf, gain };
          })
          .catch(() => null);
    clips.set(src, p);
  }
  return p;
}

let voice: AudioBufferSourceNode | null = null;
let unduck: ReturnType<typeof setTimeout> | undefined;

/** Play one clip (a path under /uwu/). Resolves with how long it plays, 0 if it didn't. */
export async function play(src: string, fallback: Cue = "info"): Promise<number> {
  const s = useUwu.getState();
  if (!audible() || !s.voice) return 0;
  const c = audio();
  if (!c || !out) return 0;
  if (c.state === "suspended") void c.resume();
  const clip = await load(src);
  if (!clip) {
    synth(fallback);
    return 0;
  }
  try {
    voice?.stop();
  } catch {
    // already stopped
  }
  const dur = Math.min(clip.buf.duration, MAX_CLIP_S);
  const g = c.createGain();
  const t = c.currentTime;
  const gain = clip.gain * VOICE_LEVEL;
  g.gain.setValueAtTime(gain, t);
  if (clip.buf.duration > MAX_CLIP_S) {
    g.gain.setValueAtTime(gain, t + dur - 0.3);
    g.gain.linearRampToValueAtTime(0, t + dur);
  }
  const node = c.createBufferSource();
  node.buffer = clip.buf;
  node.connect(g).connect(out);
  node.start(t, 0, dur);
  voice = node;
  duck(dur);
  return dur;
}

/** A random clip for this moment. */
export const cue = (kind: Cue) => play(clipFor(kind), kind);

/** Load every clip ahead of time, so the first reaction isn't late. */
export function preload(extra: string[] = []) {
  for (const [k, n] of Object.entries(COUNT))
    for (let i = 1; i <= n; i++) void load(`voice/${k}-${i}.mp3`);
  for (const src of extra) void load(src);
}

// ---------- music ----------

let music: HTMLAudioElement | null = null;
let track = 0;
let fallback = false;
let ducked = false;

const musicVolume = () => Math.min(1, level() * MUSIC_LEVEL * (ducked ? DUCK : 1));

function duck(seconds: number) {
  ducked = true;
  if (music) music.volume = musicVolume();
  clearTimeout(unduck);
  unduck = setTimeout(
    () => {
      ducked = false;
      if (music) music.volume = musicVolume();
    },
    seconds * 1000 + 250,
  );
}

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
  music.volume = musicVolume();
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
  if (out && s.volume !== prev.volume) out.gain.value = level();
  if (!s.on || s.muted || !s.voice) {
    try {
      voice?.stop();
    } catch {
      // already stopped
    }
  }
});

// ---------- UI blips ----------

/** A soft bubble pop for a button press: a quick upward sine sweep. */
export function blip() {
  if (!unlocked || !audible() || !useUwu.getState().blips) return;
  const c = audio();
  if (!c || !out) return;
  const t = c.currentTime + 0.005;
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.setValueAtTime(520, t);
  o.frequency.exponentialRampToValueAtTime(1400, t + 0.07);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.12, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + 0.12);
}

// ---------- fallbacks: Web Audio synth ----------

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
    greet: [84, 91, 96],
    win: [84, 88, 91, 96],
    lose: [76, 72, 67],
    warn: [81, 76],
    info: [88, 95],
    idle: [91, 88],
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
