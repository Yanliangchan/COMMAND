import React from 'react';
import { TERRAIN_COLORS } from '../render/colors';

/**
 * Tiny SVG battlefield used by the tutorial. Rows of characters describe the
 * ground; markers are painted on top. Deliberately drawn in the same palette
 * as the real sheet so what the tutorial shows matches what the player sees.
 */
const GROUND: Record<string, string> = {
  '.': TERRAIN_COLORS.OPEN.base,
  g: TERRAIN_COLORS.GRASS.base,
  f: TERRAIN_COLORS.FOREST.base,
  h: TERRAIN_COLORS.HILLS.base,
  u: TERRAIN_COLORS.URBAN.base,
  w: TERRAIN_COLORS.WATER.base,
  b: TERRAIN_COLORS.BEACH.base,
  r: '#c9bb95',
};

export type MarkerKind = 'blue' | 'red' | 'ghost' | 'move' | 'attack' | 'recon' | 'objective' | 'fortify' | 'arrow';

export interface Marker {
  x: number;
  y: number;
  kind: MarkerKind;
  text?: string;
}

const CELL = 30;

export const TutorialDiagram: React.FC<{ rows: string[]; markers?: Marker[]; caption?: string }> = ({ rows, markers = [], caption }) => {
  const w = rows[0].length * CELL;
  const h = rows.length * CELL;
  return (
    <figure className="tut-figure">
      <svg viewBox={`0 0 ${w} ${h}`} width="100%" style={{ maxWidth: w, display: 'block' }} role="img" aria-label={caption ?? 'battlefield diagram'}>
        {rows.map((row, y) =>
          row.split('').map((c, x) => (
            <rect key={`${x}-${y}`} x={x * CELL} y={y * CELL} width={CELL} height={CELL} fill={GROUND[c] ?? GROUND['.']} />
          ))
        )}
        {rows.map((_row, y) => (
          <line key={`hl${y}`} x1={0} y1={y * CELL} x2={w} y2={y * CELL} stroke="rgba(0,0,0,0.18)" strokeWidth={1} />
        ))}
        {rows[0].split('').map((_c, x) => (
          <line key={`vl${x}`} x1={x * CELL} y1={0} x2={x * CELL} y2={h} stroke="rgba(0,0,0,0.18)" strokeWidth={1} />
        ))}
        {markers.map((m, i) => {
          const cx = m.x * CELL + CELL / 2;
          const cy = m.y * CELL + CELL / 2;
          switch (m.kind) {
            case 'move':
              return (
                <rect
                  key={i}
                  x={m.x * CELL + 1}
                  y={m.y * CELL + 1}
                  width={CELL - 2}
                  height={CELL - 2}
                  fill="rgba(207,154,68,0.35)"
                  stroke="rgba(230,182,101,0.8)"
                />
              );
            case 'attack':
              return (
                <rect
                  key={i}
                  x={m.x * CELL + 1}
                  y={m.y * CELL + 1}
                  width={CELL - 2}
                  height={CELL - 2}
                  fill="rgba(193,82,74,0.28)"
                  stroke="rgba(193,82,74,0.85)"
                  strokeDasharray="4 3"
                />
              );
            case 'recon':
              return (
                <rect
                  key={i}
                  x={m.x * CELL + 1}
                  y={m.y * CELL + 1}
                  width={CELL - 2}
                  height={CELL - 2}
                  fill="rgba(147,163,95,0.28)"
                  stroke="rgba(180,196,127,0.8)"
                  strokeDasharray="3 3"
                />
              );
            case 'objective':
              return (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={11} fill="rgba(207,154,68,0.35)" stroke="#cf9a44" strokeWidth={2} />
                  <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fill="#1a140a">
                    ★
                  </text>
                </g>
              );
            case 'ghost':
              return (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={10} fill="rgba(193,82,74,0.25)" stroke="#c1524a" strokeDasharray="3 2" strokeWidth={1.5} />
                  <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fill="#ffd9d2">
                    ?
                  </text>
                </g>
              );
            case 'fortify':
              return (
                <path
                  key={i}
                  d={`M ${cx - 13} ${cy + 9} A 13 13 0 0 1 ${cx + 13} ${cy + 9}`}
                  fill="none"
                  stroke="#cf9a44"
                  strokeWidth={3}
                />
              );
            case 'arrow':
              return (
                <text key={i} x={cx} y={cy + 6} textAnchor="middle" fontSize={18} fill="#e6b665">
                  {m.text ?? '→'}
                </text>
              );
            default: {
              const blue = m.kind === 'blue';
              return (
                <g key={i}>
                  <circle cx={cx} cy={cy} r={11} fill={blue ? '#0f2e3d' : '#3d211a'} stroke={blue ? '#6fa8c9' : '#c17a5f'} strokeWidth={2.5} />
                  <text
                    x={cx}
                    y={cy + 4}
                    textAnchor="middle"
                    fontSize={10}
                    fontFamily="monospace"
                    fill={blue ? '#6fa8c9' : '#c17a5f'}
                  >
                    {m.text ?? (blue ? 'IN' : 'IN')}
                  </text>
                </g>
              );
            }
          }
        })}
      </svg>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
};
