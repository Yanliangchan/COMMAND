// ============================================================================
// The board, drawn as a tabletop diorama: a raised island on a patterned sea —
// a layered cliff plinth with beaches, surf and reef shallows, bridges to the
// offshore islands, faint hill contours — regions painted in their owner's
// colour (and texture, and an emblem on every badge, so colour is never the
// only cue), chunky bevelled strength badges (exact, a range, or "?" under
// fog), Key Installations ringed in gold, the four sea zones as compass pads
// with their warships, and every planned order as an arrow.
//
// The camera fits the island into whatever part of the screen the HUD leaves
// free, and can be zoomed and panned (wheel, pinch, drag on the sea, buttons).
// The map is ONE tab stop (a roving tabindex): the arrow keys walk between
// neighbouring regions, and out over the water to your own ships and to the
// sea zones a selected ship can sail to.
//
// Motion has a purpose and a budget. One-shot: a capture floods the new colour
// out from the badge, numbers pop when they change, orders draw themselves in,
// ships sail the sea lanes with a wake. Looping: only small things — the
// selected badge's pulse, the focus ring's marching dash, a ship's stepped
// bob — so an idle board costs next to nothing. All of it stops under
// prefers-reduced-motion.
// ============================================================================

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BOARD, INSTALLATIONS, SEA_ZONES, ZONE_IDS, ZoneId, polyPath } from '../map';
import { FACTIONS, FACTION_IDS, FactionId, Ship } from '../types';
import { BADGE_NUDGE, FACTION_INK, FOG, HILLS, LABEL_SIDE, LANDMARK_AT, SEA_LANES } from './theme';
import { EmblemMark, Icon, LandmarkGlyph } from './Glyphs';
import './map.css';
import { Effects, Traveller, prefersReducedMotion } from './Effects';

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
  /** Drawn in warning red with a broken line: the engine would reject it. */
  broken?: boolean;
  onClick?: () => void;
}

export interface Marker {
  region: string;
  kind: 'STRIKE' | 'CAS';
  color: string;
}

/** What playback is showing right now: drawn as a pulsing ring, and the camera keeps it in view. */
export interface Focus {
  region?: string;
  between?: [string, string];
  zone?: ZoneId;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
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
  threats?: string[];
  /** Drag from one region onto another to give an order. */
  drag?: { canStart: (id: string) => boolean; drop: (from: string, to: string) => void };
  focus?: Focus | null;
  /** Screen space the HUD covers; the island is fitted into what's left. */
  insets?: Insets;
  /** Interactive camera (zoom/pan). Off for the title backdrop. */
  camera?: boolean;
  /** Fill the screen rather than fit inside it (title backdrop). */
  cover?: boolean;
  /** Where a phone's first, zoomed-in view centres. */
  home?: string[];
  /** Screen-reader text for a region. */
  describe?: (id: string) => string;
  /** The region the source/selection is on, for the keyboard. */
  selected?: string | null;
  /**
   * The player's faction: only their ships are focusable and look clickable.
   * Optional — without it the owner of most `home` regions is assumed.
   */
  me?: FactionId;
}

// ---------------------------------------------------------------------------
// Static geometry
// ---------------------------------------------------------------------------

type Pt = [number, number];
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const VIEW = { x: 18, y: 46, w: 964, h: 510 };
const MAIN_PATH = polyPath(BOARD.mainland);
const ISLAND_PATHS = BOARD.islands.map((i) => ({ id: i.id, d: polyPath(i.poly) }));
const LAND_PATH = [MAIN_PATH, ...ISLAND_PATHS.map((i) => i.d)].join(' ');
const REGION_PATHS = Object.fromEntries(BOARD.regions.map((r) => [r.id, polyPath(r.poly)]));
const OUTLINES = BOARD.regions.map((r) => REGION_PATHS[r.id]).join(' ');
const SECTOR_BORDERS = BOARD.borders.filter((b) => BOARD.byId[b.a].sector !== BOARD.byId[b.b].sector);
const MAINLAND = BOARD.regions.filter((r) => r.landmass === 'mainland');
const ISLANDS = BOARD.regions.filter((r) => r.landmass !== 'mainland');

const bboxOf = (pts: Pt[]) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};
const LAND_BOX = bboxOf([...BOARD.mainland, ...BOARD.islands.flatMap((i) => i.poly)] as Pt[]);
const REGION_BOX = Object.fromEntries(BOARD.regions.map((r) => [r.id, bboxOf(r.poly as Pt[])]));

const BADGE_R = 15;

/** Where each region's badge is drawn. */
export const BADGE_AT: Record<string, [number, number]> = Object.fromEntries(
  BOARD.regions.map((r) => {
    const n = BADGE_NUDGE[r.id] ?? [0, 0];
    return [r.id, [r.site[0] + n[0], r.site[1] + n[1]]];
  }),
);

const at = (id: string) => BADGE_AT[id];

/** Where a region's name sits relative to its badge. */
function labelSpot(id: string, rx: number, ki: boolean) {
  const side = LABEL_SIDE[id];
  return side === 'left'
    ? { x: -rx - (ki ? 9 : 6), y: 4, anchor: 'end' as const }
    : side === 'above'
      ? { x: 0, y: -BADGE_R - (ki ? 15 : 7), anchor: 'middle' as const }
      : { x: 0, y: BADGE_R + (ki ? 16 : 12), anchor: 'middle' as const };
}

/** Where a region's landmark miniature stands, or null if it has none. */
function landmarkAt(id: string): Pt | null {
  const off = id in LANDMARK_AT ? LANDMARK_AT[id] : [36, -14];
  if (!BOARD.byId[id].landmark || !off) return null;
  return [at(id)[0] + off[0], at(id)[1] + off[1]];
}

/** Average advance of the label font (Nunito 900, 10 units), measured in the browser. */
const LABEL_CHAR = 5.6;

function labelBox(id: string, rx: number, ki: boolean, measured?: number): Box {
  const [x, y] = at(id);
  const l = labelSpot(id, rx, ki);
  const w = (measured ?? BOARD.byId[id].name.length * LABEL_CHAR) + 4;
  const left = l.anchor === 'middle' ? x + l.x - w / 2 : x + l.x - w;
  return { x: left, y: y + l.y - 9, w, h: 12.5 };
}

const badgeRx = (b?: Badge) => (b && b.text.length > 2 ? BADGE_R + 6 : BADGE_R);

// --- routes -----------------------------------------------------------------

interface Route {
  pts: Pt[];
  d: string;
  end: Pt;
  angle: number;
}

const ptsPath = (pts: Pt[]) => 'M' + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' L');

function mkRoute(pts: Pt[]): Route {
  const e = pts[pts.length - 1], p = pts[pts.length - 2] ?? pts[0];
  return { pts, d: ptsPath(pts), end: e, angle: (Math.atan2(e[1] - p[1], e[0] - p[0]) * 180) / Math.PI };
}

/** Points along a quadratic from a to b bowed by c, from t = 0 to tEnd. */
function quadPts(a: Pt, c: Pt, b: Pt, tEnd: number, n = 22): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const t = (i / n) * tEnd;
    out.push([(1 - t) * (1 - t) * a[0] + 2 * (1 - t) * t * c[0] + t * t * b[0], (1 - t) * (1 - t) * a[1] + 2 * (1 - t) * t * c[1] + t * t * b[1]]);
  }
  return out;
}

/** An open Catmull-Rom curve through waypoints. */
function smooth(ctrl: Pt[], per = 7): Pt[] {
  const out: Pt[] = [];
  const n = ctrl.length;
  for (let i = 0; i < n - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(n - 1, i + 2)];
    for (let s = 0; s < per; s++) {
      const t = s / per, t2 = t * t, t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(ctrl[n - 1]);
  return out;
}

/** Drop `len` units of arc from the end of a polyline. */
function trimEnd(pts: Pt[], len: number): Pt[] {
  const out = pts.slice();
  let left = len;
  while (out.length > 2) {
    const a = out[out.length - 2], b = out[out.length - 1];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (seg > left) {
      const k = (seg - left) / seg;
      out[out.length - 1] = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
      return out;
    }
    left -= seg;
    out.pop();
  }
  return out;
}

const laneCache = new Map<string, Pt[]>();
/** The sea lane from one zone to another, through open water. */
function seaLane(from: ZoneId, to: ZoneId): Pt[] {
  const key = `${from}-${to}`;
  const hit = laneCache.get(key);
  if (hit) return hit;
  let way: Pt[] | undefined = SEA_LANES[key] ?? (SEA_LANES[`${to}-${from}`] ? [...SEA_LANES[`${to}-${from}`]].reverse() : undefined);
  if (!way) {
    // Not neighbours: go by way of a zone that neighbours both.
    const mid = SEA_ZONES[from].neighbours.find((z) => SEA_ZONES[z].neighbours.includes(to));
    way = mid ? [...seaLane(from, mid), ...seaLane(mid, to).slice(1)] : [SEA_ZONES[from].anchor, SEA_ZONES[to].anchor];
    laneCache.set(key, way);
    return way;
  }
  const pts = smooth(way as Pt[]);
  laneCache.set(key, pts);
  return pts;
}

function arrowRoute(a: OrderArrow): Route {
  if (a.sail) return mkRoute(trimEnd(seaLane(a.from as ZoneId, a.to as ZoneId), 30));
  const p = at(a.from), q = at(a.to);
  const len = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
  // A landing swings out over the sea zone it crosses; a march bows gently to one side.
  const c: Pt = a.via
    ? [(3 * SEA_ZONES[a.via].anchor[0] - (p[0] + q[0]) / 2) / 2, (3 * SEA_ZONES[a.via].anchor[1] - (p[1] + q[1]) / 2) / 2]
    : [(p[0] + q[0]) / 2 - (q[1] - p[1]) * 0.18, (p[1] + q[1]) / 2 + (q[0] - p[0]) * 0.18];
  return mkRoute(quadPts(p, c, q, Math.max(0.45, 1 - 30 / len)));
}

/** Sideways nudges a mark may take off its route to stay clear of names and badges. */
const SIDE_STEPS = [0, 12, -12, 22, -22, 32, -32];

/** A point `off` units to the side of a polyline at index i. */
function sideStep(pts: Pt[], i: number, off: number): Pt {
  const p = pts[i];
  if (!off) return p;
  const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [p[0] - ((b[1] - a[1]) / len) * off, p[1] + ((b[0] - a[0]) / len) * off];
}

const overlap = (a: Box, b: Box) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * Where order-count chips and travelling tokens settle: on their own route,
 * clear of every badge and region name, and fanned apart from each other.
 */
function placeRouteMarks(
  arrows: OrderArrow[],
  routes: Map<string, Route>,
  badges: Record<string, Badge>,
  labels: boolean,
  labelW: Record<string, number>,
  keep: Map<string, Pt[]>,
) {
  const obst: Box[] = [];
  for (const r of BOARD.regions) {
    const b = badges[r.id];
    if (!b) continue;
    const ki = !!INSTALLATIONS[r.id];
    const rx = badgeRx(b) + (ki ? 5 : 3);
    const [x, y] = at(r.id);
    obst.push({ x: x - rx, y: y - BADGE_R - (ki ? 11 : 3), w: 2 * rx, h: 2 * BADGE_R + (ki ? 16 : 8) });
    if (labels) obst.push(labelBox(r.id, badgeRx(b), ki, labelW[r.id]));
    const lm = landmarkAt(r.id);
    if (lm) obst.push({ x: lm[0] - 11, y: lm[1] - 10, w: 22, h: 19 });
  }
  const placed: Box[] = [];
  const cost = (bx: Box) => obst.reduce((n, o) => n + overlap(bx, o), 0) + placed.reduce((n, o) => n + 2.5 * overlap(bx, o), 0);
  const chips = new Map<string, Pt>();
  const tokens = new Map<string, Pt[]>();
  // Tokens first: they stop at the far end, so they get first pick near it.
  for (const a of arrows) {
    if (!a.label || !a.travel) continue;
    // A token already under way keeps its route: changing it would restart the run.
    const kept = keep.get(a.id);
    if (kept) {
      const [x, y] = kept[kept.length - 1];
      placed.push({ x: x - 12, y: y - 12, w: 24, h: 24 });
      tokens.set(a.id, kept);
      continue;
    }
    const pts = routes.get(a.id)!.pts;
    const n = pts.length - 1;
    let best = { i: n, p: pts[n] }, bestCost = Infinity;
    for (let i = n; i >= Math.floor(n * 0.25); i--) {
      for (const off of SIDE_STEPS) {
        const p = sideStep(pts, i, off);
        const c = cost({ x: p[0] - 12, y: p[1] - 12, w: 24, h: 24 }) + (n - i) * 2 + Math.abs(off) * 0.8;
        if (c < bestCost) (bestCost = c), (best = { i, p });
      }
    }
    const [x, y] = best.p;
    placed.push({ x: x - 12, y: y - 12, w: 24, h: 24 });
    const run = pts.slice(0, best.i + 1);
    if (best.p !== pts[best.i]) run.push(best.p);
    tokens.set(a.id, run);
  }
  for (const a of arrows) {
    if (!a.label || a.travel) continue;
    const pts = routes.get(a.id)!.pts;
    const n = pts.length - 1;
    let best: Pt = pts[Math.round(n / 2)], bestCost = Infinity;
    for (let f = 0.2; f <= 0.81; f += 0.04) {
      const i = Math.round(n * f);
      for (const off of SIDE_STEPS) {
        const p = sideStep(pts, i, off);
        const c = cost({ x: p[0] - 13, y: p[1] - 9, w: 26, h: 18 }) + Math.abs(f - 0.5) * 40 + Math.abs(off) * 0.8;
        if (c < bestCost) (bestCost = c), (best = p);
      }
    }
    placed.push({ x: best[0] - 13, y: best[1] - 9, w: 26, h: 18 });
    chips.set(a.id, best);
  }
  return { chips, tokens };
}

/** Keyframes for a glide along a polyline, spaced by arc length so the speed is even. */
function glideFrames(pts: Pt[]): Keyframe[] {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1] || 1;
  return pts.map((p, i) => ({ offset: cum[i] / total, transform: `translate(${p[0].toFixed(1)}px, ${p[1].toFixed(1)}px)` }));
}

function regionAt(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest('[data-region]')?.getAttribute('data-region') ?? null;
}

/**
 * The neighbour that lies in a direction, for arrow-key navigation: the
 * nearest one inside a 90° cone if there is one (so every region can be
 * reached), otherwise the best-aligned within a wider cone.
 */
function neighbourToward(id: string, dx: number, dy: number): string | null {
  const [x, y] = at(id);
  let near: string | null = null, nearLen = Infinity;
  let best: string | null = null, bestScore = -Infinity;
  for (const n of BOARD.byId[id].neighbours) {
    const [nx, ny] = at(n);
    const vx = nx - x, vy = ny - y;
    const len = Math.hypot(vx, vy) || 1;
    const cos = (vx * dx + vy * dy) / len;
    if (cos >= 0.707 && len < nearLen) (nearLen = len), (near = n);
    if (cos < 0.3) continue;
    const score = cos - len / 600;
    if (score > bestScore) (bestScore = score), (best = n);
  }
  return near ?? best;
}

interface NavItem {
  key: string;
  kind: 'r' | 's' | 'z';
  id: string;
  x: number;
  y: number;
}

/** The nearest item in a direction among `items`, or null. */
function nearestToward(from: NavItem, items: NavItem[], dx: number, dy: number, reach: number, minCos = 0.3): NavItem | null {
  let best: NavItem | null = null, bestScore = -Infinity;
  for (const it of items) {
    if (it.key === from.key) continue;
    const vx = it.x - from.x, vy = it.y - from.y;
    const len = Math.hypot(vx, vy) || 1;
    if (len > reach) continue;
    const cos = (vx * dx + vy * dy) / len;
    if (cos < minCos) continue;
    const score = cos - len / 400;
    if (score > bestScore) (bestScore = score), (best = it);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Per-faction textures laid over the fill, so territories differ by more than hue (and survive colour-blindness). */
function FactionPatterns() {
  const ink = 'rgba(255,255,255,0.34)';
  return (
    <>
      {/* Lion: a diamond lattice. */}
      <pattern id="io-pat-SINGA" width="12" height="12" patternUnits="userSpaceOnUse">
        <path d="M0 6 L6 0 L12 6 L6 12Z" fill="none" stroke={ink} strokeWidth="1.4" />
      </pattern>
      {/* Tiger: bold diagonal stripes. */}
      <pattern id="io-pat-HARIMAU" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
        <rect width="5" height="14" fill="rgba(70,32,0,0.26)" />
      </pattern>
      {/* Eagle: polka dots. */}
      <pattern id="io-pat-HELANG" width="11" height="11" patternUnits="userSpaceOnUse">
        <circle cx="5.5" cy="5.5" r="2" fill={ink} />
      </pattern>
      {/* Shark: waves. */}
      <pattern id="io-pat-JERUNG" width="18" height="10" patternUnits="userSpaceOnUse">
        <path d="M0 6 Q4.5 2 9 6 T18 6" fill="none" stroke={ink} strokeWidth="1.6" />
      </pattern>
    </>
  );
}

/** Everything under the land: reef shallows, surf and foam, bridges, and the cliff the island stands on. */
const Plinth = memo(function Plinth() {
  return (
    <g pointerEvents="none">
      <path d={LAND_PATH} className="io-reef" />
      <path d={LAND_PATH} className="io-shallows" />
      <path d={LAND_PATH} className="io-surf" />
      <path d={LAND_PATH} className="io-foam" />
      <g className="io-bridges">
        {BOARD.crossings.map(([a, b]) => {
          const p = BOARD.byId[a].site, q = BOARD.byId[b].site;
          return (
            <g key={a + b}>
              <line x1={p[0]} y1={p[1] + 4} x2={q[0]} y2={q[1] + 4} className="io-bridge-shadow" />
              <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} className="io-bridge-casing" />
              <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} className="io-bridge-deck" />
              <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} className="io-bridge-line" />
            </g>
          );
        })}
      </g>
      <path d={LAND_PATH} transform="translate(0 11)" className="io-cliff-base" />
      <path d={LAND_PATH} transform="translate(0 8)" className="io-cliff-low" />
      <path d={LAND_PATH} transform="translate(0 4.5)" className="io-cliff-high" />
      <path d={LAND_PATH} transform="translate(0 6.5)" className="io-cliff-strata" />
    </g>
  );
});

/** Faint hill contours and hillshade over the land (clipped to it). */
const Terrain = memo(function Terrain() {
  return (
    <g pointerEvents="none" className="io-terrain">
      {HILLS.map((h, i) => (
        <g key={i} transform={`translate(${h.at[0]} ${h.at[1]}) rotate(-14)`}>
          <ellipse rx={h.r + h.rings * 9 + 8} ry={(h.r + h.rings * 9 + 8) * 0.7} fill="url(#io-hillshade)" stroke="none" />
          {Array.from({ length: h.rings }, (_, k) => (
            <ellipse key={k} rx={h.r + k * 9} ry={(h.r + k * 9) * 0.68} cx={k * 1.5} cy={k * 1.2} className="io-contour" />
          ))}
        </g>
      ))}
    </g>
  );
});

/** A compass rose in the open sea off the south-west. */
const Compass = memo(function Compass() {
  return (
    <g transform="translate(78 506)" className="io-compass" pointerEvents="none">
      <circle r={27} className="io-compass-ring" />
      <circle r={21} className="io-compass-ring io-compass-inner" />
      <path d="M0 -25 L4 -4 L0 0 Z M0 25 L-4 4 L0 0Z M25 0 L4 4 L0 0Z M-25 0 L-4 -4 L0 0Z" className="io-compass-lit" />
      <path d="M0 -25 L-4 -4 L0 0 Z M0 25 L4 4 L0 0Z M25 0 L4 -4 L0 0Z M-25 0 L-4 4 L0 0Z" className="io-compass-dark" />
      <path d="M0 0 L11 -11 L3 -3Z M0 0 L-11 11 L-3 3Z M0 0 L11 11 L3 3Z M0 0 L-11 -11 L-3 -3Z" className="io-compass-dark" opacity={0.7} />
      <text y={-31} className="io-compass-n">
        N
      </text>
    </g>
  );
});

const Stronghold = () => <path d="M-3.6 3.6 V-2 H-2.2 V-3.8 H-0.7 V-2 H0.7 V-3.8 H2.2 V-2 H3.6 V3.6Z" />;

const StarPath = 'M0 -6 L1.8 -1.8 L6 -1.8 L2.6 1 L3.8 5.4 L0 2.8 L-3.8 5.4 L-2.6 1 L-6 -1.8 L-1.8 -1.8Z';

/** A small warship in profile, bow to the right, standing on its waterline at y ≈ 8. */
function Warship({ ship, left }: { ship: Ship; left: boolean }) {
  const f = FACTIONS[ship.owner];
  return (
    <g transform="scale(0.82)">
      <ellipse cy={9.4} rx={21} ry={3.4} className="io-ship-shadow" />
      <g transform={left ? 'scale(-1 1)' : undefined}>
        <path d="M-17 6.5 Q-34 3.5 -52 9 Q-34 11 -17 9.8Z" className="io-ship-wake" />
        <path d="M-17.5 7.4 Q-24 6.4 -30 8.6 Q-24 9.8 -17 9.2Z M15 6.2 Q20 4.8 23 7.8 Q19 9 14.5 8.6Z" className="io-ship-foam" />
        <path d="M-0.5 -15.5 L5.5 -13.8 L-0.5 -12.2Z" fill={f.color} stroke="#fff" strokeWidth={0.8} strokeLinejoin="round" />
        <path d="M-0.5 -9 V-15.5 M-3.5 -12.6 H2.5 M11 -1.2 V-3.4 H14.5 M14 -2.4 H21.5" className="io-ship-rig" />
        <path d="M-10.5 -1 V-5.6 H-4.5 V-9.6 H3.5 V-5.6 H9.5 V-1Z" className="io-ship-deck" />
        <rect x={-3} y={-8.4} width={5.4} height={1.7} rx={0.6} className="io-ship-glass" />
        <path d="M-18.5 -1.2 H20.5 L14.5 8.2 H-15.5Z" fill={f.color} stroke="#fff" strokeWidth={1.9} strokeLinejoin="round" />
        <path d="M-16.6 5 H16.6 L14.5 8.2 H-15.5Z" fill={f.deep} />
      </g>
      <circle cx={left ? 3 : -3} cy={3.2} r={5.6} fill="#fff" stroke={f.deep} strokeWidth={1} />
      <g transform={`translate(${left ? 3 : -3} 3.2)`}>
        <EmblemMark faction={ship.owner} size={8.4} color={f.deep} />
      </g>
    </g>
  );
}

const reduced = () => prefersReducedMotion();

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

interface Cam {
  z: number;
  cx: number;
  cy: number;
}

function useSize(ref: React.RefObject<HTMLElement>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

// ---------------------------------------------------------------------------

function MapViewInner({
  badges, highlights = {}, dimOthers = false, fx = [], arrows = [], markers = [], ships = [], selectedShip = null, zoneHighlights = {},
  onRegion, onZone, onShip, showLabels = true, threats = [], drag, focus = null, insets = NO_INSETS, camera = false, cover = false, home, describe, selected, me,
}: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { w: W, h: H } = useSize(boxRef);

  // --- camera geometry ---
  const safeW = Math.max(40, W - insets.left - insets.right);
  const safeH = Math.max(40, H - insets.top - insets.bottom);
  const fit = W && H ? (cover ? Math.max(W / VIEW.w, H / VIEW.h) : Math.min(safeW / VIEW.w, safeH / VIEW.h)) : 1;
  // Never let badges get too small to read or tap: a phone opens zoomed in.
  const comfortable = 0.85;
  const maxZ = Math.max(3, 1.6 / fit);
  const [cam, setCam] = useState<Cam>({ z: 1, cx: VIEW.x + VIEW.w / 2, cy: VIEW.y + VIEW.h / 2 });
  const opened = useRef(false);
  const scale = fit * cam.z;
  const sx = insets.left + safeW / 2, sy = insets.top + safeH / 2;

  const clampCam = useCallback(
    (c: Cam): Cam => {
      const z = Math.min(maxZ, Math.max(1, c.z));
      const s = fit * z;
      const vw = safeW / s, vh = safeH / s;
      const clampAxis = (v: number, lo: number, size: number, view: number) => (view >= size ? lo + size / 2 : Math.min(lo + size - view / 2, Math.max(lo + view / 2, v)));
      return { z, cx: clampAxis(c.cx, VIEW.x, VIEW.w, vw), cy: clampAxis(c.cy, VIEW.y, VIEW.h, vh) };
    },
    [fit, maxZ, safeW, safeH],
  );

  // First real layout: on a small screen, open zoomed in on the player's own
  // ground; on a portrait screen, open with the land (not the sea round it)
  // filling the width, leaning toward the player's ground.
  useEffect(() => {
    if (!camera || opened.current || !W || !H) return;
    opened.current = true;
    const pts = (home ?? []).map(at);
    const hx = pts.length ? pts.reduce((n, p) => n + p[0], 0) / pts.length : (LAND_BOX.x0 + LAND_BOX.x1) / 2;
    const hy = pts.length ? pts.reduce((n, p) => n + p[1], 0) / pts.length : (LAND_BOX.y0 + LAND_BOX.y1) / 2;
    if (fit < 0.7 && pts.length) {
      setCam(clampCam({ z: comfortable / fit, cx: hx, cy: hy }));
      return;
    }
    if (H > W) {
      // Portrait: crop the empty sea, and a little of the far ends if the
      // height allows, so the badges come up to a comfortable size.
      const landW = LAND_BOX.x1 - LAND_BOX.x0, landH = LAND_BOX.y1 - LAND_BOX.y0;
      const s = Math.max(safeW / (landW + 16), Math.min((safeH * 0.75) / landH, safeW / (landW * 0.86)));
      setCam(clampCam({ z: Math.min(maxZ, s / fit), cx: (hx + (LAND_BOX.x0 + LAND_BOX.x1) / 2) / 2, cy: (LAND_BOX.y0 + LAND_BOX.y1) / 2 }));
    }
  }, [camera, W, H, fit, home, clampCam, safeW, safeH, maxZ]);

  // Keep the camera legal when the screen or the HUD changes size.
  useEffect(() => setCam((c) => clampCam(c)), [clampCam]);

  const viewBox = useMemo(() => {
    if (!W || !H) return `${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}`;
    if (cover) {
      const s = fit;
      return `${VIEW.x + VIEW.w / 2 - W / s / 2} ${VIEW.y + VIEW.h / 2 - H / s / 2} ${W / s} ${H / s}`;
    }
    return `${cam.cx - sx / scale} ${cam.cy - sy / scale} ${W / scale} ${H / scale}`;
  }, [W, H, cover, fit, cam, sx, sy, scale]);

  // Glide the camera to a point (playback focus, keyboard focus) if it's out of view.
  const anim = useRef(0);
  const glideTo = useCallback(
    (x: number, y: number, force = false) => {
      if (!camera) return;
      setCam((c) => {
        const s = fit * c.z;
        const vw = safeW / s, vh = safeH / s;
        const margin = 50;
        const inside = Math.abs(x - c.cx) < vw / 2 - margin && Math.abs(y - c.cy) < vh / 2 - margin;
        if (inside && !force) return c;
        const target = clampCam({ z: c.z, cx: x, cy: y });
        cancelAnimationFrame(anim.current);
        if (prefersReducedMotion()) return target;
        const start = performance.now(), from = c;
        const step = (now: number) => {
          const t = Math.min(1, (now - start) / 380);
          const e = 1 - Math.pow(1 - t, 3);
          setCam({ z: from.z, cx: from.cx + (target.cx - from.cx) * e, cy: from.cy + (target.cy - from.cy) * e });
          if (t < 1) anim.current = requestAnimationFrame(step);
        };
        anim.current = requestAnimationFrame(step);
        return c;
      });
    },
    [camera, fit, safeW, safeH, clampCam],
  );
  useEffect(() => () => cancelAnimationFrame(anim.current), []);

  const focusPoint = useMemo((): [number, number] | null => {
    if (!focus) return null;
    if (focus.region) return at(focus.region);
    if (focus.between) {
      const [a, b] = focus.between.map(at);
      return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
    if (focus.zone) return SEA_ZONES[focus.zone].anchor;
    return null;
  }, [focus]);
  useEffect(() => {
    if (focusPoint) glideTo(focusPoint[0], focusPoint[1]);
  }, [focusPoint, glideTo]);

  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      const rect = boxRef.current?.getBoundingClientRect();
      setCam((c) => {
        const s = fit * c.z;
        const qx = clientX !== undefined && rect ? clientX - rect.left : sx;
        const qy = clientY !== undefined && rect ? clientY - rect.top : sy;
        // Board point under the cursor stays put.
        const bx = c.cx - sx / s + qx / s, by = c.cy - sy / s + qy / s;
        const z = Math.min(maxZ, Math.max(1, c.z * factor));
        const s2 = fit * z;
        return clampCam({ z, cx: bx - qx / s2 + sx / s2, cy: by - qy / s2 + sy / s2 });
      });
    },
    [fit, sx, sy, maxZ, clampCam],
  );

  // --- pointer: order drags, pans and pinches ---
  const dragRef = useRef(drag);
  dragRef.current = drag;
  const [dragLine, setDragLine] = useState<{ from: string; x: number; y: number } | null>(null);
  const gesture = useRef<{
    pointers: Map<number, { x: number; y: number }>;
    mode: 'none' | 'pending-order' | 'order' | 'pan' | 'pinch';
    from: string | null;
    startX: number;
    startY: number;
    cam: Cam;
    pinch?: { dist: number; mx: number; my: number };
    moved: boolean;
  }>({ pointers: new Map(), mode: 'none', from: null, startX: 0, startY: 0, cam: cam, moved: false });
  const suppressClick = useRef(false);
  const camRef = useRef(cam);
  camRef.current = cam;

  const toSvg = (clientX: number, clientY: number) => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (cover) return;
    const g = gesture.current;
    g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (g.pointers.size === 2 && camera) {
      // Second finger: whatever the first one was doing becomes a pinch.
      const [a, b] = [...g.pointers.values()];
      g.mode = 'pinch';
      g.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      g.cam = camRef.current;
      setDragLine(null);
      suppressClick.current = true;
      return;
    }
    if (g.pointers.size > 1 || e.button > 0) return;
    const region = (e.target as Element).closest?.('[data-region]')?.getAttribute('data-region') ?? null;
    g.startX = e.clientX;
    g.startY = e.clientY;
    g.cam = camRef.current;
    g.moved = false;
    suppressClick.current = false;
    if (region && dragRef.current?.canStart(region)) {
      g.mode = 'pending-order';
      g.from = region;
    } else {
      g.mode = camera ? 'pan' : 'none';
      g.from = null;
    }
  };

  useEffect(() => {
    if (cover) return;
    const g = gesture.current;
    const move = (e: PointerEvent) => {
      if (!g.pointers.has(e.pointerId)) return;
      g.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.mode === 'pinch' && g.pinch && g.pointers.size >= 2) {
        const [a, b] = [...g.pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const rect = boxRef.current?.getBoundingClientRect();
        if (!rect) return;
        const c0 = g.cam;
        const s0 = fit * c0.z;
        const qx = g.pinch.mx - rect.left, qy = g.pinch.my - rect.top;
        const bx = c0.cx - sx / s0 + qx / s0, by = c0.cy - sy / s0 + qy / s0;
        const z = Math.min(maxZ, Math.max(1, c0.z * (dist / (g.pinch.dist || 1))));
        const s2 = fit * z;
        const nx = mx - rect.left, ny = my - rect.top;
        setCam(clampCam({ z, cx: bx - nx / s2 + sx / s2, cy: by - ny / s2 + sy / s2 }));
        return;
      }
      const far = Math.hypot(e.clientX - g.startX, e.clientY - g.startY) > 8;
      if (far) g.moved = true;
      if (g.mode === 'pending-order' && far) g.mode = 'order';
      if (g.mode === 'order' && g.from) {
        const p = toSvg(e.clientX, e.clientY);
        setDragLine({ from: g.from, x: p.x, y: p.y });
      } else if (g.mode === 'pan' && far) {
        const s = fit * g.cam.z;
        setCam(clampCam({ z: g.cam.z, cx: g.cam.cx - (e.clientX - g.startX) / s, cy: g.cam.cy - (e.clientY - g.startY) / s }));
      }
    };
    const up = (e: PointerEvent) => {
      if (!g.pointers.has(e.pointerId)) return;
      g.pointers.delete(e.pointerId);
      if (g.mode === 'order' && g.from) {
        const to = regionAt(e.clientX, e.clientY);
        if (to && to !== g.from) dragRef.current?.drop(g.from, to);
        suppressClick.current = true;
      } else if (g.mode === 'pan' && g.moved) suppressClick.current = true;
      setDragLine(null);
      if (g.pointers.size === 0) g.mode = 'none';
      else if (g.mode === 'pinch') {
        // One finger lifted: carry on as a pan with the other.
        const [p] = [...g.pointers.values()];
        g.mode = 'pan';
        g.startX = p.x;
        g.startY = p.y;
        g.cam = camRef.current;
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
  }, [cover, fit, sx, sy, maxZ, clampCam]);

  // A drag or pan ends with a click on whatever is under the pointer: swallow it.
  const onClickCapture = (e: React.MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.stopPropagation();
      e.preventDefault();
    }
  };

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !camera) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0022)), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [camera, zoomAt]);


  // --- whose ships are these ---
  const myFaction = useMemo<FactionId | null>(() => {
    if (me) return me;
    if (!home?.length) return null;
    const n: Partial<Record<FactionId, number>> = {};
    for (const id of home) {
      const o = badges[id]?.owner;
      if (o) n[o] = (n[o] ?? 0) + 1;
    }
    const top = (Object.entries(n) as [FactionId, number][]).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  }, [me, home, badges]);
  const isMine = useCallback((sh: Ship) => !!onShip && (myFaction ? sh.owner === myFaction : true), [onShip, myFaction]);

  // --- ships: where each one rides, and a glide along the sea lane when it moves ---
  const shipSpots = useMemo(() => {
    const out: Record<string, { x: number; y: number; zone: ZoneId }> = {};
    for (const z of ZONE_IDS) {
      const here = ships.filter((sh) => sh.zone === z);
      const [x, y] = SEA_ZONES[z].anchor;
      // A crowded zone sails in a staggered flotilla rather than one long line.
      const tight = here.length > 3;
      const gap = tight ? 31 : 38;
      here.forEach((sh, i) => (out[sh.id] = { x: x + (i - (here.length - 1) / 2) * gap, y: y + 3 + (tight ? (i % 2 ? 5 : -4) : 0), zone: z }));
    }
    return out;
  }, [ships]);
  const prevSpots = useRef<Record<string, { x: number; y: number; zone: ZoneId }>>({});
  const [faces, setFaces] = useState<Record<string, boolean>>({});
  useLayoutEffect(() => {
    const prev = prevSpots.current;
    prevSpots.current = shipSpots;
    const next: Record<string, boolean> = {};
    let changed = false;
    for (const [id, s] of Object.entries(shipSpots)) {
      const p = prev[id];
      // Ships at rest face the island; a ship that sails faces where it went.
      next[id] = faces[id] ?? s.x > 520;
      if (!(id in faces)) changed = true;
      if (!p || (p.x === s.x && p.y === s.y)) continue;
      const voyage = p.zone !== s.zone;
      const path: Pt[] = voyage ? [[p.x, p.y], ...seaLane(p.zone, s.zone).slice(2, -2).map((q): Pt => [q[0], q[1] + 3]), [s.x, s.y]] : [[p.x, p.y], [s.x, s.y]];
      const left = s.x < p.x;
      if (next[id] !== left) (next[id] = left), (changed = true);
      if (reduced()) continue;
      const el = svgRef.current?.querySelector<SVGGElement>(`[data-ship="${id}"]`);
      if (!el || typeof el.animate !== 'function') continue;
      el.classList.add('io-ship-moving');
      const anim = el.animate(glideFrames(path), { duration: voyage ? 1700 : 420, easing: 'cubic-bezier(0.45, 0, 0.25, 1)' });
      const done = () => el.classList.remove('io-ship-moving');
      anim.onfinish = done;
      anim.oncancel = done;
    }
    if (changed) setFaces(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shipSpots]);

  // --- captures: flood the new owner's colour out from the badge ---
  const prevOwners = useRef<Record<string, FactionId> | null>(null);
  const [sweeps, setSweeps] = useState<{ key: string; id: string; from: FactionId; to: FactionId }[]>([]);
  const sweepSeq = useRef(0);
  useLayoutEffect(() => {
    const owners: Record<string, FactionId> = {};
    for (const id in badges) owners[id] = badges[id].owner;
    const prev = prevOwners.current;
    prevOwners.current = owners;
    if (!prev || reduced()) return;
    const changed = Object.keys(owners).filter((id) => prev[id] && prev[id] !== owners[id]);
    // A whole new board (a new game) isn't a capture.
    if (!changed.length || changed.length > 8) return;
    const add = changed.map((id) => ({ key: `${id}-${++sweepSeq.current}`, id, from: prev[id], to: owners[id] }));
    setSweeps((s) => [...s.filter((x) => !changed.includes(x.id)), ...add]);
    const keys = add.map((a) => a.key);
    window.setTimeout(() => setSweeps((s) => s.filter((x) => !keys.includes(x.key))), 1100);
  }, [badges]);

  // --- numbers tick only when they change (not when the board first appears) ---
  const shownText = useRef<Record<string, string>>({});
  useEffect(() => {
    const t: Record<string, string> = {};
    for (const id in badges) t[id] = badges[id].text;
    shownText.current = t;
  }, [badges]);
  const ticked = useRef<Record<string, string>>({});
  const ticks = (id: string, text: string) => {
    if (!cover && id in shownText.current && shownText.current[id] !== text) ticked.current[id] = text;
    return ticked.current[id] === text;
  };

  // --- keyboard: the map is one tab stop; arrows rove between regions, your ships and sail targets ---
  const navItems = useMemo<NavItem[]>(() => {
    const out: NavItem[] = [];
    if (onRegion) for (const r of BOARD.regions) if (badges[r.id]) out.push({ key: `r:${r.id}`, kind: 'r', id: r.id, x: at(r.id)[0], y: at(r.id)[1] });
    for (const sh of ships) {
      const s = shipSpots[sh.id];
      if (s && isMine(sh)) out.push({ key: `s:${sh.id}`, kind: 's', id: sh.id, x: s.x, y: s.y });
    }
    if (onZone) for (const z of ZONE_IDS) if (zoneHighlights[z] === 'sail') out.push({ key: `z:${z}`, kind: 'z', id: z, x: SEA_ZONES[z].anchor[0], y: SEA_ZONES[z].anchor[1] - 18 });
    return out;
  }, [onRegion, onZone, badges, ships, shipSpots, isMine, zoneHighlights]);
  const [rove, setRove] = useState<string | null>(null);
  const roveKey = useMemo(() => {
    const has = (k: string) => navItems.some((i) => i.key === k);
    if (rove && has(rove)) return rove;
    for (const k of [selectedShip ? `s:${selectedShip}` : '', selected ? `r:${selected}` : '', home?.[0] ? `r:${home[0]}` : '']) if (k && has(k)) return k;
    return navItems[0]?.key ?? null;
  }, [navItems, rove, selected, selectedShip, home]);
  const tabFor = (key: string) => (key === roveKey ? 0 : -1);
  const focusNav = (key: string) => svgRef.current?.querySelector<SVGElement>(`[data-nav="${CSS.escape(key)}"]`)?.focus();
  const onNavKey = (key: string, e: React.KeyboardEvent, activate: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      activate();
      return;
    }
    if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // S hops between your ships (and back to the land after the last one).
      const fleet = navItems.filter((i) => i.kind === 's');
      if (!fleet.length) return;
      e.preventDefault();
      const at = fleet.findIndex((i) => i.key === key);
      const next = at < 0 ? fleet[0] : fleet[at + 1];
      focusNav(next ? next.key : navItems.find((i) => i.kind === 'r' && i.id === (selected ?? home?.[0]))?.key ?? navItems[0].key);
      return;
    }
    const dir: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const d = dir[e.key];
    if (!d) return;
    e.preventDefault();
    const item = navItems.find((i) => i.key === key);
    if (!item) return;
    let next: string | null = null;
    if (item.kind === 'r') {
      const n = neighbourToward(item.id, d[0], d[1]);
      if (n) next = `r:${n}`;
    }
    if (!next && item.kind !== 'r') {
      // On the water: along the sea to the next ship or sail target squarely that way...
      next = nearestToward(item, navItems.filter((i) => i.kind !== 'r'), d[0], d[1], 720, 0.707)?.key ?? null;
    }
    if (!next) {
      // ...otherwise (and off a coast) to whatever lies that way.
      const pool = item.kind === 'r' ? navItems.filter((i) => i.kind !== 'r') : navItems;
      next = nearestToward(item, pool, d[0], d[1], item.kind === 'r' ? 330 : 440)?.key ?? null;
    }
    if (next) focusNav(next);
  };
  const onNavFocus = (key: string, x: number, y: number) => {
    setRove(key);
    if (camera) glideTo(x, y);
  };

  // --- render ---
  const far = !cover && scale < 0.72;
  // A 44px touch target where it fits, but never so big it swallows a neighbour's taps.
  const hitR = Math.min(26, Math.max(BADGE_R + 5, 22 / (scale || 1)));
  const interactive = !!onRegion;
  const dimmed = dimOthers ? BOARD.regions.filter((r) => !highlights[r.id]).map((r) => r.id) : [];

  // Region names, measured once the font is in, so marks can be parked clear of them.
  const [labelW, setLabelW] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    if (!showLabels) return;
    let live = true;
    const measure = () => {
      const out: Record<string, number> = {};
      svgRef.current?.querySelectorAll<SVGTextElement>('[data-badge] .io-region-name').forEach((t) => {
        const id = t.closest('[data-badge]')!.getAttribute('data-badge')!;
        const w = t.getBBox().width;
        if (w) out[id] = w;
      });
      if (live && Object.keys(out).length) setLabelW(out);
    };
    measure();
    document.fonts?.ready.then(measure).catch(() => {});
    return () => {
      live = false;
    };
  }, [showLabels]);

  const routes = useMemo(() => new Map(arrows.map((a) => [a.id, arrowRoute(a)])), [arrows]);
  const tokenRuns = useRef(new Map<string, Pt[]>());
  const marks = useMemo(() => {
    const m = placeRouteMarks(arrows, routes, badges, showLabels, labelW, tokenRuns.current);
    tokenRuns.current = m.tokens;
    return m;
  }, [arrows, routes, badges, showLabels, labelW]);

  const renderRegion = (id: string) => {
    const b = badges[id];
    const hl = highlights[id];
    return (
      <path
        key={id}
        d={REGION_PATHS[id]}
        className={`io-region${hl ? ` io-hl-${hl}` : ''}${interactive ? ' io-clickable' : ''}`}
        style={{ fill: b ? FACTIONS[b.owner].color : '#9aa58a' }}
        onClick={onRegion ? () => onRegion(id) : undefined}
        data-region={id}
      />
    );
  };
  const renderTexture = (id: string) => {
    const b = badges[id];
    return b ? <path key={id} d={REGION_PATHS[id]} fill={`url(#io-pat-${b.owner})`} /> : null;
  };
  const renderSweep = (s: (typeof sweeps)[number]) => {
    const [x, y] = at(s.id);
    const bb = REGION_BOX[s.id];
    const R = Math.max(...[[bb.x0, bb.y0], [bb.x1, bb.y0], [bb.x0, bb.y1], [bb.x1, bb.y1]].map(([px, py]) => Math.hypot(px - x, py - y))) + 4;
    return (
      <g key={s.key} clipPath={`url(#io-sw-${s.key})`}>
        <rect x={bb.x0 - 2} y={bb.y0 - 2} width={bb.x1 - bb.x0 + 4} height={bb.y1 - bb.y0 + 4} fill={FACTIONS[s.from].color} className="io-sweep-old" />
        <g transform={`translate(${x} ${y})`}>
          <g className="io-sweep">
            <circle r={R} fill={FACTIONS[s.to].color} />
            <circle r={R} className="io-sweep-edge" />
          </g>
        </g>
      </g>
    );
  };

  return (
    <div ref={boxRef} className={`io-mapbox${camera ? ' io-mapbox-cam' : ''}`}>
      <svg
        ref={svgRef}
        className={`io-map${drag ? ' io-map-live' : ''}${far ? ' io-far' : ''}`}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onClickCapture={onClickCapture}
        role={interactive ? 'application' : 'img'}
        aria-label={
          interactive
            ? 'Map of the island. Arrow keys move between neighbouring regions, and off the coast to your ships; S jumps to your ships; Enter acts.'
            : 'Map of the island'
        }
      >
        <defs>
          <linearGradient id="io-sheen" x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.26" />
            <stop offset="55%" stopColor="#fff" stopOpacity="0.03" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.16" />
          </linearGradient>
          <linearGradient id="io-gloss" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.42" />
            <stop offset="46%" stopColor="#fff" stopOpacity="0.08" />
            <stop offset="54%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.16" />
          </linearGradient>
          <radialGradient id="io-hillshade" cx="0.4" cy="0.38" r="0.6">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.16" />
            <stop offset="70%" stopColor="#fff" stopOpacity="0.02" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>
          <clipPath id="io-clip-land">
            <path d={LAND_PATH} />
          </clipPath>
          <filter id="io-badge-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="2.5" stdDeviation="1.6" floodColor="#000" floodOpacity="0.45" />
          </filter>
          <FactionPatterns />
          {sweeps.map((s) => (
            <clipPath key={s.key} id={`io-sw-${s.key}`}>
              <path d={REGION_PATHS[s.id]} />
            </clipPath>
          ))}
        </defs>

        <Compass />

        {/* Sea-zone pads sit on the water, under everything else: compass-ringed, with a name plaque. */}
        <g className="io-zones">
          {ZONE_IDS.map((z) => {
            const [x, y] = SEA_ZONES[z].anchor;
            const hl = zoneHighlights[z];
            const n = ships.filter((sh) => sh.zone === z).length;
            const rx = Math.max(66, (n - 1) * (n > 3 ? 15.5 : 19) + 40);
            const name = SEA_ZONES[z].name.toUpperCase();
            const pw = name.length * 7.7 + 18;
            const key = `z:${z}`;
            const nav = onZone && hl === 'sail';
            return (
              <g
                key={z}
                transform={`translate(${x} ${y})`}
                className={`io-zone${hl ? ` io-zone-${hl}` : ''}${nav ? ' io-clickable' : ''}`}
                onClick={onZone ? () => onZone(z) : undefined}
                onKeyDown={nav ? (e) => onNavKey(key, e, () => onZone(z)) : undefined}
                onFocus={nav ? () => onNavFocus(key, x, y) : undefined}
                tabIndex={nav ? tabFor(key) : undefined}
                role={nav ? 'button' : undefined}
                aria-label={nav ? `Sail to the ${SEA_ZONES[z].name}` : undefined}
                data-zone={z}
                data-nav={nav ? key : undefined}
              >
                <ellipse rx={rx} ry={32} className="io-zone-pad" />
                <ellipse rx={rx - 11} ry={23} className="io-zone-inner" />
                <path d={`M${-rx - 7} 0 L${-rx + 1} -3.5 L${-rx + 1} 3.5Z M${rx + 7} 0 L${rx - 1} -3.5 L${rx - 1} 3.5Z M0 39 L-3.5 31 L3.5 31Z`} className="io-zone-tick" />
                <g className="io-zone-buoy" transform={`translate(${-rx + 14} 18)`}>
                  <path d="M0 -7 V-2" />
                  <circle r={3.2} />
                  <circle cy={-7.5} r={1.6} className="io-zone-lamp" />
                </g>
                <g className="io-zone-buoy" transform={`translate(${rx - 14} 18)`}>
                  <path d="M0 -7 V-2" />
                  <circle r={3.2} />
                  <circle cy={-7.5} r={1.6} className="io-zone-lamp" />
                </g>
                <g transform="translate(0 -32)" className="io-zone-plaque">
                  <rect x={-pw / 2} y={-9} width={pw} height={18} rx={9} />
                  <text y={3.6} className="io-zone-name">
                    {name}
                  </text>
                </g>
                {nav && <ellipse rx={rx + 6} ry={37} className="io-zone-focus" />}
              </g>
            );
          })}
        </g>

        <Plinth />

        {/* The land: fills, captures in progress, textures, light, terrain and borders — all clipped to the coast. */}
        <g clipPath="url(#io-clip-land)">
          {MAINLAND.map((r) => renderRegion(r.id))}
          {ISLANDS.map((r) => renderRegion(r.id))}
          <g pointerEvents="none">
            {sweeps.map(renderSweep)}
            {BOARD.regions.map((r) => renderTexture(r.id))}
            <path d={MAIN_PATH} fill="url(#io-sheen)" />
            {ISLAND_PATHS.map((i) => (
              <path key={i.id} d={i.d} fill="url(#io-sheen)" />
            ))}
            <Terrain />
            <path d={OUTLINES} className="io-outline-shade" transform="translate(0.7 1.2)" />
            <path d={OUTLINES} className="io-outline" />
            {SECTOR_BORDERS.map((b, i) => (
              <line key={i} x1={b.from[0]} y1={b.from[1]} x2={b.to[0]} y2={b.to[1]} className="io-sector-border" />
            ))}
            <g className="io-veil">
              {dimmed.map((id) => (
                <path key={id} d={REGION_PATHS[id]} />
              ))}
            </g>
            <path d={LAND_PATH} className="io-beach" />
          </g>
        </g>
        <g pointerEvents="none">
          <path d={LAND_PATH} className="io-coast" />
          {/* Highlight outlines drawn again on top of the coast, so they read all the way round. */}
          {Object.entries(highlights).map(([id, hl]) => (
            <path key={id} d={REGION_PATHS[id]} className={`io-hl-line io-hl-${hl}`} clipPath={BOARD.byId[id].landmass === 'mainland' ? 'url(#io-clip-land)' : undefined} />
          ))}
        </g>

        {/* Landmarks beside their badges. */}
        <g pointerEvents="none" className="io-landmarks">
          {BOARD.regions.map((r) => {
            const lm = landmarkAt(r.id);
            if (!lm || !r.landmark) return null;
            return (
              <g key={r.id} transform={`translate(${lm[0]} ${lm[1]}) scale(0.85)`}>
                <LandmarkGlyph kind={r.landmark} />
              </g>
            );
          })}
        </g>

        {/* Ships. Only your own are buttons; the rest are scenery you can read. */}
        <g>
          {ships.map((sh) => {
            const s = shipSpots[sh.id];
            if (!s) return null;
            const f = FACTIONS[sh.owner];
            const mine = isMine(sh);
            const key = `s:${sh.id}`;
            const on = sh.id === selectedShip;
            return (
              <g
                key={sh.id}
                style={{ transform: `translate(${s.x}px, ${s.y}px)` }}
                className={`io-ship${on ? ' io-ship-on' : ''}${mine ? ' io-clickable io-ship-mine' : ''}`}
                onClick={onShip ? (e) => (e.stopPropagation(), onShip(sh.id)) : undefined}
                onKeyDown={mine ? (e) => onNavKey(key, e, () => onShip!(sh.id)) : undefined}
                onFocus={mine ? () => onNavFocus(key, s.x, s.y) : undefined}
                tabIndex={mine ? tabFor(key) : undefined}
                role={mine ? 'button' : undefined}
                aria-label={`${sh.name}, ${f.name}, ${SEA_ZONES[s.zone].name}`}
                data-ship={sh.id}
                data-nav={mine ? key : undefined}
              >
                <title>{`${sh.name} — ${f.name}`}</title>
                <rect x={-20} y={-15} width={40} height={26} className="io-hit" />
                {on && (
                  <>
                    <ellipse cy={7.5} rx={23} ry={6.5} className="io-ship-sel" />
                    <ellipse cy={7.5} rx={23} ry={6.5} className="io-ship-sel-pulse" />
                  </>
                )}
                <g className="io-ship-bob">
                  <Warship ship={sh} left={!!faces[sh.id]} />
                </g>
                {mine && (
                  <>
                    <rect x={-23} y={-17} width={46} height={30} rx={10} className="io-focus-halo" />
                    <rect x={-23} y={-17} width={46} height={30} rx={10} className="io-focus-ring" />
                  </>
                )}
              </g>
            );
          })}
        </g>

        {/* Planned orders and playback routes, under the badges. Each draws itself in when it's made. */}
        <g>
          {arrows.map((a) => {
            const g = routes.get(a.id)!;
            const color = a.broken ? '#ff5a4e' : a.color;
            const dashed = a.via || a.sail || a.broken;
            const cls = `io-order${a.via ? ' io-order-landing' : ''}${a.sail ? ' io-order-sail' : ''}${a.travel ? ' io-order-faint' : ''}${a.broken ? ' io-order-broken' : ''}${dashed ? '' : ' io-order-solid'}`;
            return (
              <g key={a.id} className={a.onClick ? 'io-clickable' : undefined} onClick={a.onClick}>
                <path d={g.d} className="io-order-casing" pathLength={1} />
                <path d={g.d} className={cls} stroke={color} pathLength={dashed ? undefined : 1} />
                <g transform={`translate(${g.end[0].toFixed(1)} ${g.end[1].toFixed(1)}) rotate(${g.angle.toFixed(1)})`}>
                  <path d="M-7 -6 L5 0 L-7 6Z" className="io-order-head" fill={color} />
                </g>
              </g>
            );
          })}
        </g>

        {/* Strength badges: a chunky bevelled token per region, with the owner's emblem on its rim. */}
        <g>
          {BOARD.regions.map((r) => {
            const b = badges[r.id];
            if (!b) return null;
            const f = FACTIONS[b.owner];
            const ki = !!INSTALLATIONS[r.id];
            const wide = b.text.length > 2;
            const rx = badgeRx(b);
            const [x, y] = at(r.id);
            const label = labelSpot(r.id, rx, ki);
            const key = `r:${r.id}`;
            const emblemAt: Pt = LABEL_SIDE[r.id] === 'left' ? [0, BADGE_R + 2] : [-rx - 0.5, 7.5];
            return (
              <g
                key={r.id}
                transform={`translate(${x} ${y})`}
                className={`io-badge${interactive ? ' io-clickable' : ''}${selected === r.id ? ' io-badge-selected' : ''}`}
                onClick={onRegion ? () => onRegion(r.id) : undefined}
                onKeyDown={onRegion ? (e) => onNavKey(key, e, () => onRegion(r.id)) : undefined}
                onFocus={interactive ? () => onNavFocus(key, x, y) : undefined}
                tabIndex={interactive ? tabFor(key) : undefined}
                role={interactive ? 'button' : undefined}
                aria-label={interactive ? describe?.(r.id) ?? r.name : undefined}
                data-region={r.id}
                data-badge={r.id}
                data-nav={interactive ? key : undefined}
              >
                <circle r={hitR} className="io-hit" />
                {selected === r.id && <rect x={-rx - 4} y={-BADGE_R - 4} width={2 * rx + 8} height={2 * BADGE_R + 8} rx={BADGE_R + 4} className="io-sel-pulse" />}
                <g className="io-badge-body">
                  <g filter="url(#io-badge-shadow)">
                    {ki && <rect x={-rx - 5} y={-BADGE_R - 5} width={2 * rx + 10} height={2 * BADGE_R + 10} rx={BADGE_R + 5} className="io-ki-ring" />}
                    <rect x={-rx - 2.5} y={-BADGE_R - 0.5} width={2 * rx + 5} height={2 * BADGE_R + 5} rx={BADGE_R + 2.5} fill={b.fog ? '#2c333b' : f.deep} />
                    <rect x={-rx - 2.5} y={-BADGE_R - 2.5} width={2 * rx + 5} height={2 * BADGE_R + 5} rx={BADGE_R + 2.5} fill="#fff" />
                    <rect x={-rx} y={-BADGE_R} width={2 * rx} height={2 * BADGE_R} rx={BADGE_R} fill={b.fog ? FOG.rim : f.deep} />
                    <rect x={-rx + 3} y={-BADGE_R + 3} width={2 * rx - 6} height={2 * BADGE_R - 6} rx={BADGE_R - 3} fill={b.fog ? FOG.fill : f.color} />
                    <rect x={-rx + 3} y={-BADGE_R + 3} width={2 * rx - 6} height={2 * BADGE_R - 6} rx={BADGE_R - 3} fill="url(#io-gloss)" />
                  </g>
                  {ki && <path d={StarPath} transform={`translate(0 ${-BADGE_R - 6})`} className="io-ki-star" />}
                  {BOARD.byId[r.id].stronghold && (
                    <g transform={`translate(${rx - 1} ${-BADGE_R + 1})`} className="io-fort">
                      <circle r={6.5} />
                      <Stronghold />
                    </g>
                  )}
                  <g transform={`translate(${emblemAt[0]} ${emblemAt[1]})`} className="io-badge-emblem">
                    <circle r={6.6} fill="#fff" stroke={f.deep} strokeWidth={1.1} />
                    <EmblemMark faction={b.owner} size={9} color={f.deep} />
                  </g>
                  <text key={b.text} className={`io-badge-num${b.fog ? ' io-badge-fog' : ''}${ticks(r.id, b.text) ? ' io-num-tick' : ''}`} dy="0.36em" fontSize={wide ? 12 : 15} style={{ fill: b.fog ? '#fff' : FACTION_INK[b.owner] }}>
                    {b.text}
                  </text>
                  {b.extra && (
                    <g transform={`translate(${rx + 3} ${BADGE_R - 3})`} className="io-badge-extra">
                      <rect x={-1} y={-8} width={b.extra.length * 7 + 7} height={15} rx={7.5} />
                      <text key={b.extra} x={2.5} y={3.6}>
                        {b.extra}
                      </text>
                    </g>
                  )}
                  {threats.includes(r.id) && (
                    <g transform={`translate(${-rx - 1} ${-BADGE_R + 3})`} className="io-threat">
                      <path d="M0 -8 L8 6 L-8 6Z" />
                      <text y="4.5">!</text>
                    </g>
                  )}
                </g>
                <rect x={-rx - 6} y={-BADGE_R - 6} width={2 * rx + 12} height={2 * BADGE_R + 12} rx={BADGE_R + 6} className="io-sel-ring" />
                <rect x={-rx - 7} y={-BADGE_R - 7} width={2 * rx + 14} height={2 * BADGE_R + 14} rx={BADGE_R + 7} className="io-focus-halo" />
                <rect x={-rx - 7} y={-BADGE_R - 7} width={2 * rx + 14} height={2 * BADGE_R + 14} rx={BADGE_R + 7} className="io-focus-ring" />
                {showLabels && (
                  <text className="io-region-name" x={label.x} y={label.y} style={{ textAnchor: label.anchor }}>
                    {r.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Travelling columns and order counts ride above the badges, parked clear of every name. */}
        <g pointerEvents="none">
          {arrows.map((a) => {
            if (!a.label) return null;
            if (a.travel) {
              const pts = marks.tokens.get(a.id);
              if (!pts) return null;
              return (
                <Traveller key={a.id} d={ptsPath(pts)} dur={1500}>
                  <circle r={11} fill={a.color} stroke="#fff" strokeWidth={2.5} className="io-token" />
                  <text y={4} className="io-token-text">
                    {a.label}
                  </text>
                </Traveller>
              );
            }
            const p = marks.chips.get(a.id);
            if (!p) return null;
            return (
              <g key={a.id} transform={`translate(${p[0].toFixed(1)} ${p[1].toFixed(1)})`}>
                <g className="io-order-chip">
                  <rect x={-13} y={-9} width={26} height={18} rx={9} fill={a.broken ? '#ff5a4e' : a.color} />
                  <text y={4.5}>{a.label}</text>
                </g>
              </g>
            );
          })}
        </g>

        {/* Playback focus and effects (Effects.tsx). */}
        <Effects fx={fx} focus={focus} focusPoint={focusPoint} at={at} />

        {/* Air orders. The position is on an outer group so the pop-in animation can't move it. */}
        <g pointerEvents="none">
          {markers.map((m, i) => {
            const [x, y] = at(m.region);
            return (
              <g key={`${m.region}-${m.kind}-${i}`} transform={`translate(${x - 22 - i * 4} ${y + 12})`}>
                <g className="io-air-marker">
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
              </g>
            );
          })}
        </g>

        {dragLine && (
          <line x1={at(dragLine.from)[0]} y1={at(dragLine.from)[1]} x2={dragLine.x} y2={dragLine.y} className="io-drag-line" pointerEvents="none" />
        )}
      </svg>

      {camera && (
        <div className="io-zoom" style={{ right: insets.right + 12, bottom: insets.bottom + 12 }}>
          <button className="io-icon-btn" onClick={() => zoomAt(1.4)} aria-label="Zoom in" disabled={cam.z >= maxZ - 0.01}>
            <Icon name="zoomIn" />
          </button>
          <button className="io-icon-btn" onClick={() => zoomAt(1 / 1.4)} aria-label="Zoom out" disabled={cam.z <= 1.01}>
            <Icon name="zoomOut" />
          </button>
          <button className="io-icon-btn" onClick={() => setCam(clampCam({ z: 1, cx: VIEW.x + VIEW.w / 2, cy: VIEW.y + VIEW.h / 2 }))} aria-label="Show the whole island" disabled={cam.z <= 1.01}>
            <Icon name="fit" />
          </button>
        </div>
      )}
    </div>
  );
}

export const MapView = memo(MapViewInner);

/** Every faction, for legends. */
export const ALL_FACTIONS = FACTION_IDS;
