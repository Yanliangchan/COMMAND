// ============================================================================
// The board, drawn as a tabletop diorama: a raised island on a patterned sea,
// regions painted in their owner's colour, chunky troop badges, landmarks.
// ============================================================================

import { memo } from 'react';
import { BOARD, SECTORS, SECTOR_IDS, polyPath } from '../map';
import { FACTIONS, FactionId, Holding } from '../types';
import { LandmarkGlyph } from './Glyphs';

export type Highlight = 'source' | 'attack' | 'amphibious' | 'strike' | 'friendly' | 'place';

export interface Fx {
  id: string;
  kind: 'ripple' | 'blast';
  region: string;
  color: string;
}

export interface Arrow {
  from: string;
  to: string;
  color: string;
}

interface Props {
  holdings: Record<string, Holding>;
  highlights?: Record<string, Highlight>;
  fx?: Fx[];
  arrow?: Arrow | null;
  onRegion?: (id: string) => void;
  showBadges?: boolean;
  showLabels?: boolean;
  /** Fade every region without a highlight, so the live choices pop. */
  dimOthers?: boolean;
}

const MAIN_PATH = polyPath(BOARD.mainland);
const ISLAND_PATHS = BOARD.islands.map((i) => ({ id: i.id, d: polyPath(i.poly) }));
const REGION_PATHS = Object.fromEntries(BOARD.regions.map((r) => [r.id, polyPath(r.poly)]));
const SECTOR_BORDERS = BOARD.borders.filter((b) => BOARD.byId[b.a].sector !== BOARD.byId[b.b].sector);

function badgeRadius(troops: number) {
  return 12 + Math.min(troops, 40) * 0.22;
}

function arrowPath(a: string, b: string): string {
  const [x1, y1] = BOARD.byId[a].site;
  const [x2, y2] = BOARD.byId[b].site;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1);
  // Bow the arrow upward, and stop it short of the target badge.
  const cx = mx - ((y2 - y1) / len) * len * 0.25, cy = my + ((x2 - x1) / len) * len * 0.25 - len * 0.1;
  const t = 1 - 22 / len;
  const ex = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
  const ey = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
  return `M${x1},${y1} Q${cx},${cy} ${ex},${ey}`;
}

function SeaAndBase() {
  return (
    <>
      <rect x={-200} y={-200} width={1400} height={1020} fill="url(#io-sea)" />
      <rect x={-200} y={-200} width={1400} height={1020} fill="url(#io-waves)" opacity={0.5} />
      {/* Crossings: bridges, causeways and ferry runs, drawn at sea level. */}
      {BOARD.crossings.map(([a, b]) => {
        const p = BOARD.byId[a].site, q = BOARD.byId[b].site;
        return (
          <line key={a + b} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} className="io-crossing" />
        );
      })}
      {/* Surf, then the earthen side of the diorama base. */}
      <g className="io-surf">
        <path d={MAIN_PATH} />
        {ISLAND_PATHS.map((i) => <path key={i.id} d={i.d} />)}
      </g>
      <g transform="translate(0 9)" fill="#5a4330">
        <path d={MAIN_PATH} />
        {ISLAND_PATHS.map((i) => <path key={i.id} d={i.d} />)}
      </g>
      <g transform="translate(0 5)" fill="#7b5c3e">
        <path d={MAIN_PATH} />
        {ISLAND_PATHS.map((i) => <path key={i.id} d={i.d} />)}
      </g>
    </>
  );
}

function MapViewInner({ holdings, highlights = {}, fx = [], arrow, onRegion, showBadges = true, showLabels = true, dimOthers = false }: Props) {
  const renderRegion = (id: string) => {
    const h = holdings[id];
    const hl = highlights[id];
    return (
      <path
        key={id}
        d={REGION_PATHS[id]}
        className={`io-region${hl ? ` io-hl-${hl}` : dimOthers ? ' io-dim' : ''}${onRegion ? ' io-clickable' : ''}`}
        style={{ fill: h ? FACTIONS[h.owner].color : '#9aa58a' }}
        onClick={onRegion ? () => onRegion(id) : undefined}
        data-region={id}
      />
    );
  };

  const mainland = BOARD.regions.filter((r) => r.landmass === 'mainland');
  const islands = BOARD.regions.filter((r) => r.landmass !== 'mainland');

  return (
    // Framed tight on the land: the sea margin is decoration, and every pixel of
    // scale matters on a phone.
    <svg className="io-map" viewBox="35 60 930 480" preserveAspectRatio="xMidYMid meet">
      <defs>
        <radialGradient id="io-sea" cx="50%" cy="45%" r="75%">
          <stop offset="0%" stopColor="#1b7f9c" />
          <stop offset="60%" stopColor="#11577a" />
          <stop offset="100%" stopColor="#0a3350" />
        </radialGradient>
        <pattern id="io-waves" width="40" height="22" patternUnits="userSpaceOnUse">
          <path d="M0 11 Q10 5 20 11 T40 11" fill="none" stroke="rgba(255,255,255,0.13)" strokeWidth="1.4" />
        </pattern>
        <linearGradient id="io-sheen" x1="0" y1="0" x2="0.4" y2="1">
          <stop offset="0%" stopColor="#fff" stopOpacity="0.28" />
          <stop offset="55%" stopColor="#fff" stopOpacity="0.04" />
          <stop offset="100%" stopColor="#000" stopOpacity="0.18" />
        </linearGradient>
        <clipPath id="io-clip-main">
          <path d={MAIN_PATH} />
        </clipPath>
        <filter id="io-badge-shadow" x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow dx="0" dy="2.5" stdDeviation="1.6" floodColor="#000" floodOpacity="0.45" />
        </filter>
        <marker id="io-arrowhead" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" fill="context-stroke" />
        </marker>
      </defs>

      <SeaAndBase />

      <g clipPath="url(#io-clip-main)">
        {mainland.map((r) => renderRegion(r.id))}
        <path d={MAIN_PATH} fill="url(#io-sheen)" pointerEvents="none" />
        {SECTOR_BORDERS.map((b, i) => (
          <line key={i} x1={b.from[0]} y1={b.from[1]} x2={b.to[0]} y2={b.to[1]} className="io-sector-border" />
        ))}
      </g>
      {islands.map((r) => renderRegion(r.id))}
      {ISLAND_PATHS.map((i) => <path key={i.id} d={i.d} fill="url(#io-sheen)" pointerEvents="none" />)}
      <path d={MAIN_PATH} className="io-coast" />
      {ISLAND_PATHS.map((i) => <path key={i.id} d={i.d} className="io-coast" />)}

      <g className="io-sector-labels" pointerEvents="none">
        {SECTOR_IDS.map((id) => (
          <text key={id} x={SECTORS[id].label[0]} y={SECTORS[id].label[1]}>
            {SECTORS[id].name.replace(' Sector', '').toUpperCase()}
          </text>
        ))}
      </g>

      <g pointerEvents="none">
        {BOARD.regions.map((r) =>
          r.landmark ? (
            <g key={r.id} transform={`translate(${r.site[0] + 20} ${r.site[1] - 14})`} opacity={0.9}>
              <LandmarkGlyph kind={r.landmark} />
            </g>
          ) : null,
        )}
      </g>

      {arrow && (
        <path d={arrowPath(arrow.from, arrow.to)} className="io-arrow" stroke={arrow.color} markerEnd="url(#io-arrowhead)" />
      )}

      {fx.map((f) => {
        const [x, y] = BOARD.byId[f.region].site;
        return f.kind === 'ripple' ? (
          <g key={f.id} pointerEvents="none">
            <circle cx={x} cy={y} r={10} className="io-ripple" stroke={f.color} />
            <circle cx={x} cy={y} r={10} className="io-ripple io-ripple-2" stroke={f.color} />
          </g>
        ) : (
          <g key={f.id} pointerEvents="none" transform={`translate(${x} ${y})`}>
            <circle r={8} className="io-blast" />
            <circle r={8} className="io-blast-ring" />
          </g>
        );
      })}

      {showBadges && (
        <g>
          {BOARD.regions.map((r) => {
            const h = holdings[r.id];
            if (!h) return null;
            const f = FACTIONS[h.owner];
            const rad = badgeRadius(h.troops);
            return (
              <g
                key={r.id}
                transform={`translate(${r.site[0]} ${r.site[1]})`}
                className={`io-badge${onRegion ? ' io-clickable' : ''}`}
                onClick={onRegion ? () => onRegion(r.id) : undefined}
              >
                <g filter="url(#io-badge-shadow)">
                  <circle r={rad + 2.5} fill="#fff" />
                  <circle r={rad} fill={f.deep} />
                  <circle r={rad - 3} fill={f.color} />
                </g>
                {r.stronghold && <path d={`M${-rad + 1} ${-rad + 5} l4 -6 l4 6`} className="io-stronghold" />}
                <text key={h.troops} className="io-badge-num" dy="0.36em" fontSize={rad * 1.05}>
                  {h.troops}
                </text>
                {showLabels && (
                  <text className="io-region-name" y={rad + 11}>
                    {r.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      )}
    </svg>
  );
}

export const MapView = memo(MapViewInner);

/** A random-looking ownership map for the title screen backdrop. */
export function demoHoldings(factions: FactionId[]): Record<string, Holding> {
  const out: Record<string, Holding> = {};
  BOARD.regions.forEach((r, i) => {
    const f = factions[(i * 7 + (r.sector.length * 3)) % factions.length];
    out[r.id] = { owner: f, troops: 1 + ((i * 13) % 9) };
  });
  return out;
}
