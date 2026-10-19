// ============================================================================
// The board, drawn as a tabletop diorama: a raised island on a patterned sea,
// regions painted in their owner's colour, chunky strength badges (exact,
// a range, or "?" under fog), Key Installations ringed in gold, the four sea
// zones with their ships, and every planned order as an arrow.
// ============================================================================

import { memo, useEffect, useRef, useState } from 'react';
import { BOARD, INSTALLATIONS, SEA_ZONES, SECTORS, SECTOR_IDS, ZONE_IDS, ZoneId, polyPath } from '../map';
import { FACTIONS, FactionId, Ship } from '../types';
import { LandmarkGlyph } from './Glyphs';

export type Highlight = 'source' | 'target' | 'landing' | 'strike' | 'friendly' | 'place' | 'recon';

export interface Badge {
  owner: FactionId;
  /** "7", "3–5" or "?" */
  text: string;
  fog: boolean;
  /** Pending change while planning, e.g. "+3". */
  extra?: string;
}

export interface Fx {
  id: string;
  /** ripple: a capture · blast: an explosion · alert: one of yours was lost · jet: a strike run */
  kind: 'ripple' | 'blast' | 'alert' | 'jet';
  region: string;
  color: string;
}

export interface OrderArrow {
  id: string;
  from: string;
  to: string;
  color: string;
  label?: string;
  /** Through a sea zone (a landing) — bowed out over the water. */
  via?: ZoneId;
  /** Ship movement: zone to zone. */
  sail?: boolean;
  /** Send a token carrying the label down the route (playback). */
  travel?: boolean;
  onClick?: () => void;
}

/**
 * A token that runs along an SVG path once, from when it mounts. SMIL's
 * default begin is the document's start, long past by now — so start it by hand.
 */
function Traveller({ d, dur, children }: { d: string; dur: number; children: React.ReactNode }) {
  const ref = useRef<SVGAnimateMotionElement>(null);
  useEffect(() => {
    try {
      ref.current?.beginElement();
    } catch {
      // No SMIL support: the token just sits at the start of the route.
    }
  }, [d]);
  return (
    <g>
      {children}
      <animateMotion ref={ref} dur={`${dur}ms`} begin="indefinite" fill="freeze" path={d} rotate="0" calcMode="spline" keyTimes="0;1" keySplines="0.4 0 0.2 1" />
    </g>
  );
}

export interface Marker {
  region: string;
  kind: 'STRIKE' | 'CAS';
  color: string;
}

interface Props {
  badges: Record<string, Badge>;
  highlights?: Record<string, Highlight>;
  dimOthers?: boolean;
  fx?: Fx[];
  arrows?: OrderArrow[];
  markers?: Marker[];
  ships?: Ship[];
  selectedShip?: string | null;
  zoneHighlights?: Partial<Record<ZoneId, 'sail' | 'battle'>>;
  onRegion?: (id: string) => void;
  onZone?: (id: ZoneId) => void;
  onShip?: (id: string) => void;
  showLabels?: boolean;
  showBadges?: boolean;
  threats?: string[];
  /** Drag from one region onto another to give an order. */
  drag?: { canStart: (id: string) => boolean; drop: (from: string, to: string) => void };
}

const MAIN_PATH = polyPath(BOARD.mainland);
const ISLAND_PATHS = BOARD.islands.map((i) => ({ id: i.id, d: polyPath(i.poly) }));
const REGION_PATHS = Object.fromEntries(BOARD.regions.map((r) => [r.id, polyPath(r.poly)]));
const SECTOR_BORDERS = BOARD.borders.filter((b) => BOARD.byId[b.a].sector !== BOARD.byId[b.b].sector);

const BADGE_R = 15;

function curve(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, stopShort: number): string {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const t = Math.max(0.5, 1 - stopShort / len);
  const ex = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
  const ey = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
  return `M${x1},${y1} Q${cx},${cy} ${ex},${ey}`;
}

function arrowGeometry(a: OrderArrow): { d: string; mid: [number, number] } {
  if (a.sail) {
    const [x1, y1] = SEA_ZONES[a.from as ZoneId].anchor;
    const [x2, y2] = SEA_ZONES[a.to as ZoneId].anchor;
    const cx = (x1 + x2) / 2 + (y2 - y1) * 0.15, cy = (y1 + y2) / 2 - (x2 - x1) * 0.15;
    return { d: curve(x1, y1, x2, y2, cx, cy, 34), mid: [(x1 + 2 * cx + x2) / 4, (y1 + 2 * cy + y2) / 4] };
  }
  const [x1, y1] = BOARD.byId[a.from].site;
  const [x2, y2] = BOARD.byId[a.to].site;
  let cx: number, cy: number;
  if (a.via) {
    // Swing out over the sea zone the landing crosses.
    const [ax, ay] = SEA_ZONES[a.via].anchor;
    cx = (2 * ax - (x1 + x2) / 2 + ax) / 2;
    cy = (2 * ay - (y1 + y2) / 2 + ay) / 2;
  } else {
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    cx = (x1 + x2) / 2 - ((y2 - y1) / len) * len * 0.18;
    cy = (y1 + y2) / 2 + ((x2 - x1) / len) * len * 0.18;
  }
  return { d: curve(x1, y1, x2, y2, cx, cy, 22), mid: [0.25 * x1 + 0.5 * cx + 0.25 * x2, 0.25 * y1 + 0.5 * cy + 0.25 * y2] };
}

interface DragState {
  from: string;
  x: number;
  y: number;
  live: boolean;
  startX: number;
  startY: number;
}

function regionAt(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest('[data-region]')?.getAttribute('data-region') ?? null;
}

function SeaAndBase() {
  return (
    <>
      <rect x={-200} y={-200} width={1400} height={1020} fill="url(#io-sea)" />
      <rect x={-240} y={-200} width={1480} height={1020} fill="url(#io-waves)" opacity={0.5} className="io-waves-layer" />
      {BOARD.crossings.map(([a, b]) => {
        const p = BOARD.byId[a].site, q = BOARD.byId[b].site;
        return <line key={a + b} x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} className="io-crossing" />;
      })}
      <g className="io-surf">
        <path d={MAIN_PATH} />
        {ISLAND_PATHS.map((i) => (
          <path key={i.id} d={i.d} />
        ))}
      </g>
      <g transform="translate(0 9)" fill="#5a4330">
        <path d={MAIN_PATH} />
        {ISLAND_PATHS.map((i) => (
          <path key={i.id} d={i.d} />
        ))}
      </g>
      <g transform="translate(0 5)" fill="#7b5c3e">
        <path d={MAIN_PATH} />
        {ISLAND_PATHS.map((i) => (
          <path key={i.id} d={i.d} />
        ))}
      </g>
    </>
  );
}

function ShipGlyph() {
  return <path d="M-11 1 L11 1 L7 7 L-7 7Z M-6 -3 L6 -3 L7 1 L-7 1Z M-1.5 -8 L1.5 -8 L1.5 -3 L-1.5 -3Z" />;
}

function MapViewInner({
  badges, highlights = {}, dimOthers = false, fx = [], arrows = [], markers = [], ships = [], selectedShip = null, zoneHighlights = {},
  onRegion, onZone, onShip, showLabels = true, showBadges = true, threats = [], drag,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<DragState | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const draggingRef = useRef(dragging);
  draggingRef.current = dragging;

  const toSvg = (clientX: number, clientY: number) => {
    const pt = new DOMPoint(clientX, clientY).matrixTransform(svgRef.current!.getScreenCTM()!.inverse());
    return { x: pt.x, y: pt.y };
  };

  const startDrag = (id: string, e: React.PointerEvent) => {
    if (!dragRef.current?.canStart(id) || e.button > 0) return;
    setDragging({ from: id, ...toSvg(e.clientX, e.clientY), live: false, startX: e.clientX, startY: e.clientY });
  };

  // Track the pointer on the window rather than capturing it, so a plain tap
  // still lands as a normal click on the region under it.
  const active = dragging !== null;
  useEffect(() => {
    if (!active) return;
    const move = (e: PointerEvent) =>
      setDragging((d) => (d ? { ...d, ...toSvg(e.clientX, e.clientY), live: d.live || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 10 } : d));
    const up = (e: PointerEvent) => {
      const d = draggingRef.current;
      setDragging(null);
      if (!d?.live) return;
      const to = regionAt(e.clientX, e.clientY);
      if (to && to !== d.from) dragRef.current?.drop(d.from, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [active]);

  const renderRegion = (id: string) => {
    const b = badges[id];
    const hl = highlights[id];
    return (
      <path
        key={id}
        d={REGION_PATHS[id]}
        className={`io-region${hl ? ` io-hl-${hl}` : dimOthers ? ' io-dim' : ''}${onRegion ? ' io-clickable' : ''}`}
        style={{ fill: b ? FACTIONS[b.owner].color : '#9aa58a' }}
        onClick={onRegion ? () => onRegion(id) : undefined}
        onPointerDown={drag ? (e) => startDrag(id, e) : undefined}
        data-region={id}
      />
    );
  };

  const mainland = BOARD.regions.filter((r) => r.landmass === 'mainland');
  const islands = BOARD.regions.filter((r) => r.landmass !== 'mainland');

  return (
    // Framed tight on the land: the sea margin is decoration, and every pixel of
    // scale matters on a phone.
    <svg ref={svgRef} className={`io-map${drag ? ' io-map-live' : ''}`} viewBox="35 50 930 500" preserveAspectRatio="xMidYMid meet">
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
        <marker id="io-arrowhead" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 Z" fill="context-stroke" />
        </marker>
      </defs>

      <SeaAndBase />

      {/* Sea zones: name, and a target for ship orders. */}
      <g className="io-zones">
        {ZONE_IDS.map((z) => {
          const [x, y] = SEA_ZONES[z].anchor;
          const hl = zoneHighlights[z];
          return (
            <g
              key={z}
              transform={`translate(${x} ${y})`}
              className={`io-zone${hl ? ` io-zone-${hl}` : ''}${onZone ? ' io-clickable' : ''}`}
              onClick={onZone ? () => onZone(z) : undefined}
              data-zone={z}
            >
              <ellipse rx={62} ry={30} className="io-zone-pad" />
              <text y={-17} className="io-zone-name">
                {SEA_ZONES[z].name.toUpperCase()}
              </text>
            </g>
          );
        })}
      </g>

      <g clipPath="url(#io-clip-main)">
        {mainland.map((r) => renderRegion(r.id))}
        <path d={MAIN_PATH} fill="url(#io-sheen)" pointerEvents="none" />
        {SECTOR_BORDERS.map((b, i) => (
          <line key={i} x1={b.from[0]} y1={b.from[1]} x2={b.to[0]} y2={b.to[1]} className="io-sector-border" />
        ))}
      </g>
      {islands.map((r) => renderRegion(r.id))}
      {ISLAND_PATHS.map((i) => (
        <path key={i.id} d={i.d} fill="url(#io-sheen)" pointerEvents="none" />
      ))}
      <path d={MAIN_PATH} className="io-coast" />
      {ISLAND_PATHS.map((i) => (
        <path key={i.id} d={i.d} className="io-coast" />
      ))}

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
            <g key={r.id} transform={`translate(${r.site[0] + 22} ${r.site[1] - 15})`} opacity={0.9}>
              <LandmarkGlyph kind={r.landmark} />
            </g>
          ) : null,
        )}
      </g>

      {/* Ships, grouped per zone. */}
      <g>
        {ZONE_IDS.map((z) => {
          const here = ships.filter((sh) => sh.zone === z);
          const [x, y] = SEA_ZONES[z].anchor;
          return here.map((sh, i) => {
            const f = FACTIONS[sh.owner];
            const dx = (i - (here.length - 1) / 2) * 26;
            return (
              <g
                key={sh.id}
                style={{ transform: `translate(${x + dx}px, ${y + 6}px)` }}
                className={`io-ship${sh.id === selectedShip ? ' io-ship-on' : ''}${onShip ? ' io-clickable' : ''}`}
                onClick={onShip ? (e) => (e.stopPropagation(), onShip(sh.id)) : undefined}
                data-ship={sh.id}
              >
                <title>{`${sh.name} — ${f.name}`}</title>
                <g className="io-ship-bob" style={{ animationDelay: `${(i * 0.7) % 2}s` }}>
                  <circle r={12} fill={f.deep} stroke="#fff" strokeWidth={2} />
                  <g fill="#fff" transform="scale(0.8)">
                    <ShipGlyph />
                  </g>
                </g>
              </g>
            );
          });
        })}
      </g>

      {/* Planned orders and playback movements. */}
      <g>
        {arrows.map((a) => {
          const g = arrowGeometry(a);
          return (
            <g key={a.id} className={a.onClick ? 'io-clickable' : undefined} onClick={a.onClick}>
              <path d={g.d} className={`io-order${a.via ? ' io-order-landing' : ''}${a.sail ? ' io-order-sail' : ''}${a.travel ? ' io-order-faint' : ''}`} stroke={a.color} markerEnd="url(#io-arrowhead)" />
              {a.travel && a.label && (
                <Traveller d={g.d} dur={1500}>
                  <circle r={11} fill={a.color} stroke="#fff" strokeWidth={2.5} className="io-token" />
                  <text y={4} className="io-token-text">
                    {a.label}
                  </text>
                </Traveller>
              )}
              {!a.travel && a.label && (
                <g transform={`translate(${g.mid[0]} ${g.mid[1]})`} className="io-order-chip">
                  <rect x={-13} y={-9} width={26} height={18} rx={9} fill={a.color} />
                  <text y={4.5}>{a.label}</text>
                </g>
              )}
            </g>
          );
        })}
      </g>

      {dragging?.live && (
        <line
          x1={BOARD.byId[dragging.from].site[0]}
          y1={BOARD.byId[dragging.from].site[1]}
          x2={dragging.x}
          y2={dragging.y}
          className="io-order io-drag-line"
          stroke="#ffd23f"
          markerEnd="url(#io-arrowhead)"
        />
      )}

      {fx.map((f) => {
        const [x, y] = BOARD.byId[f.region].site;
        if (f.kind === 'jet') {
          const d = `M${x - 190},${y - 120} Q${x - 40},${y - 50} ${x},${y} T${x + 170},${y + 40}`;
          return (
            <g key={f.id} pointerEvents="none">
              <Traveller d={d} dur={900}>
                <g className="io-jet">
                  <path d="M12 2l1.6 6.2 8 4v2.2l-8-2-.8 5 3 2v2L12 20.5l-3.8.9v-2l3-2-.8-5-8 2v-2.2l8-4z" transform="rotate(118) translate(-12 -12)" />
                </g>
              </Traveller>
            </g>
          );
        }
        if (f.kind === 'alert')
          return (
            <g key={f.id} pointerEvents="none">
              <circle cx={x} cy={y} r={24} className="io-alert-ring" />
            </g>
          );
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

      {/* Cloud shadows drifting over the island. */}
      <g className="io-clouds" pointerEvents="none">
        <ellipse cx={200} cy={180} rx={120} ry={46} />
        <ellipse cx={560} cy={330} rx={150} ry={52} style={{ animationDelay: '-24s' }} />
        <ellipse cx={820} cy={150} rx={100} ry={38} style={{ animationDelay: '-48s' }} />
      </g>

      {showBadges && (
        <g>
          {BOARD.regions.map((r) => {
            const b = badges[r.id];
            if (!b) return null;
            const f = FACTIONS[b.owner];
            const ki = INSTALLATIONS[r.id];
            const wide = b.text.length > 2;
            const rx = wide ? BADGE_R + 6 : BADGE_R;
            return (
              <g
                key={r.id}
                transform={`translate(${r.site[0]} ${r.site[1]})`}
                className={`io-badge${onRegion ? ' io-clickable' : ''}`}
                onClick={onRegion ? () => onRegion(r.id) : undefined}
                onPointerDown={drag ? (e) => startDrag(r.id, e) : undefined}
                data-region={r.id}
              >
                <g filter="url(#io-badge-shadow)">
                  {ki && <rect x={-rx - 5} y={-BADGE_R - 5} width={2 * rx + 10} height={2 * BADGE_R + 10} rx={BADGE_R + 5} className="io-ki-ring" />}
                  <rect x={-rx - 2.5} y={-BADGE_R - 2.5} width={2 * rx + 5} height={2 * BADGE_R + 5} rx={BADGE_R + 2.5} fill="#fff" />
                  <rect x={-rx} y={-BADGE_R} width={2 * rx} height={2 * BADGE_R} rx={BADGE_R} fill={b.fog ? '#56606b' : f.deep} />
                  <rect x={-rx + 3} y={-BADGE_R + 3} width={2 * rx - 6} height={2 * BADGE_R - 6} rx={BADGE_R - 3} fill={b.fog ? '#7b8692' : f.color} />
                </g>
                {ki && (
                  <g transform={`translate(0 ${-BADGE_R - 6})`} className="io-ki-star">
                    <path d="M0 -6 L1.8 -1.8 L6 -1.8 L2.6 1 L3.8 5.4 L0 2.8 L-3.8 5.4 L-2.6 1 L-6 -1.8 L-1.8 -1.8Z" />
                  </g>
                )}
                <text key={b.text} className="io-badge-num" dy="0.36em" fontSize={wide ? 12 : 15}>
                  {b.text}
                </text>
                {b.extra && (
                  <g transform={`translate(${rx + 4} ${BADGE_R - 4})`} className="io-badge-extra">
                    <rect x={-1} y={-8} width={b.extra.length * 7 + 6} height={15} rx={7.5} />
                    <text x={2} y={3.5}>
                      {b.extra}
                    </text>
                  </g>
                )}
                {threats.includes(r.id) && (
                  <g transform={`translate(${-rx - 2} ${-BADGE_R + 2})`} className="io-threat">
                    <path d="M0 -8 L8 6 L-8 6Z" />
                    <text y="4.5">!</text>
                  </g>
                )}
                {showLabels && (
                  <text className="io-region-name" y={BADGE_R + 11}>
                    {r.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      )}

      {/* Air orders on top of everything. */}
      <g pointerEvents="none">
        {markers.map((m, i) => {
          const [x, y] = BOARD.byId[m.region].site;
          return (
            <g key={`${m.region}-${m.kind}-${i}`} transform={`translate(${x - 20} ${y - 20})`} className="io-air-marker">
              <circle r={10} fill={m.color} stroke="#fff" strokeWidth={2} />
              {m.kind === 'STRIKE' ? (
                <g stroke="#fff" strokeWidth={2} fill="none">
                  <circle r={4.5} />
                  <path d="M0 -7 V-2 M0 2 V7 M-7 0 H-2 M2 0 H7" />
                </g>
              ) : (
                <path d="M0 -6 L5 -3 V1 Q5 5 0 7 Q-5 5 -5 1 V-3Z" fill="#fff" />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

export const MapView = memo(MapViewInner);
