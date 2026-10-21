// ============================================================================
// The board's effects layer: what playback is looking at (focus ring, clash
// mark) and the one-shot effects — blasts, capture ripples, loss alerts and
// strike jets. Drawn in board coordinates, above the badges.
// ============================================================================

import { useEffect, useRef } from 'react';
import type { Focus, Fx } from './MapView';
import './effects.css';

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function Effects({ fx, focus, focusPoint, at }: { fx: Fx[]; focus: Focus | null; focusPoint: [number, number] | null; at: (id: string) => [number, number] }) {
  return (
    <>
      {/* What playback is looking at. */}
      {focusPoint && (
        <g transform={`translate(${focusPoint[0]} ${focusPoint[1]})`} pointerEvents="none" className="io-focus">
          <circle r={focus?.zone ? 46 : 30} />
        </g>
      )}
      {focus?.between && (
        <g pointerEvents="none" className="io-clash-mark" transform={`translate(${(at(focus.between[0])[0] + at(focus.between[1])[0]) / 2} ${(at(focus.between[0])[1] + at(focus.between[1])[1]) / 2})`}>
          <path d="M-9 -9 L9 9 M9 -9 L-9 9" />
        </g>
      )}

      {/* Effects. */}
      <g pointerEvents="none">
        {fx.map((f) => {
          const [x, y] = at(f.region);
          if (f.kind === 'jet') {
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

/**
 * A token that runs along an SVG path once, from when it mounts. SMIL's
 * default begin is the document's start, long past by now — so start it by hand.
 * With reduced motion the token simply appears at the end of its route.
 */
export function Traveller({ d, dur, children }: { d: string; dur: number; children: React.ReactNode }) {
  const ref = useRef<SVGAnimateMotionElement>(null);
  const still = prefersReducedMotion();
  useEffect(() => {
    if (still) return;
    try {
      ref.current?.beginElement();
    } catch {
      // No SMIL support: the token just sits at the start of the route.
    }
  }, [d, still]);
  return (
    <g>
      {children}
      <animateMotion
        ref={ref}
        dur={`${still ? 1 : dur}ms`}
        begin={still ? '0s' : 'indefinite'}
        fill="freeze"
        path={d}
        keyPoints={still ? '1;1' : undefined}
        keyTimes="0;1"
        calcMode={still ? 'linear' : 'spline'}
        keySplines={still ? undefined : '0.4 0 0.2 1'}
      />
    </g>
  );
}

