import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PLAYER_COLORS, TERRAIN_COLORS } from '../render/colors';
import { GRID_SIZE, gridRef } from '../game/types';
import { ReplayViewState } from '../net/protocol';

/**
 * MATCH REPLAY (phase 9) — a simple scrubber over the compact per-round
 * position snapshots the engine now records (`state.replay`), plus the
 * operations log filtered to that round. Deliberately NOT a reconstruction
 * of the full MapCanvas renderer (relief shading, contours, fog overlays,
 * unit icons) — see README "Match replay" — but the real terrain grid
 * (`state.tiles`) IS drawn, flat-shaded per tile with a light elevation
 * tint, so the ground the battle was fought over is actually visible. One
 * fully-revealed view of the whole match, both task forces at once — the
 * operation is over, so there is no "your side vs their side" to toggle
 * between, only one board with everything on it.
 */
export const Replay: React.FC<{ state: ReplayViewState; onClose: () => void }> = ({ state, onClose }) => {
  const rounds = state.replay;
  const [idx, setIdx] = useState(Math.max(0, rounds.length - 1));
  const [playing, setPlaying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const round = rounds[idx] ?? null;

  useEffect(() => {
    if (!playing) return;
    if (idx >= rounds.length - 1) {
      setPlaying(false);
      return;
    }
    const t = window.setTimeout(() => setIdx((i) => Math.min(rounds.length - 1, i + 1)), 900);
    return () => window.clearTimeout(t);
  }, [playing, idx, rounds.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        e.stopPropagation();
        setIdx((i) => Math.min(rounds.length - 1, i + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        setIdx((i) => Math.max(0, i - 1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, rounds.length]);

  const roundLog = useMemo(
    () => (round ? state.log.filter((l) => l.round === round.round).slice(0, 40) : []),
    [state.log, round]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !round) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const cell = w / GRID_SIZE;

    // Real terrain: a flat fill per tile, blended toward the terrain's own
    // "dark" shade as elevation rises (0..5 bands) for a cheap sense of
    // relief without a full contour/hillshade pass — this is a scrubber
    // canvas, not the live battlefield renderer.
    if (state.tiles && state.tiles.length) {
      for (let y = 0; y < GRID_SIZE; y++) {
        const row = state.tiles[y];
        if (!row) continue;
        for (let x = 0; x < GRID_SIZE; x++) {
          const tile = row[x];
          if (!tile) continue;
          const palette = TERRAIN_COLORS[tile.terrain];
          ctx.fillStyle = tile.elevation >= 4 ? palette.dark : tile.elevation >= 2 ? palette.base : palette.light;
          ctx.fillRect(Math.floor(x * cell), Math.floor(y * cell), Math.ceil(cell), Math.ceil(cell));
        }
      }
    } else {
      // Fallback for any replay saved before terrain was included on the wire.
      ctx.fillStyle = '#1a2119';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    for (let i = 0; i <= GRID_SIZE; i += 8) {
      ctx.beginPath();
      ctx.moveTo(i * cell, 0);
      ctx.lineTo(i * cell, h);
      ctx.moveTo(0, i * cell);
      ctx.lineTo(w, i * cell);
      ctx.stroke();
    }
    // Objectives, current control only (the replay does not track historical
    // control changes — a deliberate simplification, see README).
    state.objectives.forEach((o) => {
      ctx.fillStyle = 'rgba(207,154,68,0.75)';
      ctx.beginPath();
      ctx.arc((o.x + 0.5) * cell, (o.y + 0.5) * cell, Math.max(2, cell * 0.4), 0, Math.PI * 2);
      ctx.fill();
    });
    // Movement breadcrumbs (phase 12 §9) — a thin fading trail from where
    // each formation started THE ROUND BEING VIEWED (the previous round's
    // snapshot) to where it ended up (this round's snapshot). Subtle by
    // design: a dim dashed line, never competing with the terrain or the
    // counters themselves.
    if (idx > 0) {
      const prevRound = rounds[idx - 1];
      const prevById = new Map(prevRound.entries.map((e) => [e.id, e]));
      ctx.save();
      ctx.setLineDash([Math.max(2, cell * 0.3), Math.max(2, cell * 0.25)]);
      round.entries.forEach((e) => {
        const before = prevById.get(e.id);
        if (!before || (before.x === e.x && before.y === e.y)) return;
        const color = PLAYER_COLORS[e.owner]?.main ?? '#ccc';
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.4;
        ctx.lineWidth = Math.max(1, cell * 0.08);
        ctx.beginPath();
        ctx.moveTo((before.x + 0.5) * cell, (before.y + 0.5) * cell);
        ctx.lineTo((e.x + 0.5) * cell, (e.y + 0.5) * cell);
        ctx.stroke();
      });
      ctx.restore();
    }

    // Both task forces, together, on the one board — the operation is over,
    // so there is nothing left to hide from a review of it. Owner colour
    // still distinguishes the two sides; every counter gets the same dark
    // outline for legibility against whatever terrain it sits on.
    round.entries.forEach((e) => {
      const color = PLAYER_COLORS[e.owner]?.light ?? '#ccc';
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc((e.x + 0.5) * cell, (e.y + 0.5) * cell, Math.max(2, cell * 0.55), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.5)';
      ctx.lineWidth = 1;
      ctx.stroke();
    });
  }, [round, idx, rounds, state.objectives, state.tiles]);

  return (
    <div className="modal-backdrop">
      <div className="modal replay-modal" data-testid="replay">
        <div className="tutorial-head">
          <div>
            <div className="tutorial-kicker">COMMAND — MATCH REPLAY</div>
            <div className="tutorial-title">
              Round {round ? round.round : '—'} of {rounds.length}
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
        <div className="replay-body">
          <canvas ref={canvasRef} width={480} height={480} className="replay-canvas" data-testid="replay-canvas" />
          <div className="replay-log" data-testid="replay-log">
            {roundLog.length === 0 && <div className="unit-move-note">No log entries for this round.</div>}
            {roundLog.map((l, i) => (
              <div key={i} className="replay-log-line">
                {l.text}
              </div>
            ))}
          </div>
        </div>
        <div className="tutorial-foot">
          <button
            className="btn-ghost tut-nav-btn"
            data-testid="replay-prev"
            disabled={idx === 0}
            onClick={() => {
              setPlaying(false);
              setIdx((i) => Math.max(0, i - 1));
            }}
          >
            ← Prev round
          </button>
          <button
            className="btn-primary tut-nav-btn"
            data-testid="replay-play"
            onClick={() => setPlaying((p) => !p)}
          >
            {playing ? '⏸ Pause' : '▶ Play'}
          </button>
          <span className="tut-progress" data-testid="replay-progress">
            {idx + 1} / {rounds.length} · grid reference {round && round.entries[0] ? gridRef(round.entries[0].x, round.entries[0].y) : '—'}
          </span>
          <button
            className="btn-ghost tut-nav-btn"
            data-testid="replay-next"
            disabled={idx >= rounds.length - 1}
            onClick={() => {
              setPlaying(false);
              setIdx((i) => Math.min(rounds.length - 1, i + 1));
            }}
          >
            Next round →
          </button>
        </div>
      </div>
    </div>
  );
};
