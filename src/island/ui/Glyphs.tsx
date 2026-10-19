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
