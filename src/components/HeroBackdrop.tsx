import React, { useEffect, useRef, useState } from 'react';

import { initGame } from '../game/engine';
import { GRID_SIZE } from '../game/types';
import { render } from '../render/renderMap';

/**
 * The front page's hero visual: a REAL generated battlefield, rendered once by
 * the game's own renderer and then left alone.
 *
 * Deliberately cheap, because a menu must never feel heavy:
 *   - the map is generated and drawn exactly ONCE, off the first paint;
 *   - there is no game loop and no per-frame JS — the slow drift is a CSS
 *     transform animation on the canvas element, so the compositor owns it;
 *   - the device-pixel ratio is capped at 1.25 and the whole thing is skipped
 *     on obviously low-powered devices;
 *   - anything that throws (or a browser with no 2D context) simply leaves the
 *     CSS gradient underneath showing. The page is designed to look finished
 *     without it.
 */

/** A handful of seeds that generate a good-looking coastline + river system. */
const HERO_SEEDS = [20260902, 811731, 4242, 99137, 570021];

function lowPowerDevice() {
  const cores = (navigator as any).hardwareConcurrency;
  if (typeof cores === 'number' && cores > 0 && cores <= 2) return true;
  const mem = (navigator as any).deviceMemory;
  if (typeof mem === 'number' && mem > 0 && mem < 2) return true;
  return false;
}

export const HeroBackdrop: React.FC = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [drift, setDrift] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (lowPowerDevice()) return;

    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    const paint = () => {
      if (cancelled) return;
      try {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // The canvas is over-sized relative to the viewport so the drift never
        // exposes an edge.
        const w = Math.min(2200, Math.round(window.innerWidth * 1.2));
        const h = Math.min(1500, Math.round(window.innerHeight * 1.2));
        const dpr = Math.min(1.25, window.devicePixelRatio || 1);
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const seed = HERO_SEEDS[Math.floor(Math.random() * HERO_SEEDS.length)];
        const state = initGame(seed);
        // Strategic zoom, framed on the inhabited north-west shoulder of the
        // sheet where the settlements, roads and river mouths are.
        const scale = Math.max(w, h) / GRID_SIZE / 1.35;
        render({
          ctx,
          width: w,
          height: h,
          camera: { x: GRID_SIZE * 0.44, y: GRID_SIZE * 0.46, scale },
          state,
          viewer: 'SABRE',
          selected: null,
          reachable: new Map(),
          attackable: new Set(),
          overlays: { movement: false, intel: true, objectives: true },
          hoverTile: null,
          labels: state.objectives
            .filter((o) => o.kind === 'Urban District')
            .map((o) => ({ x: o.x, y: o.y, name: o.name.replace(/ District$/, '') })),
          pulse: 0.25,
        });
        if (cancelled) return;
        setReady(true);
        setDrift(!reduce);
      } catch {
        // Fall back to the gradient. Nothing else to do, nothing to report.
      }
    };

    // Off the first paint: the menu must appear instantly.
    const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void, o?: any) => number);
    const handle = ric ? ric(paint, { timeout: 900 }) : window.setTimeout(paint, 90);
    return () => {
      cancelled = true;
      if (ric && (window as any).cancelIdleCallback) (window as any).cancelIdleCallback(handle);
      else window.clearTimeout(handle as number);
    };
  }, []);

  return (
    <div className="hero" aria-hidden>
      <div className="hero-fallback" />
      <canvas ref={canvasRef} className={`hero-canvas${ready ? ' is-ready' : ''}${drift ? ' is-drifting' : ''}`} />
      <div className="hero-scrim" />
      <div className="hero-vignette" />
    </div>
  );
};
