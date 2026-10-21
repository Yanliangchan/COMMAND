// ============================================================================
// The board, drawn as a tabletop diorama: a raised island on a patterned sea,
// regions painted in their owner's colour (and texture, so colour is never the
// only cue), chunky strength badges (exact, a range, or "?" under fog), Key
// Installations ringed in gold, the four sea zones with their ships, and every
// planned order as an arrow.
//
// The camera fits the island into whatever part of the screen the HUD leaves
// free, and can be zoomed and panned (wheel, pinch, drag on the sea, buttons).
// Regions are keyboard-focusable; the arrow keys walk between neighbours.
//
// Nothing here animates continuously across the whole board: every looping
// animation is small (a pulsing ring, a marching arrow), so an idle board costs
// next to nothing to keep on screen.
// ============================================================================

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { BOARD, INSTALLATIONS, SEA_ZONES, ZONE_IDS, ZoneId, polyPath } from '../map';
import { FACTIONS, FACTION_IDS, FactionId, Ship } from '../types';
import { BADGE_NUDGE, FACTION_INK, FOG, LABEL_SIDE, LANDMARK_AT } from './theme';
import { Emblem, Icon, LandmarkGlyph } from './Glyphs';
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
}

// ---------------------------------------------------------------------------
// Static geometry
// ---------------------------------------------------------------------------

const VIEW = { x: 18, y: 46, w: 964, h: 510 };
const MAIN_PATH = polyPath(BOARD.mainland);
const ISLAND_PATHS = BOARD.islands.map((i) => ({ id: i.id, d: polyPath(i.poly) }));
const REGION_PATHS = Object.fromEntries(BOARD.regions.map((r) => [r.id, polyPath(r.poly)]));
const SECTOR_BORDERS = BOARD.borders.filter((b) => BOARD.byId[b.a].sector !== BOARD.byId[b.b].sector);
const MAINLAND = BOARD.regions.filter((r) => r.landmass === 'mainland');
const ISLANDS = BOARD.regions.filter((r) => r.landmass !== 'mainland');

const BADGE_R = 15;

/** Where each region's badge is drawn. */
export const BADGE_AT: Record<string, [number, number]> = Object.fromEntries(
  BOARD.regions.map((r) => {
    const n = BADGE_NUDGE[r.id] ?? [0, 0];
    return [r.id, [r.site[0] + n[0], r.site[1] + n[1]]];
  }),
);

const at = (id: string) => BADGE_AT[id];

/** A quadratic route from a to b bowed by control point c, stopping `stop` short of b. */
function route(x1: number, y1: number, x2: number, y2: number, cx: number, cy: number, stop: number) {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const t = Math.max(0.45, 1 - stop / len);
  const bx = (1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2;
  const by = (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2;
  // Tangent at t, for the arrowhead.
  const tx = 2 * (1 - t) * (cx - x1) + 2 * t * (x2 - cx);
  const ty = 2 * (1 - t) * (cy - y1) + 2 * t * (y2 - cy);
  const mid: [number, number] = [0.25 * x1 + 0.5 * cx + 0.25 * x2, 0.25 * y1 + 0.5 * cy + 0.25 * y2];
  return { d: `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${bx.toFixed(1)},${by.toFixed(1)}`, end: [bx, by] as [number, number], angle: (Math.atan2(ty, tx) * 180) / Math.PI, mid };
}

const ISLAND_CENTRE: [number, number] = [520, 290];

function arrowGeometry(a: OrderArrow) {
  if (a.sail) {
    const [x1, y1] = SEA_ZONES[a.from as ZoneId].anchor;
    const [x2, y2] = SEA_ZONES[a.to as ZoneId].anchor;
    // Bow away from the island so a sail never cuts across the land.
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const ox = mx - ISLAND_CENTRE[0], oy = my - ISLAND_CENTRE[1];
    const ol = Math.hypot(ox, oy) || 1;
    const push = Math.hypot(x2 - x1, y2 - y1) * 0.45;
    return route(x1, y1, x2, y2, mx + (ox / ol) * push, my + (oy / ol) * push, 30);
  }
  const [x1, y1] = at(a.from);
  const [x2, y2] = at(a.to);
  let cx: number, cy: number;
  if (a.via) {
    // Swing out over the sea zone the landing crosses.
    const [ax, ay] = SEA_ZONES[a.via].anchor;
    cx = (3 * ax - (x1 + x2) / 2) / 2;
    cy = (3 * ay - (y1 + y2) / 2) / 2;
  } else {
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    cx = (x1 + x2) / 2 - ((y2 - y1) / len) * len * 0.18;
    cy = (y1 + y2) / 2 + ((x2 - x1) / len) * len * 0.18;
  }
  return route(x1, y1, x2, y2, cx, cy, 30);
}

function regionAt(clientX: number, clientY: number): string | null {
  const el = document.elementFromPoint(clientX, clientY);
  return el?.closest('[data-region]')?.getAttribute('data-region') ?? null;
}

/** The neighbour lying most nearly in a direction, for arrow-key navigation. */
function neighbourToward(id: string, dx: number, dy: number): string | null {
  const [x, y] = at(id);
  let best: string | null = null, bestScore = -Infinity;
  for (const n of BOARD.byId[id].neighbours) {
    const [nx, ny] = at(n);
    const vx = nx - x, vy = ny - y;
    const len = Math.hypot(vx, vy) || 1;
    const cos = (vx * dx + vy * dy) / len;
    if (cos < 0.3) continue;
    const score = cos - len / 600;
    if (score > bestScore) (bestScore = score), (best = n);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Per-faction textures laid over the fill, so territories differ by more than hue. */
function FactionPatterns() {
  const ink = 'rgba(255,255,255,0.2)';
  return (
    <>
      <pattern id="io-pat-SINGA" width="12" height="12" patternUnits="userSpaceOnUse">
        <path d="M0 6 L6 0 L12 6 L6 12Z" fill="none" stroke={ink} strokeWidth="1.2" />
      </pattern>
      <pattern id="io-pat-HARIMAU" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
        <rect width="4.5" height="14" fill="rgba(60,30,0,0.16)" />
      </pattern>
      <pattern id="io-pat-HELANG" width="11" height="11" patternUnits="userSpaceOnUse">
        <circle cx="5.5" cy="5.5" r="1.6" fill={ink} />
      </pattern>
      <pattern id="io-pat-JERUNG" width="18" height="10" patternUnits="userSpaceOnUse">
        <path d="M0 6 Q4.5 2 9 6 T18 6" fill="none" stroke={ink} strokeWidth="1.3" />
      </pattern>
    </>
  );
}

function Plinth() {
  return (
    <g pointerEvents="none">
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
      <g transform="translate(0 9)" fill="#4f3a28">
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
    </g>
  );
}

const ShipTokenPath = 'M-15 -1 H15 L10 8 H-10Z M-7 -1 V-6 H5 V-1';

const Stronghold = () => <path d="M-3.6 3.6 V-2 H-2.2 V-3.8 H-0.7 V-2 H0.7 V-3.8 H2.2 V-2 H3.6 V3.6Z" />;

const StarPath = 'M0 -6 L1.8 -1.8 L6 -1.8 L2.6 1 L3.8 5.4 L0 2.8 L-3.8 5.4 L-2.6 1 L-6 -1.8 L-1.8 -1.8Z';

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
  onRegion, onZone, onShip, showLabels = true, threats = [], drag, focus = null, insets = NO_INSETS, camera = false, cover = false, home, describe, selected,
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

  // First real layout: on a small screen, open zoomed in on the player's own ground.
  useEffect(() => {
    if (!camera || opened.current || !W || !H) return;
    opened.current = true;
    if (fit >= 0.7 || !home?.length) return;
    const pts = home.map(at);
    const cx = pts.reduce((n, p) => n + p[0], 0) / pts.length;
    const cy = pts.reduce((n, p) => n + p[1], 0) / pts.length;
    setCam(clampCam({ z: comfortable / fit, cx, cy }));
  }, [camera, W, H, fit, home, clampCam]);

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

  // --- keyboard ---
  const focusBadge = (id: string) => {
    const el = svgRef.current?.querySelector<SVGGElement>(`[data-badge="${id}"]`);
    el?.focus();
  };
  const onBadgeKey = (id: string, e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      onRegion?.(id);
      return;
    }
    const dir: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
    const d = dir[e.key];
    if (!d) return;
    e.preventDefault();
    const n = neighbourToward(id, d[0], d[1]);
    if (n) focusBadge(n);
  };

  // --- render ---
  const far = !cover && scale < 0.72;
  // A 44px touch target where it fits, but never so big it swallows a neighbour's taps.
  const hitR = Math.min(26, Math.max(BADGE_R + 5, 22 / (scale || 1)));
  const interactive = !!onRegion;
  const dimmed = dimOthers ? BOARD.regions.filter((r) => !highlights[r.id]).map((r) => r.id) : [];

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
        aria-label={interactive ? 'Map of the island. Tab to a region, arrow keys to move between neighbours, Enter to act.' : 'Map of the island'}
      >
        <defs>
          <linearGradient id="io-sheen" x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0%" stopColor="#fff" stopOpacity="0.26" />
            <stop offset="55%" stopColor="#fff" stopOpacity="0.03" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.16" />
          </linearGradient>
          <clipPath id="io-clip-main">
            <path d={MAIN_PATH} />
          </clipPath>
          <filter id="io-badge-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="2.5" stdDeviation="1.6" floodColor="#000" floodOpacity="0.45" />
          </filter>
          <FactionPatterns />
        </defs>

        {/* Sea-zone pads sit on the water, under everything else. */}
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
                onKeyDown={onZone ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onZone(z)) : undefined}
                tabIndex={onZone && hl === 'sail' ? 0 : undefined}
                role={onZone && hl === 'sail' ? 'button' : undefined}
                aria-label={onZone && hl === 'sail' ? `Sail to the ${SEA_ZONES[z].name}` : undefined}
                data-zone={z}
              >
                <ellipse rx={66} ry={32} className="io-zone-pad" />
                <text y={-19} className="io-zone-name">
                  {SEA_ZONES[z].name.toUpperCase()}
                </text>
              </g>
            );
          })}
        </g>

        <Plinth />

        <g clipPath="url(#io-clip-main)">
          {MAINLAND.map((r) => renderRegion(r.id))}
          <g pointerEvents="none">{MAINLAND.map((r) => renderTexture(r.id))}</g>
          <path d={MAIN_PATH} fill="url(#io-sheen)" pointerEvents="none" />
          {SECTOR_BORDERS.map((b, i) => (
            <line key={i} x1={b.from[0]} y1={b.from[1]} x2={b.to[0]} y2={b.to[1]} className="io-sector-border" />
          ))}
          <g pointerEvents="none" className="io-veil">
            {dimmed.filter((id) => BOARD.byId[id].landmass === 'mainland').map((id) => (
              <path key={id} d={REGION_PATHS[id]} />
            ))}
          </g>
        </g>
        {ISLANDS.map((r) => renderRegion(r.id))}
        <g pointerEvents="none">
          {ISLANDS.map((r) => renderTexture(r.id))}
          {ISLAND_PATHS.map((i) => (
            <path key={i.id} d={i.d} fill="url(#io-sheen)" />
          ))}
          <g className="io-veil">
            {dimmed.filter((id) => BOARD.byId[id].landmass !== 'mainland').map((id) => (
              <path key={id} d={REGION_PATHS[id]} />
            ))}
          </g>
          <path d={MAIN_PATH} className="io-coast" />
          {ISLAND_PATHS.map((i) => (
            <path key={i.id} d={i.d} className="io-coast" />
          ))}
          {/* Highlight outlines drawn again unclipped, on top of the coast, so they read all the way round. */}
          {Object.entries(highlights).map(([id, hl]) => (
            <path key={id} d={REGION_PATHS[id]} className={`io-hl-line io-hl-${hl}`} clipPath={BOARD.byId[id].landmass === 'mainland' ? 'url(#io-clip-main)' : undefined} />
          ))}
        </g>

        {/* Landmarks beside their badges. */}
        <g pointerEvents="none" className="io-landmarks">
          {BOARD.regions.map((r) => {
            const off = r.id in LANDMARK_AT ? LANDMARK_AT[r.id] : [36, -14];
            if (!r.landmark || !off) return null;
            return (
              <g key={r.id} transform={`translate(${at(r.id)[0] + off[0]} ${at(r.id)[1] + off[1]}) scale(0.85)`}>
                <LandmarkGlyph kind={r.landmark} />
              </g>
            );
          })}
        </g>

        {/* Ships, grouped per zone. */}
        <g>
          {ZONE_IDS.map((z) => {
            const here = ships.filter((sh) => sh.zone === z);
            const [x, y] = SEA_ZONES[z].anchor;
            return here.map((sh, i) => {
              const f = FACTIONS[sh.owner];
              const dx = (i - (here.length - 1) / 2) * 32;
              const mine = !!onShip;
              return (
                <g
                  key={sh.id}
                  style={{ transform: `translate(${x + dx}px, ${y + 8}px)` }}
                  className={`io-ship${sh.id === selectedShip ? ' io-ship-on' : ''}${mine ? ' io-clickable' : ''}`}
                  onClick={onShip ? (e) => (e.stopPropagation(), onShip(sh.id)) : undefined}
                  onKeyDown={onShip ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onShip(sh.id)) : undefined}
                  tabIndex={onShip ? 0 : undefined}
                  role={onShip ? 'button' : undefined}
                  aria-label={`${sh.name}, ${f.name}, ${SEA_ZONES[z].name}`}
                  data-ship={sh.id}
                >
                  <title>{`${sh.name} — ${f.name}`}</title>
                  <path d={ShipTokenPath} fill={f.color} stroke="#fff" strokeWidth={2} strokeLinejoin="round" />
                  <g transform="translate(-5 -1) scale(0.42)">
                    <Emblem faction={sh.owner} size={24} color={FACTION_INK[sh.owner]} />
                  </g>
                </g>
              );
            });
          })}
        </g>

        {/* Planned orders and playback routes, under the badges. */}
        <g>
          {arrows.map((a) => {
            const g = arrowGeometry(a);
            const color = a.broken ? '#ff5a4e' : a.color;
            const cls = `io-order${a.via ? ' io-order-landing' : ''}${a.sail ? ' io-order-sail' : ''}${a.travel ? ' io-order-faint' : ''}${a.broken ? ' io-order-broken' : ''}`;
            return (
              <g key={a.id} className={a.onClick ? 'io-clickable' : undefined} onClick={a.onClick}>
                <path d={g.d} className="io-order-casing" />
                <path d={g.d} className={cls} stroke={color} />
                <path d="M-7 -6 L5 0 L-7 6Z" transform={`translate(${g.end[0]} ${g.end[1]}) rotate(${g.angle})`} className="io-order-head" fill={color} />
              </g>
            );
          })}
        </g>

        {/* Strength badges. */}
        <g>
          {BOARD.regions.map((r) => {
            const b = badges[r.id];
            if (!b) return null;
            const f = FACTIONS[b.owner];
            const ki = INSTALLATIONS[r.id];
            const wide = b.text.length > 2;
            const rx = wide ? BADGE_R + 6 : BADGE_R;
            const [x, y] = at(r.id);
            const side = LABEL_SIDE[r.id];
            const label =
              side === 'left'
                ? { x: -rx - (ki ? 9 : 6), y: 4, anchor: 'end' as const }
                : side === 'above'
                  ? { x: 0, y: -BADGE_R - (ki ? 15 : 7), anchor: 'middle' as const }
                  : { x: 0, y: BADGE_R + (ki ? 16 : 12), anchor: 'middle' as const };
            return (
              <g
                key={r.id}
                transform={`translate(${x} ${y})`}
                className={`io-badge${interactive ? ' io-clickable' : ''}${selected === r.id ? ' io-badge-selected' : ''}`}
                onClick={onRegion ? () => onRegion(r.id) : undefined}
                onKeyDown={onRegion ? (e) => onBadgeKey(r.id, e) : undefined}
                onFocus={camera ? () => glideTo(x, y) : undefined}
                tabIndex={interactive ? 0 : undefined}
                role={interactive ? 'button' : undefined}
                aria-label={interactive ? describe?.(r.id) ?? r.name : undefined}
                data-region={r.id}
                data-badge={r.id}
              >
                <circle r={hitR} className="io-hit" />
                <rect x={-rx - 6} y={-BADGE_R - 6} width={2 * rx + 12} height={2 * BADGE_R + 12} rx={BADGE_R + 6} className="io-focus-ring" />
                <g filter="url(#io-badge-shadow)">
                  {ki && <rect x={-rx - 5} y={-BADGE_R - 5} width={2 * rx + 10} height={2 * BADGE_R + 10} rx={BADGE_R + 5} className="io-ki-ring" />}
                  <rect x={-rx - 2.5} y={-BADGE_R - 2.5} width={2 * rx + 5} height={2 * BADGE_R + 5} rx={BADGE_R + 2.5} fill="#fff" />
                  <rect x={-rx} y={-BADGE_R} width={2 * rx} height={2 * BADGE_R} rx={BADGE_R} fill={b.fog ? FOG.rim : f.deep} />
                  <rect x={-rx + 3} y={-BADGE_R + 3} width={2 * rx - 6} height={2 * BADGE_R - 6} rx={BADGE_R - 3} fill={b.fog ? FOG.fill : f.color} />
                </g>
                {ki && <path d={StarPath} transform={`translate(0 ${-BADGE_R - 6})`} className="io-ki-star" />}
                {BOARD.byId[r.id].stronghold && (
                  <g transform={`translate(${rx - 1} ${-BADGE_R + 1})`} className="io-fort">
                    <circle r={6.5} />
                    <Stronghold />
                  </g>
                )}
                <text key={b.text} className={`io-badge-num${b.fog ? ' io-badge-fog' : ''}`} dy="0.36em" fontSize={wide ? 12 : 15} style={{ fill: b.fog ? '#fff' : FACTION_INK[b.owner] }}>
                  {b.text}
                </text>
                {b.extra && (
                  <g transform={`translate(${rx + 3} ${BADGE_R - 3})`} className="io-badge-extra">
                    <rect x={-1} y={-8} width={b.extra.length * 7 + 7} height={15} rx={7.5} />
                    <text x={2.5} y={3.6}>
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
                {showLabels && (
                  <text className="io-region-name" x={label.x} y={label.y} style={{ textAnchor: label.anchor }}>
                    {r.name}
                  </text>
                )}
              </g>
            );
          })}
        </g>

        {/* Travelling columns and order counts ride above the badges. */}
        <g pointerEvents="none">
          {arrows.map((a) => {
            if (!a.label) return null;
            const g = arrowGeometry(a);
            if (a.travel)
              return (
                <Traveller key={a.id} d={g.d} dur={1500}>
                  <circle r={11} fill={a.color} stroke="#fff" strokeWidth={2.5} className="io-token" />
                  <text y={4} className="io-token-text">
                    {a.label}
                  </text>
                </Traveller>
              );
            return (
              <g key={a.id} transform={`translate(${g.mid[0]} ${g.mid[1]})`} className="io-order-chip">
                <rect x={-13} y={-9} width={26} height={18} rx={9} fill={a.broken ? '#ff5a4e' : a.color} />
                <text y={4.5}>{a.label}</text>
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
