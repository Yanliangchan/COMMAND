import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { computeReachable, distance, formationAt } from '../game/engine';
import { FORMATION_DEFS } from '../game/data';
import { Formation, GameState, GRID_SIZE, PlayerId } from '../game/types';
import { Camera, ContactPing, MapLabel, Overlays, render, screenToTile } from '../render/renderMap';

interface Props {
  state: GameState;
  viewer: PlayerId;
  selected: Formation | null;
  overlays: Overlays;
  targetMode: string | null;
  onTileClick: (x: number, y: number) => void;
  onFormationClick: (f: Formation, mods: { shift: boolean }) => void;
  camera: Camera;
  setCamera: React.Dispatch<React.SetStateAction<Camera>>;
  flashTiles?: { x: number; y: number }[];
  /** Ids in the current Move Formation group — drawn with a group bracket. */
  groupIds?: string[];
  /** Tiles of the previewed path to the hovered tile. */
  pathPreview?: { x: number; y: number }[];
  /** True when the previewed destination is refused, so the path draws in red. */
  pathInvalid?: boolean;
  onHoverTile?: (t: { x: number; y: number } | null) => void;
  /** Transient "new contact" pings raised by passive spotting. */
  pings?: ContactPing[];
  /** Reports the smoothed frame time of the render loop, for the perf readout. */
  onFrameTime?: (ms: number) => void;
}

/**
 * Settlement names for the sheet. The generator names each settlement and drops
 * an "<name> District" urban objective on its centre, so the label set can be
 * derived client-side without widening the wire state.
 */
function settlementLabels(state: GameState): MapLabel[] {
  return state.objectives
    .filter((o) => o.kind === 'Urban District')
    .map((o) => ({ x: o.x, y: o.y, name: o.name.replace(/ District$/, '') }));
}

export const MapCanvas: React.FC<Props> = ({
  state,
  viewer,
  selected,
  overlays,
  targetMode,
  onTileClick,
  onFormationClick,
  camera,
  setCamera,
  flashTiles,
  groupIds,
  pathPreview,
  pathInvalid,
  onHoverTile,
  onFrameTime,
  pings,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0, moved: false });
  // The camera actually being drawn — eased toward the `camera` prop each frame
  // so recentres, zooms and pans glide instead of snapping.
  const viewRef = useRef<Camera>({ ...camera });
  // Zooming out past "the whole sheet fits" only shrinks the board inside a sea
  // of empty chrome, so the floor is the fit-to-viewport scale, not a constant.
  const minScaleRef = useRef(3.5);
  const propsRef = useRef<any>({});
  const frameAvgRef = useRef(0);

  const labels = useMemo(() => settlementLabels(state), [state.objectives]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const reachable = useMemo(
    () => (selected ? computeReachable(state, selected.id) : new Map<string, number>()),
    [state, selected?.id, selected?.x, selected?.y, selected?.movesUsed]
  );

  const attackable = useMemo(() => {
    const set = new Set<string>();
    if (!selected) return set;
    const range = FORMATION_DEFS[selected.type].attackRange;
    Object.values(state.formations).forEach((f) => {
      if (f.owner !== selected.owner && distance(selected.x, selected.y, f.x, f.y) <= range) set.add(f.id);
    });
    return set;
  }, [state.formations, selected?.id, selected?.x, selected?.y]);

  propsRef.current = { state, viewer, selected, reachable, attackable, overlays, labels, flashTiles, size, camera, groupIds, pathPreview, pathInvalid, pings };

  // ---- Animation / render loop -------------------------------------------
  useEffect(() => {
    let raf = 0;
    let mounted = true;
    const loop = (t: number) => {
      if (!mounted) return;
      raf = requestAnimationFrame(loop);
      const p = propsRef.current;
      const canvas = canvasRef.current;
      if (!canvas || !p.size.w) return;
      minScaleRef.current = Math.max(3.5, (Math.min(p.size.w, p.size.h) / GRID_SIZE) * 0.92);
      if (p.camera.scale < minScaleRef.current - 0.01) {
        const m = minScaleRef.current;
        setCamera((c) => ({ ...c, scale: Math.max(c.scale, m) }));
      }

      // Ease the drawn camera toward the requested one.
      const view = viewRef.current;
      const target = p.camera as Camera;
      const k = 0.28;
      const dx = target.x - view.x;
      const dy = target.y - view.y;
      const ds = target.scale - view.scale;
      const moving = Math.abs(dx) > 0.002 || Math.abs(dy) > 0.002 || Math.abs(ds) > 0.002;
      view.x += dx * k;
      view.y += dy * k;
      view.scale += ds * k;
      if (!moving) {
        view.x = target.x;
        view.y = target.y;
        view.scale = target.scale;
      }

      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = Math.round(p.size.w * dpr);
      const ch = Math.round(p.size.h * dpr);
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
        canvas.style.width = `${p.size.w}px`;
        canvas.style.height = `${p.size.h}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t0 = performance.now();
      render({
        ctx,
        width: p.size.w,
        height: p.size.h,
        camera: view,
        state: p.state,
        viewer: p.viewer,
        selected: p.selected,
        reachable: p.reachable,
        attackable: p.attackable,
        overlays: p.overlays,
        hoverTile: hoverRef.current,
        labels: p.labels,
        flashTiles: p.flashTiles,
        groupIds: p.groupIds,
        pathPreview: p.pathPreview,
        pathInvalid: p.pathInvalid,
        pings: p.pings,
        pulse: (t % 1800) / 1800,
      });
      const dt = performance.now() - t0;
      frameAvgRef.current = frameAvgRef.current ? frameAvgRef.current * 0.9 + dt * 0.1 : dt;
      (window as any).__COMMAND_FRAME_MS__ = frameAvgRef.current;
      (window as any).__COMMAND_CAMERA__ = { ...view };
      if (onFrameTime && Math.random() < 0.03) onFrameTime(frameAvgRef.current);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      mounted = false;
      cancelAnimationFrame(raf);
    };
  }, [onFrameTime]);

  // ---- Input --------------------------------------------------------------
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = containerRef.current?.getBoundingClientRect();
      const view = viewRef.current;
      setCamera((c) => {
        const factor = Math.pow(0.9987, e.deltaY);
        const scale = Math.max(minScaleRef.current, Math.min(38, c.scale * factor));
        if (!rect) return { ...c, scale };
        // Zoom about the cursor: keep the world point under the pointer fixed.
        const px = e.clientX - rect.left - rect.width / 2;
        const py = e.clientY - rect.top - rect.height / 2;
        const wx = view.x + px / view.scale;
        const wy = view.y + py / view.scale;
        return { x: wx - px / scale, y: wy - py / scale, scale };
      });
    },
    [setCamera]
  );

  useEffect(() => {
    // React attaches wheel listeners passively; a non-passive native listener is
    // required to stop the page from scrolling while zooming the sheet.
    const el = canvasRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => e.preventDefault();
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY, moved: false };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const t = screenToTile(viewRef.current, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);
      const inside = t.x >= 0 && t.y >= 0 && t.x < GRID_SIZE && t.y < GRID_SIZE;
      hoverRef.current = inside ? t : null;
      onHoverTile?.(inside ? t : null);
    }
    if (dragRef.current.dragging) {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) dragRef.current.moved = true;
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      const view = viewRef.current;
      // Pan the eased view directly as well, so dragging tracks the cursor 1:1.
      view.x -= dx / view.scale;
      view.y -= dy / view.scale;
      setCamera((c) => ({ ...c, x: c.x - dx / c.scale, y: c.y - dy / c.scale }));
    }
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const wasDrag = dragRef.current.moved;
    dragRef.current.dragging = false;
    if (wasDrag) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const t = screenToTile(viewRef.current, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);
    if (t.x < 0 || t.y < 0 || t.x >= GRID_SIZE || t.y >= GRID_SIZE) return;
    const f = formationAt(state, t.x, t.y);
    // Shift-click always means "add/remove from the Move Formation group",
    // even while a targeting mode is armed.
    if (f && (e.shiftKey || !targetMode)) onFormationClick(f, { shift: e.shiftKey });
    else onTileClick(t.x, t.y);
  };

  return (
    <div
      ref={containerRef}
      className="map-surface"
      style={{ cursor: targetMode ? 'crosshair' : dragRef.current.dragging ? 'grabbing' : 'grab' }}
    >
      <canvas
        ref={canvasRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          hoverRef.current = null;
          onHoverTile?.(null);
        }}
      />
    </div>
  );
};
