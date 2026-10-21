// ============================================================================
// The board's effects layer: what playback is looking at (focus reticle, clash
// mark) and the one-shot effects — naval gunfire, strike runs, marching dust,
// road clashes, battle impacts, captures, scoring stars, eliminations.
// Drawn in board coordinates, above the badges.
//
// PERFORMANCE: every effect is a handful of tiny shapes animated with CSS
// transform/opacity only, for under ~1.6 s, and then removed by the director
// (usePlayback) — nothing loops, no filters animate, so the board costs nothing
// once playback is over. Particle counts are capped per effect.
// REDUCED MOTION: the one-shot effects are not drawn at all; the focus reticle
// and the clash mark appear without animation.
// ============================================================================

import { useEffect, useRef, useState } from 'react';
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
  /** Columns on the move: dust behind each token, a thump on arrival. */
  | { type: 'march'; routes: { from: string; to: string; via?: ZoneId; color: string }[] }
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

// ---------------------------------------------------------------------------
// Travelling tokens (columns, jets)
// ---------------------------------------------------------------------------

/** Playback speed for travellers, set by the director (usePlayback). */
let travelSpeed = 1;
export function setTravelSpeed(s: number) {
  travelSpeed = s > 0 ? s : 1;
}

/** The end point of a path whose last command ends on absolute coordinates (M/L/Q/T/C). */
function pathEnd(d: string): [number, number] {
  const n = d.match(/-?\d*\.?\d+(?:e-?\d+)?/gi) ?? ['0', '0'];
  return [+n[n.length - 2], +n[n.length - 1]];
}

/**
 * A token that runs along an SVG path once, from when it mounts. SMIL's
 * default begin is the document's start, long past by now — so start it by hand.
 * Once it arrives the SMIL animation is dropped for a plain transform: a frozen
 * SMIL animation keeps the document's animation clock (and repaints) running.
 * With reduced motion the token simply appears at the end of its route.
 * Durations follow the playback speed.
 */
export function Traveller({ d, dur, children, rotate, vanish }: { d: string; dur: number; children: React.ReactNode; rotate?: 'auto'; vanish?: boolean }) {
  const ref = useRef<SVGAnimateMotionElement>(null);
  const still = prefersReducedMotion();
  const [ms] = useState(() => dur / travelSpeed);
  const [done, setDone] = useState(still);
  useEffect(() => {
    if (still) return;
    setDone(false);
    try {
      ref.current?.beginElement();
    } catch {
      // No SMIL support: the token jumps to the end below.
    }
    const t = window.setTimeout(() => setDone(true), ms + 40);
    return () => clearTimeout(t);
  }, [d, still, ms]);
  if (done) {
    if (vanish) return null;
    const [x, y] = pathEnd(d);
    return <g transform={`translate(${x} ${y})`}>{children}</g>;
  }
  return (
    <g>
      {children}
      <animateMotion ref={ref} dur={`${ms}ms`} begin="indefinite" fill="freeze" path={d} rotate={rotate} keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Geometry — routes match MapView's arrows, so dust follows the tokens.
// ---------------------------------------------------------------------------

type Pt = [number, number];

/** MapView's route for a march or landing: a quadratic bowed sideways (or out over the sea), stopping 30 short. */
function marchRoute(a: Pt, b: Pt, via?: ZoneId) {
  const [x1, y1] = a, [x2, y2] = b;
  let cx: number, cy: number;
  if (via) {
    const [ax, ay] = SEA_ZONES[via].anchor;
    cx = (3 * ax - (x1 + x2) / 2) / 2;
    cy = (3 * ay - (y1 + y2) / 2) / 2;
  } else {
    const len = Math.hypot(x2 - x1, y2 - y1) || 1;
    cx = (x1 + x2) / 2 - ((y2 - y1) / len) * len * 0.18;
    cy = (y1 + y2) / 2 + ((x2 - x1) / len) * len * 0.18;
  }
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const tEnd = Math.max(0.45, 1 - 30 / len);
  const q = (t: number): Pt => [(1 - t) * (1 - t) * x1 + 2 * (1 - t) * t * cx + t * t * x2, (1 - t) * (1 - t) * y1 + 2 * (1 - t) * t * cy + t * t * y2];
  // Arc-length table, for "where is the token at time τ".
  const N = 24;
  const pts: Pt[] = [];
  const acc: number[] = [0];
  for (let i = 0; i <= N; i++) pts.push(q((tEnd * i) / N));
  for (let i = 1; i <= N; i++) acc.push(acc[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = acc[N] || 1;
  const atDistance = (f: number): Pt => {
    const want = f * total;
    let i = 1;
    while (i < N && acc[i] < want) i++;
    const k = (want - acc[i - 1]) / (acc[i] - acc[i - 1] || 1);
    return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k];
  };
  return { atDistance, end: pts[N] };
}

/** The token's progress along its route at time fraction τ, for SMIL's keySplines "0.4 0 0.2 1". */
function eased(tau: number) {
  // cubic-bezier(0.4, 0, 0.2, 1): solve x(s) = τ by bisection, return y(s).
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

/** Cheap deterministic jitter, so particles differ per effect but not per render. */
function rand(seed: string, i: number) {
  let h = 2166136261 ^ i;
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619);
  return ((h >>> 0) % 1000) / 1000;
}

/** Inline style for one animated particle: its delay (ms at 1×) and motion. */
const P = (d: number, extra: Record<string, number | string> = {}) => ({ ['--d' as string]: `${Math.round(d)}ms`, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [`--${k}`, typeof v === 'number' ? `${v.toFixed(1)}px` : v])) }) as React.CSSProperties;

const MARCH_MS = 1500;
const STAR_PATH = 'M0 -7.5l2.2 4.6 5 .6-3.7 3.4 1 5L0 13.6l-4.5 2.5 1-5L-7.2 7.8l5-.6z';
const SHIP_PATH = 'M-12 -1h24l-4 7h-16z M-6 -1v-4h10v4';

/** Debris and a shockwave: shared by strikes and battles. */
function Blast({ id, x, y, size, delay, debris }: { id: string; x: number; y: number; size: number; delay: number; debris: number }) {
  const s = 0.75 + size * 0.85;
  return (
    <g transform={`translate(${x} ${y})`}>
      <ellipse rx={18 * s} ry={8 * s} cy={6} className="io-fx-scorch" style={P(delay)} />
      <circle r={22 * s} className="io-fx-shock" style={P(delay)} />
      <circle r={13 * s} className="io-fx-flash" style={P(delay)} />
      <circle r={7 * s} className="io-fx-core" style={P(delay)} />
      {Array.from({ length: debris }, (_, i) => {
        const a = (i / debris) * Math.PI * 2 + rand(id, i) * 0.8;
        const r = (26 + rand(id, i + 9) * 18) * s;
        return <rect key={i} x={-2} y={-2} width={4} height={4} rx={1} className="io-fx-debris" style={P(delay + 20, { dx: Math.cos(a) * r, dy: Math.sin(a) * r - 10 * s, rot: `${Math.round(rand(id, i + 3) * 540 - 270)}deg` })} />;
      })}
    </g>
  );
}

function Puff({ x, y, delay, r = 6, cls = 'io-fx-dust', drift = [0, -6] }: { x: number; y: number; delay: number; r?: number; cls?: string; drift?: Pt }) {
  return (
    <g transform={`translate(${x.toFixed(1)} ${y.toFixed(1)})`}>
      <circle r={r} className={cls} style={P(delay, { dx: drift[0], dy: drift[1] })} />
    </g>
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
          const sx = b.xs[i % b.xs.length], sy = ay + 4;
          const t = 80 + i * 260 + k * 120;
          els.push(
            <Puff key={`m${k}-${i}`} x={sx} y={sy - 4} delay={t} r={8} cls="io-fx-muzzle" drift={[0, 0]} />,
            <Puff key={`ms${k}-${i}`} x={sx} y={sy - 8} delay={t + 120} r={5} cls="io-fx-smoke" drift={[6, -12]} />,
          );
          const foe = foes[(i + k) % Math.max(1, foes.length)];
          if (foe) {
            const tx = foe.xs[i % foe.xs.length] + (rand(id, i + k * 7) - 0.5) * 30, ty = ay + 8 + (rand(id, i + k * 5) - 0.5) * 22;
            els.push(
              <g key={`s${k}-${i}`} transform={`translate(${tx.toFixed(1)} ${ty.toFixed(1)})`}>
                <path d="M-4 0 L-2 -12 L0 -3 L2 -14 L4 0Z" className="io-fx-splash" style={P(t + 260)} />
                <ellipse rx={9} ry={3.5} className="io-fx-splash-ring" style={P(t + 260)} />
              </g>,
            );
          }
        }
        // Sunk ships go down at the end of the exchange.
        for (let i = 0; i < Math.min(b.sunk, b.xs.length, 3); i++) {
          const x = b.xs[b.xs.length - 1 - i];
          els.push(
            <g key={`k${k}-${i}`} transform={`translate(${x} ${ay + 8})`}>
              <g className="io-fx-sink" style={P(900 + i * 120)}>
                <path d={SHIP_PATH} fill={b.color} stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" />
              </g>
              <circle r={5} cx={-3} cy={-4} className="io-fx-muzzle" style={P(900 + i * 120)} />
              <ellipse rx={15} ry={4.5} cy={7} className="io-fx-splash-ring" style={P(1200 + i * 120)} />
              <Puff x={2} y={-6} delay={950 + i * 120} r={6} cls="io-fx-smoke" drift={[4, -20]} />
              <Puff x={-4} y={-4} delay={1100 + i * 120} r={5} cls="io-fx-smoke" drift={[-3, -18]} />
            </g>,
          );
        }
      });
      return <g>{els}</g>;
    }
    case 'strike': {
      const [x, y] = at(burst.region);
      const d = `M${x - 190},${y - 120} Q${x - 40},${y - 50} ${x},${y} T${x + 170},${y + 40}`;
      // The shadow runs on the ground, offset as if the sun were high in the north-west.
      const sd = `M${x - 160},${y - 60} Q${x - 20},${y - 10} ${x + 22},${y + 26} T${x + 190},${y + 70}`;
      return (
        <g>
          <Traveller d={sd} dur={900} vanish>
            <g transform="rotate(118) translate(-9 -9) scale(0.75)">
              <path d="M12 2l1.6 6.2 8 4v2.2l-8-2-.8 5 3 2v2L12 20.5l-3.8.9v-2l3-2-.8-5-8 2v-2.2l8-4z" className="io-fx-jet-shadow" />
            </g>
          </Traveller>
          <Blast id={id} x={x} y={y} size={0.55} delay={400} debris={7} />
          <Traveller d={d} dur={900} vanish>
            <g transform="rotate(118) translate(-14 -14) scale(1.15)" className="io-jet">
              <path d="M12 2l1.6 6.2 8 4v2.2l-8-2-.8 5 3 2v2L12 20.5l-3.8.9v-2l3-2-.8-5-8 2v-2.2l8-4z" style={{ fill: '#fff', stroke: burst.color }} />
            </g>
          </Traveller>
        </g>
      );
    }
    case 'march': {
      const n = burst.routes.length;
      const puffs = n <= 4 ? 4 : n <= 8 ? 2 : 1;
      const els: React.ReactNode[] = [];
      burst.routes.slice(0, 16).forEach((r, k) => {
        const a = at(r.from), b = at(r.to);
        if (!a || !b) return;
        const route = marchRoute(a, b, r.via);
        for (let i = 0; i < puffs; i++) {
          const tau = (i + 1) / (puffs + 1);
          const [px, py] = route.atDistance(eased(tau));
          els.push(<Puff key={`d${k}-${i}`} x={px + (rand(id, k * 9 + i) - 0.5) * 6} y={py + 4} delay={tau * MARCH_MS} r={r.via ? 5 : 6} cls={r.via ? 'io-fx-wake' : 'io-fx-dust'} drift={[(rand(id, k + i) - 0.5) * 8, -5]} />);
        }
        // The thump on arrival: a ring in the column's colour and two puffs.
        if (k < 10) {
          const [ex, ey] = route.end;
          els.push(
            <g key={`t${k}`} transform={`translate(${ex.toFixed(1)} ${ey.toFixed(1)})`}>
              <circle r={16} className="io-fx-thump" stroke={r.color} style={P(MARCH_MS - 30)} />
            </g>,
            <Puff key={`p${k}a`} x={ex - 9} y={ey + 6} delay={MARCH_MS - 20} r={5} drift={[-8, -3]} />,
            <Puff key={`p${k}b`} x={ex + 9} y={ey + 6} delay={MARCH_MS - 20} r={5} drift={[8, -3]} />,
          );
        }
      });
      return <g>{els}</g>;
    }
    case 'sparks': {
      const [a, b] = burst.between.map(at);
      const x = (a[0] + b[0]) / 2, y = (a[1] + b[1]) / 2;
      return (
        <g transform={`translate(${x} ${y})`}>
          <circle r={16} className="io-fx-flash" style={P(220)} />
          {Array.from({ length: 8 }, (_, i) => {
            const ang = (i / 8) * 360 + rand(id, i) * 30;
            return (
              <g key={i} transform={`rotate(${ang.toFixed(0)})`}>
                <line x1={0} y1={0} x2={9} y2={0} className="io-fx-spark" style={P(230 + rand(id, i + 4) * 120, { dx: 16 + rand(id, i + 2) * 14 })} />
              </g>
            );
          })}
        </g>
      );
    }
    case 'impact': {
      const [x, y] = at(burst.region);
      return <Blast id={id} x={x} y={y} size={burst.size} delay={0} debris={burst.size > 0.35 ? Math.round(4 + burst.size * 4) : 0} />;
    }
    case 'capture': {
      const [x, y] = at(burst.region);
      return (
        <g transform={`translate(${x} ${y})`}>
          <circle r={24} className="io-ripple" stroke={burst.color} />
          {Array.from({ length: 8 }, (_, i) => {
            const ang = (i / 8) * Math.PI * 2 + 0.3;
            return <rect key={i} x={-2.5} y={-1.5} width={5} height={3} className="io-fx-confetti" fill={i % 2 ? '#fff' : burst.color} style={P(120 + (i % 3) * 40, { dx: Math.cos(ang) * (30 + (i % 3) * 8), dy: Math.sin(ang) * 26 - 16, rot: `${i * 70}deg` })} />;
          })}
          <g className="io-fx-flag" style={P(60)}>
            <line x1={0} y1={-14} x2={0} y2={-44} className="io-fx-pole" />
            <path d="M0 -44 L20 -39 L0 -33Z" fill={burst.color} stroke="#fff" strokeWidth={1.5} strokeLinejoin="round" className="io-fx-cloth" />
          </g>
        </g>
      );
    }
    case 'stars':
      return (
        <g>
          {burst.from.slice(0, 12).map((s, i) => {
            const [x, y] = at(s.region);
            return (
              <g key={i} transform={`translate(${x} ${y - 20})`}>
                <path d={STAR_PATH} fill={s.color} className="io-fx-star" style={P(i * 70)} />
              </g>
            );
          })}
        </g>
      );
    case 'wipe':
      return (
        <g>
          {burst.regions.slice(0, 4).map((r, i) => {
            const [x, y] = at(r);
            return (
              <g key={r}>
                <g transform={`translate(${x} ${y})`}>
                  <circle r={22} className="io-fx-wipe-ring" stroke={burst.color} style={P(i * 90)} />
                </g>
                <Puff x={x - 6} y={y - 4} delay={i * 90 + 60} r={8} cls="io-fx-smoke" drift={[-6, -22]} />
                <Puff x={x + 7} y={y - 2} delay={i * 90 + 160} r={7} cls="io-fx-smoke" drift={[6, -26]} />
              </g>
            );
          })}
        </g>
      );
    case 'launch': {
      const [x, y] = SEA_ZONES[burst.zone].anchor;
      return (
        <g transform={`translate(${x} ${y + 8})`}>
          <ellipse rx={30} ry={11} className="io-fx-launch" stroke={burst.color} style={P(0)} />
          <ellipse rx={30} ry={11} className="io-fx-launch" stroke={burst.color} style={P(260)} />
        </g>
      );
    }
  }
}

export function Effects({ fx, focus, focusPoint, at }: { fx: Fx[]; focus: Focus | null; focusPoint: [number, number] | null; at: (id: string) => [number, number] }) {
  const still = prefersReducedMotion();
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

      {/* Effects. */}
      <g pointerEvents="none">
        {fx.map((f) => {
          const pf = f as PlayFx;
          if (pf.burst) {
            if (still) return null;
            return (
              <g key={f.id} className="io-fx" style={{ ['--sp' as string]: pf.speed ?? 1 }}>
                <BurstView f={pf} burst={pf.burst} at={at} />
              </g>
            );
          }
          const p = at(f.region);
          if (!p) return null;
          const [x, y] = p;
          if (f.kind === 'jet') {
            if (still) return null;
            const d = `M${x - 190},${y - 120} Q${x - 40},${y - 50} ${x},${y} T${x + 170},${y + 40}`;
            return (
              <Traveller key={f.id} d={d} dur={900}>
                <g className="io-jet">
                  <path d="M12 2l1.6 6.2 8 4v2.2l-8-2-.8 5 3 2v2L12 20.5l-3.8.9v-2l3-2-.8-5-8 2v-2.2l8-4z" transform="rotate(118) translate(-12 -12)" />
                </g>
              </Traveller>
            );
          }
          if (f.kind === 'alert') return <circle key={f.id} cx={x} cy={y} r={28} className="io-alert-ring" />;
          if (f.kind === 'ripple')
            return (
              <g key={f.id}>
                <circle cx={x} cy={y} r={24} className="io-ripple" stroke={f.color} />
                <circle cx={x} cy={y} r={24} className="io-ripple io-ripple-2" stroke={f.color} />
              </g>
            );
          return (
            <g key={f.id} transform={`translate(${x} ${y})`}>
              <circle r={8} className="io-blast" />
              <circle r={8} className="io-blast-ring" />
            </g>
          );
        })}
      </g>
    </>
  );
}

/** Four short ticks on a ring of radius r, like a gunsight. */
function reticle(r: number) {
  const a = r - 7, b = r + 7;
  return `M0 ${-b}V${-a}M0 ${a}V${b}M${-b} 0H${-a}M${a} 0H${b}`;
}
