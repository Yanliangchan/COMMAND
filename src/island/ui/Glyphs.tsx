// Small hand-drawn SVG glyphs: faction emblems, card kinds and map landmarks.

import type { Landmark } from '../map';
import type { FactionId } from '../types';

const EMBLEM_PATHS: Record<FactionId, string> = {
  // Singa: a lion's face in its mane.
  SINGA: 'M12.0 0.5 L13.9 3.6 L17.0 1.6 L17.4 5.3 L21.0 4.8 L19.7 8.3 L23.2 9.4 L20.6 12.0 L23.2 14.6 L19.7 15.7 L21.0 19.2 L17.4 18.7 L17.0 22.4 L13.9 20.4 L12.0 23.5 L10.1 20.4 L7.0 22.4 L6.6 18.7 L3.0 19.2 L4.3 15.7 L0.8 14.6 L3.4 12.0 L0.8 9.4 L4.3 8.3 L3.0 4.8 L6.6 5.3 L7.0 1.6 L10.1 3.6Z M12 6.3a5.7 5.7 0 1 0 0.01 0Z M9.6 11a1 1 0 1 0 0.01 0Z M14.4 11a1 1 0 1 0 0.01 0Z M10.6 14.2h2.8l-1.4 1.6z',
  // Harimau: three claw marks.
  HARIMAU: 'M5 3.5c3 3 4.5 9 3.6 17l-2.2-.3c.6-7-.6-12-3-15zM11 2.5c3 3.5 4.3 10 3.3 18.5l-2.3-.2c.7-7.6-.4-13.4-2.9-16.6zM17.3 3.5c2.7 3 3.8 8.7 3 16.4l-2.2-.3c.5-6.6-.4-11.6-2.6-14.5z',
  // Helang: spread wings and head.
  HELANG: 'M12 4.2a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zM1 9.5l8 2.6 3 3 3-3 8-2.6-3.6 4.4-4.7 1.8-2.7 5.1-2.7-5.1-4.7-1.8z',
  // Jerung: a dorsal fin cutting the water.
  JERUNG: 'M4 16.5C8 15.8 11.2 12 13.2 3.5c1.2 5.2 3.4 10 7.8 13zM2 19.2c2-1.4 3.6-1.4 5 0s3 1.4 5 0 3-1.4 5 0 3 1.4 5 0v2c-2 1.4-3.6 1.4-5 0s-3-1.4-5 0-3 1.4-5 0-3-1.4-5 0z',
};

export function Emblem({ faction, size = 24, color = 'currentColor' }: { faction: FactionId; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={EMBLEM_PATHS[faction]} fill={color} fillRule="evenodd" />
    </svg>
  );
}

/** An emblem as a bare path in map units, centred on (0,0) and `size` across: for badges and ship hulls. */
export function EmblemMark({ faction, size = 10, color = '#fff' }: { faction: FactionId; size?: number; color?: string }) {
  return <path d={EMBLEM_PATHS[faction]} transform={`translate(${-size / 2} ${-size / 2}) scale(${size / 24})`} fill={color} fillRule="evenodd" />;
}

// Landmarks are little cream "miniatures" standing on the board: one ink
// stroke weight, a lit face and a shaded face, and a soft ground shadow.
const LM_FILL = '#fffaf0';
const LM_SHADE = '#d9ccb2';
const LM_INK = '#1c2a38';

/** Landmark drawn in map units, centred on (0,0), roughly 18 units tall, standing on y = 8. */
export function LandmarkGlyph({ kind }: { kind: Landmark }) {
  const common = { fill: LM_FILL, stroke: LM_INK, strokeWidth: 1.1, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const };
  const shade = { fill: LM_SHADE, stroke: 'none' };
  const ground = (rx = 11) => <ellipse cx={0.8} cy={8.6} rx={rx} ry={2.4} fill="rgba(8,20,32,0.38)" stroke="none" />;
  switch (kind) {
    case 'towers':
      return (
        <g {...common}>
          {ground(12)}
          {[-8, -2, 4].map((x) => (
            <g key={x}>
              <rect x={x} y={-5.5} width={4} height={13.5} />
              <rect x={x + 2.3} y={-4.9} width={1.2} height={12.4} {...shade} />
            </g>
          ))}
          <path d="M-12 -9.2 Q0 -11.2 12.5 -9.6 L11 -6 L-11 -6Z" />
        </g>
      );
    case 'tower':
      return (
        <g {...common}>
          {ground(7)}
          <rect x={-1.9} y={-3.5} width={3.8} height={11.5} />
          <rect x={0.4} y={-3} width={1.1} height={10.6} {...shade} />
          <path d="M-5.5 -3.5 L5.5 -3.5 L4.3 -9.8 L-4.3 -9.8Z" />
          <rect x={-4.6} y={-8.4} width={9.2} height={2.6} fill={LM_INK} stroke="none" opacity={0.8} />
          <path d="M0 -9.8 V-13.5" fill="none" />
        </g>
      );
    case 'refinery':
      return (
        <g {...common}>
          {ground(12)}
          <rect x={-9} y={-9} width={3.2} height={17} />
          <rect x={-4} y={-5.5} width={3.2} height={13.5} />
          <path d="M-9 -7 H-5.8 M-4 -3.5 H-0.8" />
          <circle cx={5.5} cy={3} r={5} />
          <path d="M8.5 -0.8 A5 5 0 0 1 5.5 8 A6.5 6.5 0 0 0 8.5 -0.8Z" {...shade} />
          <circle cx={-7.4} cy={-12} r={1.9} strokeWidth={0.8} />
          <circle cx={-5} cy={-14.6} r={1.4} strokeWidth={0.8} />
        </g>
      );
    case 'palm':
      return (
        <g {...common}>
          {ground(7)}
          <path d="M0.5 8 Q1.5 0 -1 -5" fill="none" stroke={LM_INK} strokeWidth={3.4} />
          <path d="M0.5 8 Q1.5 0 -1 -5" fill="none" stroke={LM_FILL} strokeWidth={1.5} />
          <path d="M-1 -5 Q-7 -9.5 -11.5 -4 Q-6 -6.2 -1 -5 Q3 -11.5 9.5 -8 Q3.5 -7 -1 -5 Q4.5 -4 7.5 1.5 Q2 -3 -1 -5 Q-5 -3 -7 1.5 Q-4.5 -4.6 -1 -5" />
          <circle cx={0.6} cy={-4} r={1.3} fill={LM_INK} stroke="none" />
        </g>
      );
    case 'camp':
      return (
        <g {...common}>
          {ground(10)}
          <path d="M-9.5 8 L0 -3.5 L9.5 8Z" />
          <path d="M0 -3.5 L9.5 8 L3 8Z" {...shade} />
          <path d="M-1.9 8 L0 3.5 L1.9 8Z" fill={LM_INK} stroke="none" />
          <path d="M0 -3.5 V-13" fill="none" />
          <path d="M0 -13 L7 -11 L0 -9Z" fill="#ffc83d" />
        </g>
      );
    case 'hill':
      return (
        <g {...common}>
          {ground(12)}
          <path d="M-12 8 L-4 -7.5 L0 -1.5 L4 -6 L12 8Z" />
          <path d="M-4 -7.5 L0 -1.5 L-1.2 8 H-6 Z M4 -6 L12 8 H5.5 L2.2 -2.5Z" {...shade} />
          <path d="M-6.4 -3 L-4 -7.5 L-1.8 -4.2 L-3.8 -3.4Z" fill="#fff" strokeWidth={0.7} />
        </g>
      );
    case 'causeway': {
      let d = 'M-12.5 -1 H12.5 V7';
      for (let i = 3; i >= 0; i--) {
        const x0 = -12.5 + i * 6.25;
        d += ` H${(x0 + 5.2).toFixed(2)} Q${(x0 + 3.1).toFixed(2)} 1.6 ${(x0 + 1).toFixed(2)} 7`;
      }
      d += ' H-12.5Z';
      return (
        <g {...common}>
          {ground(13)}
          <path d={d} />
          <rect x={-12.5} y={-1} width={25} height={2.4} {...shade} />
          <path d="M-12.5 -3.6 H12.5 M-10 -3.6 V-1 M-3.5 -3.6 V-1 M3 -3.6 V-1 M9.5 -3.6 V-1" fill="none" strokeWidth={0.9} />
        </g>
      );
    }
    case 'stadium':
      return (
        <g {...common}>
          {ground(13)}
          <path d="M-12 6 Q0 -13 12 6Z" />
          <path d="M3 -3 Q9 0 12 6 H6 Q5 0 3 -3Z" {...shade} />
          <path d="M-6 6 Q-4 -2.5 0 -3.4 Q4 -2.5 6 6" fill="none" strokeWidth={0.8} />
          <rect x={-13} y={6} width={26} height={2.4} />
        </g>
      );
    case 'airbase':
      return (
        <g {...common}>
          {ground(12)}
          <rect x={-12} y={3.6} width={24} height={4.4} rx={1} {...shade} stroke={LM_INK} strokeWidth={1.1} />
          <path d="M-9 5.8 H-6 M-3 5.8 H0 M3 5.8 H6" stroke={LM_FILL} strokeWidth={1} fill="none" />
          <path d="M12 2l1.6 6.2 8 4v2.2l-8-2-.8 5 3 2v2L12 20.5l-3.8.9v-2l3-2-.8-5-8 2v-2.2l8-4z" transform="translate(-7.8 -12.6) scale(0.65)" strokeWidth={1.5} />
        </g>
      );
    case 'port':
      return (
        <g {...common}>
          {ground(12)}
          <path d="M-8 8 V-9 H10 V-6 H-5 V8Z" />
          <path d="M-6.4 -7.6 V8 H-5 V-6Z" {...shade} />
          <path d="M6.5 -6 V-0.5" fill="none" />
          <rect x={1} y={2} width={10} height={6} />
          <rect x={6} y={2.6} width={4.4} height={4.8} {...shade} />
          <path d="M1 5 H11" fill="none" strokeWidth={0.8} />
        </g>
      );
  }
}

// ---------------------------------------------------------------------------
// Interface icons — one drawn set for every button, card and order row, so the
// HUD never falls back to whatever emoji font the device happens to have.
// ---------------------------------------------------------------------------

export type IconName =
  | 'deploy' | 'move' | 'strike' | 'cas' | 'recon' | 'anchor' | 'ship' | 'star' | 'close' | 'skip' | 'pause' | 'play'
  | 'sound' | 'mute' | 'help' | 'log' | 'exit' | 'undo' | 'clear' | 'orders' | 'zoomIn' | 'zoomOut' | 'fit' | 'up' | 'down' | 'shield' | 'flag' | 'cross' | 'eye' | 'plane';

const ICON_PATHS: Record<IconName, string> = {
  deploy: 'M12 4v16M4 12h16',
  move: 'M4 12h13M12 6l6 6-6 6',
  strike: 'M12 2v6M12 16v6M2 12h6M16 12h6M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  cas: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
  recon: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  anchor: 'M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM12 7v14M7 10h10M4 14c0 4 4 7 8 7s8-3 8-7',
  ship: 'M3 14h18l-3 5H6zM6 14V10h12v4M11 10V5h2v5',
  star: 'M12 2.5l2.9 6 6.6.8-4.9 4.5 1.3 6.5L12 17.1l-5.9 3.2 1.3-6.5-4.9-4.5 6.6-.8z',
  close: 'M6 6l12 12M18 6L6 18',
  skip: 'M5 5l9 7-9 7zM17 5v14',
  pause: 'M7 5v14M17 5v14',
  play: 'M7 5l12 7-12 7z',
  sound: 'M4 9h4l5-4v14l-5-4H4zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11',
  mute: 'M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6',
  help: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5v.01',
  log: 'M5 5h14M5 10h14M5 15h10M5 20h7',
  exit: 'M14 4h5v16h-5M10 8l-4 4 4 4M6 12h10',
  undo: 'M9 7L4 12l5 5M4 12h11a5 5 0 0 1 0 10h-2',
  clear: 'M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13',
  orders: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  zoomIn: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M11 8v6M8 11h6',
  zoomOut: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-5-5M8 11h6',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  cross: 'M6 6l12 12M18 6L6 18',
  plane: 'M12 2l1.6 6.2 8 4v2.2l-8-2-.8 5 3 2v2L12 20.5l-3.8.9v-2l3-2-.8-5-8 2v-2.2l8-4z',
};

/** Filled icons; the rest are stroked. */
const FILLED: Partial<Record<IconName, boolean>> = { star: true, play: true, skip: true, plane: true };

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  const filled = FILLED[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={className}
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={2.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
