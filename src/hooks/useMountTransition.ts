import { useEffect, useRef, useState } from 'react';

/**
 * Part 2 §3 — smooth panel transitions. A small, dependency-free mount/unmount
 * transition helper: keeps a conditionally-shown panel (unit-detail, battle
 * report, …) actually mounted for `exitMs` after its logical `active` flag
 * goes false, so a CSS class can animate it out instead of the DOM node just
 * vanishing. This is presentation-only — it never delays anything
 * gameplay-relevant (arming an order, seeing a move/attack preview, keyboard
 * shortcuts) because none of those go through this hook; it only wraps the
 * few panels that currently pop in/out instantly.
 *
 * Usage: `const { mounted, phase } = useMountTransition(active, 160)`, then
 * `mounted && <div className={`panel-anim panel-anim-${phase}`}>...`.
 * `phase` is 'enter' for one frame (so the browser has a pre-transition state
 * to animate FROM), then 'entered', then 'exit' once `active` goes false.
 */
export function useMountTransition(active: boolean, exitMs = 160) {
  const [mounted, setMounted] = useState(active);
  const [phase, setPhase] = useState<'enter' | 'entered' | 'exit'>(active ? 'entered' : 'exit');
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (active) {
      setMounted(true);
      setPhase('enter');
      // Flip to 'entered' on the next frame so the initial 'enter' class
      // (the pre-transition state) actually gets painted first.
      const raf = requestAnimationFrame(() => setPhase('entered'));
      return () => cancelAnimationFrame(raf);
    }
    if (mounted) {
      setPhase('exit');
      timerRef.current = window.setTimeout(() => {
        setMounted(false);
        timerRef.current = null;
      }, exitMs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  return { mounted, phase };
}
