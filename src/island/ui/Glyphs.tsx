// Small hand-drawn SVG glyphs: faction emblems, card kinds and map landmarks.

import type { Landmark } from '../map';
import type { CardKind, FactionId } from '../types';

const EMBLEM_PATHS: Record<FactionId, string> = {
  ARMY: 'M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17l-6.1 3.4 1.5-6.8L2.2 9l6.9-.7z',
  NAVY:
    'M12 1.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM10.8 6.5h2.4v12.3c2.6-.4 4.6-2.2 5.2-4.6h-2.1l3.2-3.4 3.2 3.4h-1.8c-.8 4-4.6 7.3-8.9 7.3s-8.1-3.3-8.9-7.3H1.3l3.2-3.4 3.2 3.4H5.6c.6 2.4 2.6 4.2 5.2 4.6zM7.5 9h9v2.2h-9z',
  AIRFORCE: 'M12 1.5l1.8 7 8.7 4.3v2.4l-8.6-2.2-.9 5.4 3.3 2.2v2.1L12 21.6l-4.3 1.1v-2.1l3.3-2.2-.9-5.4-8.6 2.2v-2.4l8.7-4.3z',
  COMMANDO: 'M12 1l2.2 4.2v9.3h3.4v2.3h-3.4v2.4a2.2 2.2 0 1 1-4.4 0v-2.4H6.4v-2.3h3.4V5.2z',
  DIS: 'M12 4.5c5.4 0 9.6 4.7 10.6 7.5-1 2.8-5.2 7.5-10.6 7.5S2.4 14.8 1.4 12C2.4 9.2 6.6 4.5 12 4.5zm0 3a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9zm0 2.7a1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1 0-3.6z',
};

export function Emblem({ faction, size = 24, color = 'currentColor' }: { faction: FactionId; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={EMBLEM_PATHS[faction]} fill={color} fillRule="evenodd" />
    </svg>
  );
}

const KIND_PATHS: Record<CardKind, string> = {
  LAND: 'M2 15h20l-2.5 4.5h-15zM5 10.5h10l2.5 4.5H4zM14.5 11.2l7-2.4v1.8l-7 2.4z',
  SEA: 'M1.5 15h21l-3.5 5H5zM5.5 11h12.5l1 4H4.5zM9.5 6.5h5V11h-5zM11.4 2.5h1.2v4h-1.2z',
  AIR: 'M12 2l1.6 6.2 8 4v2.2l-8-2-.8 5 3 2v2L12 20.5l-3.8.9v-2l3-2-.8-5-8 2v-2.2l8-4z',
  WILD: 'M12 2l2.9 6.3 6.9.7-5.2 4.6 1.5 6.8L12 17l-6.1 3.4 1.5-6.8L2.2 9l6.9-.7z',
};

export function KindIcon({ kind, size = 22 }: { kind: CardKind; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={KIND_PATHS[kind]} fill="currentColor" />
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
          <path d={KIND_PATHS.AIR} transform="translate(-12 -12)" />
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
