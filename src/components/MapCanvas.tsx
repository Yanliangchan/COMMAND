import React, { useEffect, useRef, useState, useCallback } from 'react';
import { computeReachable, distance, formationAt, supplySources, SUPPLY_RADIUS } from '../game/engine';
import { FORMATION_DEFS } from '../game/data';
import { Formation, GameState, GRID_SIZE, PlayerId } from '../game/types';
import { Camera, Overlays, render, screenToTile } from '../render/renderMap';

interface Props {
  state: GameState;
  viewer: PlayerId;
  selected: Formation | null;
  overlays: Overlays;
  targetMode: string | null;
  onTileClick: (x: number, y: number) => void;
  onFormationClick: (f: Formation) => void;
  camera: Camera;
  setCamera: React.Dispatch<React.SetStateAction<Camera>>;
}

/** Mirrors engine.isInSupplyRange so the overlay shows exactly what the rules use. */
function computeSupplySet(state: GameState, viewer: PlayerId): Set<string> {
  const set = new Set<string>();
  const sources = supplySources(state, viewer);
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      for (const src of sources) {
        if (distance(x, y, src.x, src.y) <= SUPPLY_RADIUS) {
          set.add(`${x},${y}`);
          break;
        }
      }
    }
  }
  return set;
}

export const MapCanvas: React.FC<Props> = ({ state, viewer, selected, overlays, targetMode, onTileClick, onFormationClick, camera, setCamera }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [hoverTile, setHoverTile] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ dragging: boolean; lastX: number; lastY: number; moved: boolean }>({ dragging: false, lastX: 0, lastY: 0, moved: false });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const reachable = selected ? computeReachable(state, selected.id) : new Map<string, number>();
  const attackable = new Set<string>();
  if (selected) {
    const def = FORMATION_DEFS[selected.type];
    const range = def.attackRange;
    Object.values(state.formations).forEach((f) => {
      if (f.owner !== selected.owner && distance(selected.x, selected.y, f.x, f.y) <= range) {
        attackable.add(f.id);
      }
    });
  }
  const supplySet = overlays.supply ? computeSupplySet(state, viewer) : new Set<string>();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    canvas.style.width = `${size.w}px`;
    canvas.style.height = `${size.h}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render({
      ctx,
      width: size.w,
      height: size.h,
      camera,
      state,
      viewer,
      selected,
      reachable,
      attackable,
      overlays,
      supplySet,
      hoverTile,
    });
  });

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      setCamera((c) => {
        const factor = e.deltaY > 0 ? 0.88 : 1.14;
        const scale = Math.max(3.5, Math.min(28, c.scale * factor));
        return { ...c, scale };
      });
    },
    [setCamera]
  );

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY, moved: false };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const t = screenToTile(camera, size.w, size.h, e.clientX - rect.left, e.clientY - rect.top);
      setHoverTile(t);
    }
    if (dragRef.current.dragging) {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      setCamera((c) => ({ ...c, x: c.x - dx / c.scale, y: c.y - dy / c.scale }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const wasDrag = dragRef.current.moved;
    dragRef.current.dragging = false;
    if (wasDrag) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const t = screenToTile(camera, size.w, size.h, e.clientX - rect.left, e.clientY - rect.top);
    if (t.x < 0 || t.y < 0 || t.x >= GRID_SIZE || t.y >= GRID_SIZE) return;
    const f = formationAt(state, t.x, t.y);
    if (f && !targetMode) {
      onFormationClick(f);
    } else {
      onTileClick(t.x, t.y);
    }
  };

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden', cursor: targetMode ? 'crosshair' : 'grab' }}>
      <canvas
        ref={canvasRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverTile(null)}
      />
    </div>
  );
};
