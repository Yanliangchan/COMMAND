import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { computeReachable, distance, formationAt } from '../game/engine';
import { FORMATION_DEFS } from '../game/data';
import { zocTilesFor } from '../game/movement';
import { Formation, GameState, GRID_SIZE, PlayerId } from '../game/types';
import {
  Camera,
  CombatEffect,
  ContactPing,
  EventFlash,
  KillMarker,
  MapLabel,
  ObjectiveFlash,
  Overlays,
  render,
  screenToTile,
} from '../render/renderMap';

/** Total on-screen duration of the movement glide (phase 12 §4) — short and
 *  flat regardless of path length, so a long move never makes the player
 *  wait on the animation. */
const MOVE_ANIM_MS = 260;

interface AnimEntry {
  /** Waypoints in tile space, from -> ... -> to. At least 2 points. */
  points: { x: number; y: number }[];
  /** Cumulative distance to each waypoint, same length as points. */
  cum: number[];
  total: number;
  start: number;
  duration: number;
}

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
  /** Transient "destroyed here" wreck markers. */
  kills?: KillMarker[];
  /** Reports the smoothed frame time of the render loop, for the perf readout. */
  onFrameTime?: (ms: number) => void;
  /**
   * Real per-formation paths captured at the moment a Move/Withdraw was
   * issued (from the same pure planMove/planWithdraw the preview uses),
   * keyed by formationId — consumed (and cleared) the instant that
   * formation's authoritative position actually changes, so a stale hint
   * can never attach to some LATER, unrelated move. Absent for opponent and
   * bot moves (the client never sees their path, only before/after
   * position), which fall back to a straight-line glide — see MapCanvas's
   * animation effect.
   */
  moveHints?: React.MutableRefObject<Map<string, { x: number; y: number }[]>>;
  /** Transient on-map combat effects (phase 12 §5). */
  combatEffects?: CombatEffect[];
  /** Transient objective-capture flashes (phase 12 §6). */
  objectiveFlashes?: ObjectiveFlash[];
  /** Transient event-location highlight flashes (phase 12 §11). */
  eventFlashes?: EventFlash[];
}

function tileDist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function pointAtFraction(entry: AnimEntry, frac: number): { x: number; y: number } {
  const last = entry.points[entry.points.length - 1];
  if (entry.total <= 0) return last;
  const target = entry.total * Math.max(0, Math.min(1, frac));
  for (let i = 1; i < entry.points.length; i++) {
    if (target <= entry.cum[i] || i === entry.points.length - 1) {
      const segLen = entry.cum[i] - entry.cum[i - 1];
      const segT = segLen > 0 ? (target - entry.cum[i - 1]) / segLen : 1;
      const a = entry.points[i - 1];
      const b = entry.points[i];
      return { x: a.x + (b.x - a.x) * segT, y: a.y + (b.y - a.y) * segT };
    }
  }
  return last;
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
  kills,
  moveHints,
  combatEffects,
  objectiveFlashes,
  eventFlashes,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const dragRef = useRef({ dragging: false, lastX: 0, lastY: 0, moved: false });
  // ---- Touch input (Part 2 §1) ---------------------------------------------
  // Pointer Events already unify mouse/touch/pen for plain pan (drag) and
  // tap-to-select/confirm (a short pointerdown/up with little movement falls
  // straight through the existing onPointerUp handler below, same as a mouse
  // click) — nothing extra was needed for those two. Two things genuinely
  // have no touch equivalent and need new handling: (1) hover-driven preview
  // (movement/attack-odds), which normally only ever gets a mouse's
  // pointermove-without-a-button-down; a touch pointermove only fires while a
  // finger is actually down, so we synthesize "hover" from a tap-and-HOLD —
  // hold past a short delay without moving sets hoverRef the same way a mouse
  // hover would, driving the exact same preview computation in App.tsx via
  // onHoverTile; and (2) pinch-to-zoom, which the wheel event never receives
  // from a touchscreen at all, so it is implemented from scratch by tracking
  // two simultaneous pointers and reading the change in distance between them
  // frame to frame, mirroring onWheel's "zoom about a fixed point" math (here
  // the pinch midpoint stands in for the cursor).
  const activeTouchesRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ startDist: number; startScale: number } | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdFiredRef = useRef(false);
  const HOLD_MS = 380;
  const clearHoldTimer = () => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  };
  // ---- Animated movement (phase 12 §4) -------------------------------------
  // Client-side rendering ONLY: the server has already resolved every action
  // instantly and authoritatively by the time `state` reaches here. This ref
  // tracks, per formation, a short glide from wherever it last visually was
  // to its current true position — recomputed from scratch every time the
  // authoritative position changes, so a further action arriving mid-glide
  // restarts smoothly from the current on-screen point rather than snapping
  // backward or drifting out of sync.
  const prevStateRef = useRef<GameState | null>(null);
  const animRef = useRef<Map<string, AnimEntry>>(new Map());
  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = state;
    if (!prev) return; // first push this session/game — nothing to glide from
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    Object.values(state.formations).forEach((f) => {
      const before = prev.formations[f.id];
      if (!before) return; // newly appeared to this viewer — draw in place, don't glide from nowhere
      if (before.x === f.x && before.y === f.y) return; // did not move
      const existing = animRef.current.get(f.id);
      let fromPoint = { x: before.x, y: before.y };
      if (existing) {
        const elapsed = now - existing.start;
        fromPoint = pointAtFraction(existing, elapsed / existing.duration);
      }
      const hintPath = moveHints?.current.get(f.id);
      moveHints?.current.delete(f.id);
      const to = { x: f.x, y: f.y };
      let points: { x: number; y: number }[];
      if (hintPath?.length && hintPath[hintPath.length - 1].x === to.x && hintPath[hintPath.length - 1].y === to.y) {
        points = [fromPoint, ...hintPath];
      } else {
        points = [fromPoint, to];
      }
      const cum = [0];
      for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + tileDist(points[i - 1], points[i]));
      animRef.current.set(f.id, { points, cum, total: cum[cum.length - 1], start: now, duration: MOVE_ANIM_MS });
    });
    // A formation no longer on the board (destroyed, or left this viewer's
    // fog) has nothing left to animate toward — correctness over smoothness.
    animRef.current.forEach((_v, id) => {
      if (!state.formations[id]) animRef.current.delete(id);
    });
  }, [state, moveHints]);
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

  // Zones of Control (phase 7): shown automatically while a move order is
  // armed on a land formation — exactly when the player needs to see them.
  const zocTiles = useMemo(
    () => (selected && (targetMode === 'MOVE' || targetMode === 'MOVE_GROUP') ? zocTilesFor(state, selected) : undefined),
    [state, selected?.id, selected?.x, selected?.y, targetMode]
  );

  propsRef.current = {
    state,
    viewer,
    selected,
    reachable,
    attackable,
    overlays,
    labels,
    flashTiles,
    size,
    camera,
    groupIds,
    pathPreview,
    pathInvalid,
    pings,
    kills,
    zocTiles,
    combatEffects,
    objectiveFlashes,
    eventFlashes,
  };

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

      // Animated-movement positions for THIS frame — cheap (at most a
      // handful of formations mid-glide at once) and cleans up finished
      // entries as it goes, so steady-state cost is exactly zero maps/finds.
      let animPositions: Map<string, { x: number; y: number }> | undefined;
      if (animRef.current.size) {
        animPositions = new Map();
        animRef.current.forEach((entry, id) => {
          const elapsed = t - entry.start;
          if (elapsed >= entry.duration) {
            animRef.current.delete(id);
            return;
          }
          const frac = Math.max(0, Math.min(1, elapsed / entry.duration));
          const eased = 1 - Math.pow(1 - frac, 2);
          animPositions!.set(id, pointAtFraction(entry, eased));
        });
      }

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
        kills: p.kills,
        zocTiles: p.zocTiles,
        animPositions,
        combatEffects: p.combatEffects,
        objectiveFlashes: p.objectiveFlashes,
        eventFlashes: p.eventFlashes,
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

  const pinchDist = () => {
    const pts = Array.from(activeTouchesRef.current.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    try {
      (e.target as Element).setPointerCapture(e.pointerId);
    } catch {
      // A second/third simultaneous touch pointer can lose the race with the
      // browser's own implicit capture bookkeeping — cosmetic only (it just
      // means this particular pointer isn't captured to the canvas), never
      // worth losing the gesture over.
    }
    if (e.pointerType === 'touch') {
      activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (activeTouchesRef.current.size === 2) {
        // A second finger landed — this is a pinch, not a pan or a hold.
        clearHoldTimer();
        dragRef.current.dragging = false;
        pinchRef.current = { startDist: pinchDist(), startScale: viewRef.current.scale };
        return;
      }
    }
    dragRef.current = { dragging: true, lastX: e.clientX, lastY: e.clientY, moved: false };
    if (e.pointerType === 'touch') {
      // Tap-and-hold synthesizes the hover-driven preview a mouse gets for
      // free. If the hold survives without the finger moving or a second
      // finger joining, plant the hover tile — driving the same
      // movement/attack-odds preview computation as desktop hover.
      holdFiredRef.current = false;
      const rect = containerRef.current?.getBoundingClientRect();
      const downX = e.clientX;
      const downY = e.clientY;
      clearHoldTimer();
      holdTimerRef.current = window.setTimeout(() => {
        holdTimerRef.current = null;
        if (!rect || activeTouchesRef.current.size !== 1) return;
        const t = screenToTile(viewRef.current, rect.width, rect.height, downX - rect.left, downY - rect.top);
        const inside = t.x >= 0 && t.y >= 0 && t.x < GRID_SIZE && t.y < GRID_SIZE;
        holdFiredRef.current = true;
        dragRef.current.moved = true; // holding counts as "handled" — don't also fire a tap on release
        hoverRef.current = inside ? t : null;
        onHoverTile?.(inside ? t : null);
      }, HOLD_MS);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && activeTouchesRef.current.has(e.pointerId)) {
      activeTouchesRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }
    if (pinchRef.current && activeTouchesRef.current.size === 2) {
      const dist = pinchDist();
      if (dist > 0 && pinchRef.current.startDist > 0) {
        // Capture the pinch anchor NOW — a pointerup racing this frame's React
        // update could otherwise null pinchRef.current before the setCamera
        // updater callback below actually runs.
        const { startDist, startScale } = pinchRef.current;
        const rect = containerRef.current?.getBoundingClientRect();
        const pts = Array.from(activeTouchesRef.current.values());
        const midX = (pts[0].x + pts[1].x) / 2;
        const midY = (pts[0].y + pts[1].y) / 2;
        const view = viewRef.current;
        setCamera((c) => {
          const scale = Math.max(minScaleRef.current, Math.min(38, startScale * (dist / startDist)));
          if (!rect) return { ...c, scale };
          // Zoom about the pinch midpoint, mirroring onWheel's cursor-anchored zoom.
          const px = midX - rect.left - rect.width / 2;
          const py = midY - rect.top - rect.height / 2;
          const wx = view.x + px / view.scale;
          const wy = view.y + py / view.scale;
          return { x: wx - px / scale, y: wy - py / scale, scale };
        });
      }
      return; // pinch consumes this move — no pan, no hover, no hold
    }
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const t = screenToTile(viewRef.current, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);
      const inside = t.x >= 0 && t.y >= 0 && t.x < GRID_SIZE && t.y < GRID_SIZE;
      // Touch: don't update hover on plain move (no finger-down "hover" exists
      // on touch) — only the hold-timer above plants it. Once held, keep
      // tracking so a slow drag after the hold still updates the preview.
      if (e.pointerType !== 'touch' || holdFiredRef.current) {
        hoverRef.current = inside ? t : null;
        onHoverTile?.(inside ? t : null);
      }
    }
    if (dragRef.current.dragging) {
      const dx = e.clientX - dragRef.current.lastX;
      const dy = e.clientY - dragRef.current.lastY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
        dragRef.current.moved = true;
        if (e.pointerType === 'touch') clearHoldTimer(); // moved before the hold fired — this is a pan, not a hold
      }
      dragRef.current.lastX = e.clientX;
      dragRef.current.lastY = e.clientY;
      // Once a touch hold has planted a preview, further finger movement
      // adjusts the previewed tile rather than panning the camera — panning
      // mid-preview would be surprising and the pinch gesture already covers
      // deliberate camera movement on touch.
      if (e.pointerType === 'touch' && holdFiredRef.current) return;
      const view = viewRef.current;
      // Pan the eased view directly as well, so dragging tracks the cursor 1:1.
      view.x -= dx / view.scale;
      view.y -= dy / view.scale;
      setCamera((c) => ({ ...c, x: c.x - dx / c.scale, y: c.y - dy / c.scale }));
    }
  };
  const endTouch = (e: React.PointerEvent) => {
    activeTouchesRef.current.delete(e.pointerId);
    if (activeTouchesRef.current.size < 2) pinchRef.current = null;
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === 'touch') {
      clearHoldTimer();
      const wasHold = holdFiredRef.current;
      endTouch(e);
      dragRef.current.dragging = false;
      if (wasHold) {
        // The hold already planted the preview (movement path / attack odds).
        // Releasing confirms it — the same tap-to-confirm contract a mouse
        // click has, just arrived at via hold-then-release instead of
        // hover-then-click.
        holdFiredRef.current = false;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const t = screenToTile(viewRef.current, rect.width, rect.height, e.clientX - rect.left, e.clientY - rect.top);
        if (t.x < 0 || t.y < 0 || t.x >= GRID_SIZE || t.y >= GRID_SIZE) return;
        const f = formationAt(state, t.x, t.y);
        if (f && !targetMode) onFormationClick(f, { shift: false });
        else onTileClick(t.x, t.y);
        return;
      }
    }
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
        style={{ touchAction: 'none' }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => {
          clearHoldTimer();
          holdFiredRef.current = false;
          endTouch(e);
          dragRef.current.dragging = false;
        }}
        onPointerLeave={() => {
          hoverRef.current = null;
          onHoverTile?.(null);
        }}
      />
    </div>
  );
};
