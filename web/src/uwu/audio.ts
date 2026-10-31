// Every UwU sound is synthesised with Web Audio: no sample files to load or license. A music-box lullaby for the
// background, sparkly chimes for trades, little pops for the UI, and the mascot's voice through speechSynthesis
// (a Japanese voice when the system has one, pitched up).

import { useUwu } from "./store";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let musicBus: GainNode | null = null;

/** Browsers only start audio after a gesture; call this from one (the first pointerdown does). */
export function unlock(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window)) return null;
  if (!ctx) {
    ctx = new AudioContext();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    master = ctx.createGain();
    master.connect(comp).connect(ctx.destination);
    musicBus = ctx.createGain();
    musicBus.gain.value = 0.32;
    musicBus.connect(master);
    syncVolume();
  }
  if (ctx.state === "suspended") void ctx.resume();
  syncMusic();
  return ctx;
}

const audible = () => {
  const s = useUwu.getState();
  return s.on && !s.muted && s.volume > 0;
};

function syncVolume() {
  if (!ctx || !master) return;
  const s = useUwu.getState();
  const v = audible() ? s.volume * s.volume : 0; // squared: a slider that feels linear to the ear
  master.gain.setTargetAtTime(v, ctx.currentTime, 0.05);
}

// ---------- voices of the synth ----------

/** A music-box tine: a sine with a quick bright partial, struck and left to ring. */
function tine(f: number, t: number, dur = 1.2, gain = 0.18, out: AudioNode | null = master) {
  if (!ctx || !out) return;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(out);
  for (const [mult, amp] of [
    [1, 1],
    [3.01, 0.18],
    [5.4, 0.05],
  ] as const) {
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.type = "sine";
    o.frequency.value = f * mult;
    og.gain.value = amp;
    o.connect(og).connect(g);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

/** A soft swept tone (pops, boops and sad slides). */
function sweep(
  f0: number,
  f1: number,
  t: number,
  dur: number,
  gain = 0.15,
  type: OscillatorType = "sine",
) {
  if (!ctx || !master) return;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

// ---------- sound effects ----------

export type Sfx = "win" | "lose" | "warn" | "info" | "pop" | "poke" | "toggle";

export function sfx(kind: Sfx) {
  const s = useUwu.getState();
  if (!audible()) return;
  if ((kind === "pop" || kind === "toggle") && !s.blips) return;
  if ((kind === "win" || kind === "lose" || kind === "warn" || kind === "info") && !s.trades)
    return;
  const c = unlock();
  if (!c) return;
  const t = c.currentTime + 0.01;
  switch (kind) {
    case "win": // a rising sparkle: C E G C E, then a shimmer
      [84, 88, 91, 96, 100].forEach((n, i) => tine(hz(n), t + i * 0.055, 0.9, 0.14));
      [103, 108].forEach((n, i) => tine(hz(n), t + 0.32 + i * 0.07, 0.6, 0.05));
      break;
    case "lose": // a wobbly "uwaa" slide down
      sweep(hz(79), hz(67), t, 0.35, 0.12, "triangle");
      sweep(hz(74), hz(62), t + 0.28, 0.55, 0.12, "triangle");
      break;
    case "warn": // two boops
      sweep(hz(81), hz(80), t, 0.12, 0.12, "square");
      sweep(hz(76), hz(75), t + 0.14, 0.16, 0.1, "square");
      break;
    case "info":
      tine(hz(88), t, 0.7, 0.12);
      tine(hz(95), t + 0.08, 0.7, 0.08);
      break;
    case "pop": // a bubble
      sweep(520, 1400, t, 0.07, 0.12);
      break;
    case "poke":
      sweep(700, 1700, t, 0.09, 0.14);
      sweep(1300, 2200, t + 0.08, 0.08, 0.08);
      break;
    case "toggle":
      tine(hz(91), t, 0.4, 0.1);
      break;
  }
}

// ---------- background music: a looping music-box lullaby ----------

// Four bars a loop at 76 bpm, Fmaj7 → Em7 → Dm7 → Cmaj7 (the lo-fi IV–iii–ii–I), melody over a soft arpeggio.
const BPM = 76;
const STEP = 60 / BPM / 2; // eighth notes
const CHORDS = [
  [53, 57, 60, 64], // Fmaj7
  [52, 55, 59, 62], // Em7
  [50, 53, 57, 60], // Dm7
  [48, 52, 55, 59], // Cmaj7
];
// Melody per bar: 8 eighths, 0 = rest. Two variations alternate so the loop doesn't wear out.
const MELODY = [
  [
    [81, 0, 79, 76, 0, 0, 77, 0],
    [79, 0, 76, 74, 0, 72, 74, 0],
    [77, 0, 76, 74, 0, 0, 72, 0],
    [76, 0, 0, 79, 0, 0, 0, 0],
  ],
  [
    [84, 0, 81, 0, 79, 0, 81, 0],
    [83, 0, 79, 0, 76, 0, 79, 0],
    [81, 0, 77, 0, 74, 76, 77, 0],
    [79, 0, 76, 0, 72, 0, 0, 0],
  ],
];

let timer: ReturnType<typeof setInterval> | null = null;
let nextT = 0;
let step = 0;

function scheduleStep(t: number, i: number) {
  const bar = Math.floor(i / 8) % 4;
  const pos = i % 8;
  const take = Math.floor(i / 32) % 2;
  const chord = CHORDS[bar]!;
  // Arpeggio: up and back down the chord, an octave up, quiet.
  const arp = [0, 1, 2, 3, 2, 1, 2, 3][pos]!;
  tine(hz(chord[arp]! + 12), t, 1.1, 0.07, musicBus);
  // Bass on beats one and three.
  if (pos === 0 || pos === 4) tine(hz(chord[0]! - 12), t, 2.2, 0.12, musicBus);
  const m = MELODY[take]![bar]![pos]!;
  if (m) tine(hz(m), t, 1.6, 0.13, musicBus);
}

function syncMusic() {
  const s = useUwu.getState();
  const want = !!ctx && audible() && s.music;
  if (want && !timer && ctx) {
    nextT = ctx.currentTime + 0.1;
    step = 0;
    timer = setInterval(() => {
      if (!ctx) return;
      // Look 300 ms ahead; a hidden tab throttles timers, so skip forward instead of bursting notes.
      if (nextT < ctx.currentTime - 0.5) nextT = ctx.currentTime + 0.05;
      while (nextT < ctx.currentTime + 0.3) {
        scheduleStep(nextT, step++);
        nextT += STEP;
      }
    }, 100);
  } else if (!want && timer) {
    clearInterval(timer);
    timer = null;
  }
}

// ---------- the mascot's voice ----------

let jaVoice: SpeechSynthesisVoice | null | undefined;

function pickVoice(): SpeechSynthesisVoice | null {
  if (jaVoice !== undefined) return jaVoice;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return null; // not loaded yet; try again next time
  jaVoice =
    vs.find((v) => v.lang.startsWith("ja") && /Kyoko|O-ren|Nanami|Haruka|Mizuki/i.test(v.name)) ??
    vs.find((v) => v.lang.startsWith("ja")) ??
    null;
  return jaVoice;
}

/** Say a short line: Japanese text with a Japanese voice, the English fallback otherwise. */
export function say(ja: string, en: string) {
  const s = useUwu.getState();
  if (!audible() || !s.voices || typeof speechSynthesis === "undefined") return;
  const v = pickVoice();
  const u = new SpeechSynthesisUtterance(v ? ja : en);
  if (v) u.voice = v;
  u.lang = v ? v.lang : "en-US";
  u.pitch = 1.9;
  u.rate = 1.12;
  u.volume = Math.min(1, s.volume * 1.2);
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

// Follow the mixer: volume, mute and the music switch apply at once.
useUwu.subscribe((s, prev) => {
  if (s.volume !== prev.volume || s.muted !== prev.muted || s.on !== prev.on) syncVolume();
  if (
    s.music !== prev.music ||
    s.muted !== prev.muted ||
    s.on !== prev.on ||
    s.volume !== prev.volume
  )
    syncMusic();
  if (!s.on || s.muted || !s.voices) {
    if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
  }
});
