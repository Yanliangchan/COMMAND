// ============================================================================
// The board's effects layer: what playback is looking at (focus reticle, clash
// mark) and the one-shot effects — naval gunfire, strike runs, marching
// columns (dust and a thump), road clashes, battle impacts, captures, scoring
// stars, eliminations.
//
// PERFORMANCE. The one-shot effects and the travelling tokens are not drawn in
// the board's SVG: anything animating in there makes the whole board restyle,
// repaint and re-layerize every frame, and SVG animations never leave the main
// thread. They are small HTML elements in an overlay right after the board
// (".io-fx-host"), inside one container that carries the board's matrix — so
// they sit in board coordinates — and they animate transform and opacity only,
// which the compositor runs off the main thread. Every effect is short (under
// ~1.6 s), capped in particle count, and removed by the director
// (usePlayback); nothing loops, so an idle board costs nothing. The focus
// reticle and clash mark stay in the board: they animate once, for a third of
// a second.
// REDUCED MOTION: no one-shot effects at all; tokens appear at their
// destination; the reticle and clash mark appear without animation.
// ============================================================================

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { SEA_ZONES, ZoneId } from '../map';
import type { Focus, Fx } from './MapView';
import './effects.css';

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The richer effects playback produces. A PlayFx is still an Fx (MapView's
 * type), so it travels through MapView's `fx` prop unchanged; `burst` says
 * what to draw. Without a burst, `kind` draws the classic effect.
 */
export type Burst =
  /** Rival fleets trade fire in a sea zone; sunk ships go down. */
  | { type: 'naval'; zone: ZoneId; sides: { color: string; ships: number; sunk: number }[] }
  /** A jet (with its ground shadow) runs in and bombs the region. */
  | { type: 'strike'; region: string; color: string }
  /** Columns meet on the road between two regions. */
  | { type: 'sparks'; between: [string, string] }
  /** A battle's result lands: size 0–1 scales the blast (fixed and small when unseen). */
  | { type: 'impact'; region: string; size: number }
  /** Ground changes hands: a flag goes up in the winner's colour. */
  | { type: 'capture'; region: string; color: string }
  /** Installations score: a star rises from each, in its holder's colour. */
  | { type: 'stars'; from: { region: string; color: string }[] }
  /** A task force is wiped out: smoke where it last stood. */
  | { type: 'wipe'; regions: string[]; color: string }
  /** A ship recommissions at a naval base. */
  | { type: 'launch'; zone: ZoneId; color: string };

export interface PlayFx extends Fx {
  burst?: Burst;
  /** Playback speed (1 or 2): every duration and delay is divided by it. */
  speed?: number;
}

type Pt = [number, number];

// ---------------------------------------------------------------------------
// The overlay: Effects publishes its token container; travellers render into it.
// ---------------------------------------------------------------------------

let overlay: HTMLDivElement | null = null;
const overlaySubs = new Set<() => void>();
function setOverlay(el: HTMLDivElement | null) {
  overlay = el;
  overlaySubs.forEach((f) => f());
}
function useOverlay() {
  return useSyncExternalStore(
    (f) => (overlaySubs.add(f), () => void overlaySubs.delete(f)),
    () => overlay,
    () => null,
  );
}

// ---------------------------------------------------------------------------
// Travelling tokens (columns, jets)
// ---------------------------------------------------------------------------

/** Playback speed for travellers, set by the director (usePlayback). */
let travelSpeed = 1;
export function setTravelSpeed(s: number) {
  travelSpeed = s > 0 ? s : 1;
}

/**
 * Dust trails are capped per playback step: the director grants a budget when
 * columns set off, and each marching token takes one while it lasts — the rest
 * still move and land, just without dust.
 */
let trailsLeft = 0;
export function allowTrails(n: number) {
  trailsLeft = n;
}

/** The end point of a path whose last command ends on absolute coordinates. */
function pathEnd(d: string): Pt {
  const n = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? ['0', '0'];
  return [+n[n.length - 2], +n[n.length - 1]];
}

/** Points evenly spaced by distance along a path (falls back to a straight line). */
function samplePath(d: string, n = 24): Pt[] {
  try {
    const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('d', d);
    const len = el.getTotalLength();
    if (!(len > 0)) throw new Error('empty');
    return Array.from({ length: n + 1 }, (_, i) => {
      const p = el.getPointAtLength((len * i) / n);
      return [p.x, p.y] as Pt;
    });
  } catch {
    const s = (d.match(/-?\d*\.?\d+/g) ?? ['0', '0']).slice(0, 2).map(Number);
    const e = pathEnd(d);
    return Array.from({ length: n + 1 }, (_, i) => [s[0] + ((e[0] - s[0]) * i) / n, s[1] + ((e[1] - s[1]) * i) / n] as Pt);
  }
}

const TRAVEL_EASE = 'cubic-bezier(0.4, 0, 0.2, 1)';

/** Where a token is at time fraction τ, for TRAVEL_EASE (progress along the path by distance). */
function eased(tau: number) {
  const bx = (s: number) => 3 * (1 - s) * (1 - s) * s * 0.4 + 3 * (1 - s) * s * s * 0.2 + s * s * s;
  const by = (s: number) => 3 * (1 - s) * s * s + s * s * s;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const m = (lo + hi) / 2;
    if (bx(m) < tau) lo = m;
    else hi = m;
  }
  return by((lo + hi) / 2);
}

/** SVG content (in board units, around 0,0) inside an HTML box the compositor can move. */
function Glyph({ children, className, style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`io-glyph${className ? ` ${className}` : ''}`} style={style}>
      <svg width="1" height="1" overflow="visible">
        {children}
      </svg>
    </div>
  );
}

/**
 * A token that runs along an SVG path (board coordinates) once, from when it
 * mounts, then rests at the end — or, with `vanish`, disappears. A marching
 * token (`trail`, the default) kicks up dust behind it and lands with a thump.
 * Drawn in the effects overlay and moved with a transform animation; durations
 * follow the playback speed. With reduced motion it just appears at the end.
 * Outside a board with Effects it renders in place, at its destination.
 */
export function Traveller({ d, dur, children, vanish, trail = true }: { d: string; dur: number; children: React.ReactNode; vanish?: boolean; trail?: boolean }) {
  const host = useOverlay();
  const ref = useRef<HTMLDivElement>(null);
  const still = prefersReducedMotion();
  const [ms] = useState(() => dur / travelSpeed);
  const [dusty] = useState(() => trail && trailsLeft-- > 0);
  const [gone, setGone] = useState(false);
  const pts = useMemo(() => samplePath(d), [d]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || still || !el.animate) return;
    const anim = el.animate(
      pts.map(([x, y]) => ({ transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)` })),
      { duration: ms, easing: TRAVEL_EASE, fill: 'both' },
    );
    if (vanish) anim.onfinish = () => setGone(true);
    return () => anim.cancel();
  }, [pts, ms, still, vanish, host]);
  if (gone) return null;
  const end = pts[pts.length - 1];
  if (!host) {
    if (vanish) return null;
    return <g transform={`translate(${end[0]} ${end[1]})`}>{children}</g>;
  }
  const at = still ? end : pts[0];
  return createPortal(
    <>
      {dusty && !still && <Trail pts={pts} ms={ms} />}
      <div ref={ref} className="io-glyph io-traveller" style={{ transform: `translate(${at[0]}px, ${at[1]}px)` }}>
        <svg width="1" height="1" overflow="visible">
          {children}
        </svg>
      </div>
    </>,
    host,
  );
}

/** Dust behind a marching token (timed to where the token is) and the thump on arrival. */
function Trail({ pts, ms }: { pts: Pt[]; ms: number }) {
  const n = pts.length - 1;
  const at = (f: number) => pts[Math.min(n, Math.max(0, Math.round(f * n)))];
  const end = pts[n];
  return (
    <div className="io-fx" style={{ ['--sp' as string]: 1 }}>
      {[0.3, 0.65].map((tau, i) => {
        const [x, y] = at(eased(tau));
        return <Dot key={i} x={x} y={y + 5} r={7.5} cls="io-fx-dust" d={tau * ms} m={{ dx: i ? 4 : -4, dy: -6 }} />;
      })}
      <Dot x={end[0]} y={end[1]} r={15} cls="io-fx-thump" d={ms - 30} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

/** Cheap deterministic jitter, so particles differ per effect but not per render. */
function rand(seed: string, i: number) {
  let h = 2166136261 ^ i;
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/**
 * One particle: an HTML box centred on (x, y) in board units, r its radius
 * (or w × h). Its animation (class) starts after d ms (at 1×) and moves it by
 * m.dx, m.dy and turns it m.rot degrees; rot is a fixed starting angle.
 */
function Dot({ x, y, r = 4, w, h, cls, d = 0, m, color, rot }: { x: number; y: number; r?: number; w?: number; h?: number; cls: string; d?: number; m?: { dx?: number; dy?: number; rot?: number }; color?: string; rot?: number }) {
  const W = w ?? 2 * r, H = h ?? 2 * r;
  const style: Record<string, string | number> = {
    left: `${(x - W / 2).toFixed(1)}px`,
    top: `${(y - H / 2).toFixed(1)}px`,
    width: `${W}px`,
    height: `${H}px`,
    '--d': `${Math.round(d)}ms`,
  };
  if (m?.dx !== undefined) style['--dx'] = `${m.dx.toFixed(1)}px`;
  if (m?.dy !== undefined) style['--dy'] = `${m.dy.toFixed(1)}px`;
  if (m?.rot !== undefined) style['--rot'] = `${Math.round(m.rot)}deg`;
  if (rot !== undefined) style['--r0'] = `${Math.round(rot)}deg`;
  if (color) style['--c'] = color;
  return <i className={`io-p ${cls}`} style={style as React.CSSProperties} />;
}

const STAR = 'M0 -9.5l3.5 7.2 7.9 1-5.9 5.4 1.6 7.8L0 18l-7.1 3.9 1.6-7.8-5.9-5.4 7.9-1z';
const SHIP = 'M-13 -1h26l-4.5 8h-17z M-6 -1v-5h11v5';
const JET = 'M12 2l1.6 6.2 8 4v2.2l-8-2-.8 5 3 2v2L12 20.5l-3.8.9v-2l3-2-.8-5-8 2v-2.2l8-4z';

/** Flash, fireball, shockwave, scorch and debris: strikes and battles. */
function Blast({ id, x, y, size, delay, debris }: { id: string; x: number; y: number; size: number; delay: number; debris: number }) {
  const s = 0.75 + size * 0.85;
  return (
    <>
      <Dot x={x} y={y + 6} w={36 * s} h={16 * s} cls="io-fx-scorch" d={delay} />
      <Dot x={x} y={y} r={22 * s} cls="io-fx-shock" d={delay} />
      <Dot x={x} y={y} r={13 * s} cls="io-fx-flash" d={delay} />
      <Dot x={x} y={y} r={8 * s} cls="io-fx-core" d={delay} />
      {Array.from({ length: debris }, (_, i) => {
        const a = (i / debris) * Math.PI * 2 + rand(id, i) * 0.8;
        const r = (26 + rand(id, i + 9) * 18) * s;
        return <Dot key={i} x={x} y={y} w={4.5} h={4.5} cls="io-fx-debris" d={delay + 20} m={{ dx: Math.cos(a) * r, dy: Math.sin(a) * r - 10 * s, rot: rand(id, i + 3) * 540 - 270 }} />;
      })}
    </>
  );
}

function BurstView({ f, burst, at }: { f: PlayFx; burst: Burst; at: (id: string) => Pt }) {
  const id = f.id;
  switch (burst.type) {
    case 'naval': {
      const [ax, ay] = SEA_ZONES[burst.zone].anchor;
      const total = burst.sides.reduce((n, s) => n + s.ships, 0) || 1;
      // Ships sit in a row through the zone's anchor (as MapView draws them); each side's block in order.
      let offset = 0;
      const blocks = burst.sides.map((s) => {
        const xs = Array.from({ length: Math.max(1, s.ships) }, (_, i) => ax + (offset + i - (total - 1) / 2) * 32);
        offset += s.ships;
        return { ...s, xs };
      });
      const els: React.ReactNode[] = [];
      blocks.forEach((b, k) => {
        const foes = blocks.filter((_, j) => j !== k);
        // Up to three salvoes per side, staggered; each lands as a splash near a rival ship.
        for (let i = 0; i < Math.min(3, Math.max(1, b.ships)); i++) {
          const sx = b.xs[i % b.xs.length], sy = ay;
          const t = 80 + i * 260 + k * 120;
          els.push(
            <Dot key={`m${k}-${i}`} x={sx} y={sy} r={9} cls="io-fx-muzzle" d={t} />,
            <Dot key={`ms${k}-${i}`} x={sx} y={sy - 4} r={5} cls="io-fx-smoke" d={t + 120} m={{ dx: 6, dy: -12 }} />,
          );
          const foe = foes[(i + k) % Math.max(1, foes.length)];
          if (foe) {
            const tx = foe.xs[i % foe.xs.length] + (rand(id, i + k * 7) - 0.5) * 30, ty = ay + 8 + (rand(id, i + k * 5) - 0.5) * 22;
            els.push(
              <Glyph key={`s${k}-${i}`} className="io-fx-splash" style={{ left: tx, top: ty, ['--d' as string]: `${t + 260}ms` }}>
                <path d="M-5 0 L-2.5 -14 L0 -4 L2.5 -16 L5 0Z" fill="#fff" />
              </Glyph>,
              <Dot key={`sr${k}-${i}`} x={tx} y={ty} w={20} h={7} cls="io-fx-ring io-fx-splash-ring" d={t + 260} />,
            );
          }
        }
        // Sunk ships go down at the end of the exchange.
        for (let i = 0; i < Math.min(b.sunk, b.xs.length, 3); i++) {
          const x = b.xs[b.xs.length - 1 - i], y = ay + 8, t = 900 + i * 120;
          els.push(
            <Glyph key={`k${k}-${i}`} className="io-fx-sink" style={{ left: x, top: y, ['--d' as string]: `${t}ms` }}>
              <path d={SHIP} fill={b.color} stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
            </Glyph>,
            <Dot key={`kf${k}-${i}`} x={x - 3} y={y - 4} r={6} cls="io-fx-muzzle" d={t} />,
            <Dot key={`kr${k}-${i}`} x={x} y={y + 7} w={32} h={10} cls="io-fx-ring io-fx-splash-ring" d={t + 300} />,
            <Dot key={`ks${k}-${i}`} x={x + 2} y={y - 6} r={6} cls="io-fx-smoke" d={t + 50} m={{ dx: 4, dy: -20 }} />,
            <Dot key={`kt${k}-${i}`} x={x - 4} y={y - 4} r={5} cls="io-fx-smoke" d={t + 200} m={{ dx: -3, dy: -18 }} />,
          );
        }
      });
      return <>{els}</>;
    }
    case 'strike': {
      const [x, y] = at(burst.region);
      const d = `M${x - 190},${y - 120} Q${x - 40},${y - 50} ${x},${y} T${x + 170},${y + 40}`;
      // The shadow runs on the ground, offset as if the sun were high in the north-west.
      const sd = `M${x - 160},${y - 60} Q${x - 20},${y - 10} ${x + 22},${y + 26} T${x + 190},${y + 70}`;
      return (
        <>
          <Traveller d={sd} dur={900} vanish trail={false}>
            <path d={JET} transform="rotate(118) translate(-9 -9) scale(0.75)" className="io-fx-jet-shadow" />
          </Traveller>
          <Blast id={id} x={x} y={y} size={0.55} delay={400} debris={6} />
          <Traveller d={d} dur={900} vanish trail={false}>
            <path d={JET} transform="rotate(118) translate(-14 -14) scale(1.15)" className="io-jet-body" style={{ stroke: burst.color }} />
          </Traveller>
        </>
      );
    }
    case 'sparks': {
      const [a, b] = burst.between.map(at);
      const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
      return (
        <>
          <Dot x={x} y={y} r={16} cls="io-fx-flash" d={220} />
          {Array.from({ length: 8 }, (_, i) => {
            const ang = (i / 8) * 360 + rand(id, i) * 30;
            return <Dot key={i} x={x} y={y} w={10} h={2.6} cls="io-fx-spark" d={230 + rand(id, i + 4) * 120} rot={ang} m={{ dx: 16 + rand(id, i + 2) * 14 }} />;
          })}
        </>
      );
    }
    case 'impact': {
      const [x, y] = at(burst.region);
      return <Blast id={id} x={x} y={y} size={burst.size} delay={0} debris={burst.size > 0.35 ? Math.round(3 + burst.size * 3) : 0} />;
    }
    case 'capture': {
      const [x, y] = at(burst.region);
      return (
        <>
          <Dot x={x} y={y} r={24} cls="io-fx-ring io-fx-cap" color={burst.color} d={0} />
          <Dot x={x} y={y} r={24} cls="io-fx-ring io-fx-cap" color={burst.color} d={250} />
          {Array.from({ length: 8 }, (_, i) => {
            const ang = (i / 8) * Math.PI * 2 + 0.3;
            return <Dot key={i} x={x} y={y} w={5} h={3} cls="io-fx-confetti" color={i % 2 ? '#fff' : burst.color} d={120 + (i % 3) * 40} m={{ dx: Math.cos(ang) * (30 + (i % 3) * 8), dy: Math.sin(ang) * 26 - 16, rot: i * 70 }} />;
          })}
          <Glyph className="io-fx-flag" style={{ left: x, top: y, ['--d' as string]: '60ms' }}>
            <line x1={0} y1={-14} x2={0} y2={-46} stroke="#fff" strokeWidth={2.5} strokeLinecap="round" />
            <path d="M0 -46 L22 -40.5 L0 -34Z" fill={burst.color} stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
          </Glyph>
        </>
      );
    }
    case 'stars':
      return (
        <>
          {burst.from.slice(0, 12).map((s, i) => {
            const [x, y] = at(s.region);
            return (
              <Glyph key={i} className="io-fx-star" style={{ left: x, top: y - 22, ['--d' as string]: `${i * 70}ms` }}>
                <path d={STAR} fill={s.color} stroke="#fff" strokeWidth={1.8} strokeLinejoin="round" />
              </Glyph>
            );
          })}
        </>
      );
    case 'wipe':
      return (
        <>
          {burst.regions.slice(0, 4).map((r, i) => {
            const [x, y] = at(r);
            return [
              <Dot key={`${r}w`} x={x} y={y} r={22} cls="io-fx-wipe" color={burst.color} d={i * 90} />,
              <Dot key={`${r}a`} x={x - 6} y={y - 4} r={8} cls="io-fx-smoke" d={i * 90 + 60} m={{ dx: -6, dy: -22 }} />,
              <Dot key={`${r}b`} x={x + 7} y={y - 2} r={7} cls="io-fx-smoke" d={i * 90 + 160} m={{ dx: 6, dy: -26 }} />,
            ];
          })}
        </>
      );
    case 'launch': {
      const [x, y] = SEA_ZONES[burst.zone].anchor;
      return (
        <>
          <Dot x={x} y={y + 8} w={60} h={22} cls="io-fx-ring io-fx-launch" color={burst.color} d={0} />
          <Dot x={x} y={y + 8} w={60} h={22} cls="io-fx-ring io-fx-launch" color={burst.color} d={260} />
        </>
      );
    }
  }
}

/** The classic effects (an Fx without a burst): blast, capture ripple, loss alert, strike jet. */
function ClassicFx({ f, at }: { f: Fx; at: (id: string) => Pt }) {
  const p = at(f.region);
  if (!p) return null;
  const [x, y] = p;
  if (f.kind === 'jet') {
    const d = `M${x - 190},${y - 120} Q${x - 40},${y - 50} ${x},${y} T${x + 170},${y + 40}`;
    return (
      <Traveller d={d} dur={900} vanish trail={false}>
        <path d={JET} transform="rotate(118) translate(-12 -12)" className="io-jet-body" />
      </Traveller>
    );
  }
  if (f.kind === 'alert') return <Dot x={x} y={y} r={28} cls="io-fx-alert" />;
  if (f.kind === 'ripple')
    return (
      <>
        <Dot x={x} y={y} r={24} cls="io-fx-ring io-fx-cap" color={f.color} d={0} />
        <Dot x={x} y={y} r={24} cls="io-fx-ring io-fx-cap" color={f.color} d={250} />
      </>
    );
  return (
    <>
      <Dot x={x} y={y} r={16} cls="io-fx-flash" d={0} />
      <Dot x={x} y={y} r={18} cls="io-fx-shock" d={0} />
    </>
  );
}

export function Effects({ fx, focus, focusPoint, at }: { fx: Fx[]; focus: Focus | null; focusPoint: [number, number] | null; at: (id: string) => [number, number] }) {
  const still = prefersReducedMotion();
  const anchor = useRef<SVGGElement>(null);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const board = useRef<HTMLDivElement>(null);

  // The overlay lives right after the board's SVG, inside the map box.
  useLayoutEffect(() => {
    const svg = anchor.current?.ownerSVGElement;
    if (!svg?.parentElement) return;
    const div = document.createElement('div');
    div.className = 'io-fx-host';
    svg.after(div);
    setHost(div);
    return () => div.remove();
  }, []);

  // Travellers draw into the overlay while this board is up.
  const tokens = useRef<HTMLDivElement | null>(null);
  const tokensRef = useCallback((el: HTMLDivElement | null) => {
    if (el) setOverlay(el);
    else if (overlay === tokens.current) setOverlay(null);
    tokens.current = el;
  }, []);

  // Keep the overlay on the board: copy the board's matrix on every render
  // (MapView re-renders on every camera move, and so does this). getCTM — to
  // the board's own viewport — so a shake in progress isn't baked in.
  useLayoutEffect(() => {
    const el = board.current, a = anchor.current;
    const m = a?.getCTM();
    if (!el || !m) return;
    const t = `matrix(${m.a}, ${m.b}, ${m.c}, ${m.d}, ${m.e}, ${m.f})`;
    if (el.style.transform !== t) el.style.transform = t;
  });

  const shown = still ? fx.filter((f) => !(f as PlayFx).burst && f.kind === 'alert') : fx;
  return (
    <>
      {/* What playback is looking at: a reticle that closes in once, then holds still. */}
      {focusPoint && (
        <g transform={`translate(${focusPoint[0]} ${focusPoint[1]})`} pointerEvents="none">
          <g key={`${focusPoint[0]},${focusPoint[1]}`} className="io-focus">
            <circle r={focus?.zone ? 46 : 30} className="io-focus-casing" />
            <circle r={focus?.zone ? 46 : 30} />
            <path d={reticle(focus?.zone ? 46 : 30)} className="io-focus-ticks" />
          </g>
        </g>
      )}
      {focus?.between && (
        <g pointerEvents="none" transform={`translate(${(at(focus.between[0])[0] + at(focus.between[1])[0]) / 2} ${(at(focus.between[0])[1] + at(focus.between[1])[1]) / 2})`}>
          <g className="io-clash-mark">
            <path d="M-9 -9 L9 9 M9 -9 L-9 9" className="io-clash-casing" />
            <path d="M-9 -9 L9 9" className="io-clash-a" />
            <path d="M9 -9 L-9 9" className="io-clash-b" />
          </g>
        </g>
      )}

      {/* Where the overlay takes its board matrix from. */}
      <g ref={anchor} />
      {host &&
        createPortal(
          <div ref={board} className="io-fx-board" aria-hidden="true">
            <div ref={tokensRef} />
            {shown.map((f) => {
              const pf = f as PlayFx;
              return (
                <div key={f.id} className="io-fx" style={{ ['--sp' as string]: pf.speed ?? 1 }}>
                  {pf.burst ? <BurstView f={pf} burst={pf.burst} at={at} /> : <ClassicFx f={f} at={at} />}
                </div>
              );
            })}
          </div>,
          host,
        )}
    </>
  );
}

/** Four short ticks on a ring of radius r, like a gunsight. */
function reticle(r: number) {
  const a = r - 7, b = r + 7;
  return `M0 ${-b}V${-a}M0 ${a}V${b}M${-b} 0H${-a}M${a} 0H${b}`;
}
