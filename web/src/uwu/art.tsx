// Original UwU art, drawn as inline SVG so it scales, themes with CSS variables, and ships no image files.
// Pulse-chan is Impulse's mascot: a chibi girl with cat ears, pink twin tails and a hoodie with the Impulse
// heartbeat on it. With the demo art fetched (`make uwu-assets`) the mascot is
// Anya instead (uwu/Uwu.tsx); Pulse-chan is the fallback when those files are missing.

import { useMemo } from "react";

export type Mood = "idle" | "happy" | "sad" | "shock" | "poke" | "sleepy" | "smug";

const INK = "#3a2350";

function Eye({ cx, cy, mood, right }: { cx: number; cy: number; mood: Mood; right?: boolean }) {
  if (mood === "happy")
    return (
      <path
        d={`M${cx - 11} ${cy + 3} Q${cx} ${cy - 12} ${cx + 11} ${cy + 3}`}
        stroke={INK}
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
      />
    );
  if (mood === "sleepy")
    return (
      <path
        d={`M${cx - 11} ${cy} Q${cx} ${cy + 8} ${cx + 11} ${cy}`}
        stroke={INK}
        strokeWidth="3.5"
        fill="none"
        strokeLinecap="round"
      />
    );
  if (mood === "poke") {
    // >  < squeezed shut
    const d = right ? -1 : 1;
    return (
      <path
        d={`M${cx - 9 * d} ${cy - 9} L${cx + 8 * d} ${cy} L${cx - 9 * d} ${cy + 9}`}
        stroke={INK}
        strokeWidth="4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  }
  const small = mood === "shock";
  return (
    <g className="uwu-eye">
      <ellipse cx={cx} cy={cy} rx="12.5" ry="15.5" fill="#fff" />
      <ellipse
        cx={cx}
        cy={cy + 1.5}
        rx={small ? 6 : 10.5}
        ry={small ? 7.5 : 13.5}
        fill="url(#pc-iris)"
      />
      <ellipse cx={cx} cy={cy + 3} rx={small ? 2.5 : 5} ry={small ? 3.5 : 7} fill="#2a1846" />
      <circle cx={cx - 4} cy={cy - 4.5} r={small ? 2.2 : 4.2} fill="#fff" />
      <circle cx={cx + 4.5} cy={cy + 6} r="1.8" fill="#fff" opacity="0.9" />
      {/* upper lash line with a flick at the outer corner */}
      <path
        d={`M${cx - 14} ${cy - 9} Q${cx} ${cy - 21} ${cx + 14} ${cy - 9}`}
        stroke={INK}
        strokeWidth="3.6"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d={right ? `M${cx + 12} ${cy - 11} l6 -4` : `M${cx - 12} ${cy - 11} l-6 -4`}
        stroke={INK}
        strokeWidth="2.6"
        strokeLinecap="round"
      />
      {mood === "sad" && (
        <path
          d={`M${cx + (right ? 8 : -8)} ${cy + 14} q-3 6 0 9 q3 -3 0 -9z`}
          fill="#9fd8ff"
          stroke="#6fb6ea"
          strokeWidth="1"
          className="uwu-tear"
        />
      )}
    </g>
  );
}

function Mouth({ mood }: { mood: Mood }) {
  switch (mood) {
    case "happy":
    case "poke":
      return (
        <path
          d="M90 135 Q100 151 110 135 Z"
          fill="#ff7aa8"
          stroke={INK}
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      );
    case "sad":
      return (
        <path
          d="M91 142 Q95.5 136.5 100 142 Q104.5 136.5 109 142"
          stroke={INK}
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
        />
      );
    case "shock":
      return (
        <ellipse cx="100" cy="140" rx="4.5" ry="6" fill="#ff7aa8" stroke={INK} strokeWidth="2" />
      );
    case "sleepy":
      return <ellipse cx="100" cy="139" rx="3" ry="2.4" fill={INK} opacity="0.8" />;
    default: // ω
      return (
        <path
          d="M91 136 Q95.5 143 100 136 Q104.5 143 109 136"
          stroke={INK}
          strokeWidth="2.2"
          fill="none"
          strokeLinecap="round"
        />
      );
  }
}

/** One twin tail, drawn on the left; the right one is its mirror. */
const TAIL =
  "M54 84 C24 104 10 150 22 196 C28 218 38 230 30 242 C52 232 56 206 52 182 C48 150 56 120 66 100 Z";
/** One cat ear, drawn on the left. */
const EAR = "M50 66 L40 16 L84 44 Z";
const EAR_IN = "M53 58 L47 28 L73 45 Z";
/** One side lock framing the face. */
const LOCK = "M48 92 C38 124 42 150 54 168 C54 146 58 124 62 104 Z";

export function PulseChan({ mood = "idle", size = 150 }: { mood?: Mood; size?: number }) {
  const flip = "translate(200 0) scale(-1 1)";
  return (
    <svg
      className={`pulse-chan mood-${mood}`}
      width={size}
      height={(size * 240) / 200}
      viewBox="0 0 200 240"
      role="img"
      aria-label="Pulse-chan, the Impulse mascot"
    >
      <defs>
        <linearGradient id="pc-hair" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffc4e1" />
          <stop offset="0.6" stopColor="#f7a8d4" />
          <stop offset="1" stopColor="#c7b0ff" />
        </linearGradient>
        <linearGradient id="pc-iris" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5b3fc4" />
          <stop offset="0.55" stopColor="#a35de0" />
          <stop offset="1" stopColor="#ff9ad0" />
        </linearGradient>
        <linearGradient id="pc-hoodie" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#363a7a" />
          <stop offset="1" stopColor="#24275a" />
        </linearGradient>
      </defs>

      {/* twin tails, swaying behind */}
      <g className="uwu-tail l">
        <path d={TAIL} fill="url(#pc-hair)" stroke="#e58fbf" strokeWidth="1.5" />
      </g>
      <g transform={flip}>
        <g className="uwu-tail r">
          <path d={TAIL} fill="url(#pc-hair)" stroke="#e58fbf" strokeWidth="1.5" />
        </g>
      </g>

      {/* hoodie */}
      <path
        d="M56 200 Q58 170 100 166 Q142 170 144 200 L154 240 L46 240 Z"
        fill="url(#pc-hoodie)"
      />
      <path d="M86 168 L100 192 L114 168 Z" fill="#fff6fb" />
      <path
        d="M90 176 L88 206 M110 176 L112 206"
        stroke="#ffd1e8"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <circle cx="88" cy="208" r="2.6" fill="#ffd1e8" />
      <circle cx="112" cy="208" r="2.6" fill="#ffd1e8" />
      <path
        d="M78 222 h9 l4 -9 l6 16 l4 -9 h11"
        stroke="#9ff0d0"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* sleeves */}
      <path d="M58 194 Q38 214 44 240 L66 240 Q64 218 72 204 Z" fill="#2e3270" />
      <path d="M142 194 Q162 214 156 240 L134 240 Q136 218 128 204 Z" fill="#2e3270" />

      {/* neck */}
      <rect x="91" y="146" width="18" height="24" rx="6" fill="#f6d3ca" />

      {/* back hair and ears */}
      <circle cx="100" cy="96" r="64" fill="url(#pc-hair)" />
      <path
        d={EAR}
        fill="url(#pc-hair)"
        stroke="#e58fbf"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d={EAR_IN} fill="#ffe3f1" />
      <g transform={flip}>
        <path
          d={EAR}
          fill="url(#pc-hair)"
          stroke="#e58fbf"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path d={EAR_IN} fill="#ffe3f1" />
      </g>

      {/* face */}
      <path
        d="M48 100 Q48 150 100 158 Q152 150 152 100 Q152 60 100 60 Q48 60 48 100 Z"
        fill="#fff0ea"
      />

      {/* eyes, brows, blush, mouth */}
      {(mood === "sad" || mood === "shock") && (
        <g stroke={INK} strokeWidth="2.4" strokeLinecap="round" fill="none">
          <path d={mood === "sad" ? "M68 86 L86 82" : "M66 82 Q77 75 88 81"} />
          <path d={mood === "sad" ? "M132 86 L114 82" : "M134 82 Q123 75 112 81"} />
        </g>
      )}
      <g className="uwu-eyes">
        <Eye cx={77} cy={112} mood={mood} />
        <Eye cx={123} cy={112} mood={mood} right />
      </g>
      <g className="uwu-blush">
        <ellipse cx="64" cy="133" rx="11" ry="6" fill="#ff9cc8" opacity="0.55" />
        <ellipse cx="136" cy="133" rx="11" ry="6" fill="#ff9cc8" opacity="0.55" />
        <path
          d="M58 135 l3 -5 M63 135 l3 -5 M68 135 l3 -5 M130 135 l3 -5 M135 135 l3 -5 M140 135 l3 -5"
          stroke="#f27bb0"
          strokeWidth="1.4"
          strokeLinecap="round"
        />
      </g>
      <Mouth mood={mood} />

      {/* bangs, side locks, ahoge */}
      <path d={LOCK} fill="url(#pc-hair)" />
      <path d={LOCK} transform={flip} fill="url(#pc-hair)" />
      <path
        d="M44 106 Q40 48 100 40 Q160 48 156 106 L150 86 L142 104 L134 74 L122 98 L112 68 L101 94 L90 68 L79 98 L67 74 L58 104 L50 86 Z"
        fill="url(#pc-hair)"
        stroke="#e58fbf"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M98 42 Q86 18 106 10 Q96 24 104 42 Z" fill="#f7a8d4" className="uwu-ahoge" />

      {/* ribbons where the tails tie, and a star clip */}
      {[48, 152].map((x) => (
        <g key={x} transform={`translate(${x} 86)`}>
          <path
            d="M0 0 L-12 -8 L-12 8 Z M0 0 L12 -8 L12 8 Z"
            fill="#9ff0d0"
            stroke="#5fcfa8"
            strokeWidth="1.2"
            strokeLinejoin="round"
          />
          <circle r="3.5" fill="#bdf7e1" stroke="#5fcfa8" strokeWidth="1.2" />
        </g>
      ))}
      <path
        transform="translate(136 58) scale(0.9)"
        d="M0 -10 L3 -3 L10 -3 L4.5 1.5 L6.5 9 L0 4.5 L-6.5 9 L-4.5 1.5 L-10 -3 L-3 -3 Z"
        fill="#ffe27a"
        stroke="#f0b93c"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** A small deterministic random sequence, so the star field is the same on every render. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const CLOUD =
  "M0 60 Q0 34 26 34 Q30 12 56 14 Q74 0 96 12 Q122 6 132 28 Q160 26 164 46 Q186 46 190 60 Z";

/**
 * The chart's backdrop: a night sky with twinkling stars, a sleepy moon, shooting stars and drifting clouds. In
 * light mode a smiling sun takes the moon's place.
 */
export function ChartScene() {
  const stars = useMemo(() => {
    const r = rng(7);
    return Array.from({ length: 70 }, (_, i) => ({
      x: r() * 100,
      y: r() * 78,
      s: r() < 0.12 ? 2.4 : r() < 0.5 ? 1.5 : 1,
      d: (r() * 4).toFixed(2),
      tw: i % 3 === 0,
    }));
  }, []);
  return (
    <div className="uwu-scene" aria-hidden="true">
      <svg className="uwu-stars" width="100%" height="100%" preserveAspectRatio="none">
        {stars.map((s, i) => (
          <circle
            key={i}
            cx={`${s.x}%`}
            cy={`${s.y}%`}
            r={s.s}
            className={s.tw ? "tw" : undefined}
            style={s.tw ? { animationDelay: `${s.d}s` } : undefined}
          />
        ))}
      </svg>
      <span className="uwu-shoot" />
      <span className="uwu-shoot b" />
      <svg className="uwu-moon" viewBox="0 0 80 80" width="64" height="64">
        <defs>
          <mask id="uwu-crescent">
            <rect width="80" height="80" fill="#fff" />
            <circle cx="54" cy="30" r="28" fill="#000" />
          </mask>
        </defs>
        <circle cx="40" cy="40" r="30" fill="#fff4c9" mask="url(#uwu-crescent)" />
        <path
          d="M19 44 q4 4 8 0"
          stroke="#c9a85a"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
        <ellipse cx="22" cy="52" rx="4" ry="2.4" fill="#ffb0c8" opacity="0.7" />
      </svg>
      <svg className="uwu-sun" viewBox="0 0 80 80" width="64" height="64">
        <g className="uwu-sun-rays" stroke="#ffc54a" strokeWidth="5" strokeLinecap="round">
          {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
            <line key={a} x1="40" y1="12" x2="40" y2="5" transform={`rotate(${a} 40 40)`} />
          ))}
        </g>
        <circle cx="40" cy="40" r="22" fill="#ffd95e" stroke="#ffbf3f" strokeWidth="2" />
        <g stroke="#8a5216" strokeWidth="2.2" strokeLinecap="round" fill="none">
          <path d="M30.5 38 q3 -4 6 0" />
          <path d="M43.5 38 q3 -4 6 0" />
          <path d="M36 45.5 q4 4 8 0" />
        </g>
        <ellipse cx="28.5" cy="45.5" rx="3.6" ry="2.2" fill="#ff9fb8" opacity="0.85" />
        <ellipse cx="51.5" cy="45.5" rx="3.6" ry="2.2" fill="#ff9fb8" opacity="0.85" />
      </svg>
      <div className="uwu-clouds back">
        <svg viewBox="0 0 760 70" preserveAspectRatio="none">
          {[0, 190, 380, 570].map((x) => (
            <path key={x} d={CLOUD} transform={`translate(${x} 4)`} />
          ))}
        </svg>
        <svg viewBox="0 0 760 70" preserveAspectRatio="none">
          {[0, 190, 380, 570].map((x) => (
            <path key={x} d={CLOUD} transform={`translate(${x} 4)`} />
          ))}
        </svg>
      </div>
      <div className="uwu-clouds front">
        <svg viewBox="0 0 760 70" preserveAspectRatio="none">
          {[-60, 150, 360, 560].map((x) => (
            <path key={x} d={CLOUD} transform={`translate(${x} 10)`} />
          ))}
        </svg>
        <svg viewBox="0 0 760 70" preserveAspectRatio="none">
          {[-60, 150, 360, 560].map((x) => (
            <path key={x} d={CLOUD} transform={`translate(${x} 10)`} />
          ))}
        </svg>
      </div>
    </div>
  );
}
