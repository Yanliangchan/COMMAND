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

/** Landmark drawn in map units, centred on (0,0), roughly 18 units tall. */
export function LandmarkGlyph({ kind }: { kind: Landmark }) {
  const fill = 'rgba(255,255,255,0.92)';
  const stroke = 'rgba(20,30,40,0.55)';
  const common = { fill, stroke, strokeWidth: 0.8, strokeLinejoin: 'round' as const };
  switch (kind) {
    case 'towers':
      return (
        <g {...common}>
          <rect x={-8} y={-6} width={4} height={14} />
          <rect x={-2} y={-6} width={4} height={14} />
          <rect x={4} y={-6} width={4} height={14} />
          <path d="M-11 -9 Q0 -11 11 -9 L11 -6 L-11 -6Z" />
        </g>
      );
    case 'tower':
      return (
        <g {...common}>
          <rect x={-1.6} y={-4} width={3.2} height={12} />
          <path d="M-5 -6 L5 -6 L4 -11 L-4 -11Z" />
        </g>
      );
    case 'refinery':
      return (
        <g {...common}>
          <rect x={-8} y={-9} width={3} height={17} />
          <rect x={-3} y={-6} width={3} height={14} />
          <circle cx={5} cy={3} r={5} />
        </g>
      );
    case 'palm':
      return (
        <g {...common}>
          <path d="M0 8 Q1 0 -1 -5" fill="none" strokeWidth={2.4} stroke={fill} />
          <path d="M-1 -5 Q-7 -9 -11 -4 Q-6 -6 -1 -5 Q3 -11 9 -8 Q3 -7 -1 -5 Q4 -4 7 1 Q2 -3 -1 -5" />
        </g>
      );
    case 'camp':
      return (
        <g {...common}>
          <path d="M-9 8 L0 -4 L9 8Z" />
          <path d="M0 -4 L0 -12 L6 -10 L0 -8" />
        </g>
      );
    case 'hill':
      return (
        <g {...common}>
          <path d="M-11 7 L-3 -7 L1 -1 L4 -5 L11 7Z" />
        </g>
      );
    case 'causeway':
      return (
        <g {...common}>
          <path d="M-12 2 L12 2 L12 6 L8 6 Q6 2 4 6 L2 6 Q0 2 -2 6 L-4 6 Q-6 2 -8 6 L-12 6Z" />
        </g>
      );
    case 'stadium':
      return (
        <g {...common}>
          <path d="M-11 5 Q0 -12 11 5Z" />
          <path d="M-7 5 Q0 -5 7 5" fill="none" />
        </g>
      );
    case 'airbase':
      return (
        <g {...common} transform="scale(0.75)">
          <path d="M12 2l1.6 6.2 8 4v2.2l-8-2-.8 5 3 2v2L12 20.5l-3.8.9v-2l3-2-.8-5-8 2v-2.2l8-4z" transform="translate(-12 -12)" />
        </g>
      );
    case 'port':
      return (
        <g {...common}>
          <path d="M-8 8 L-8 -9 L9 -9 L9 -6 L-5 -6 L-5 8Z" />
          <path d="M6 -6 L6 0" fill="none" />
          <rect x={3} y={0} width={6} height={4} />
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
