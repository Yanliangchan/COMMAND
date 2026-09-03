import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PLAYER_COLORS } from '../render/colors';
import { GRID_SIZE, PlayerId, gridRef } from '../game/types';
import { ReplayViewState } from '../net/protocol';

/**
 * MATCH REPLAY (phase 9) — a simple scrubber over the compact per-round
 * position snapshots the engine now records (`state.replay`), plus the
 * operations log filtered to that round. Deliberately NOT a reconstruction
 * of the full MapCanvas renderer (terrain, fog overlays, icons): the goal
 * here is "let players review what happened", not a frame-perfect replay —
 * see README "Match replay". Positions are drawn as plain dots on a light
 * grid; a formation's owner sets its colour the same way the live map does.
 */
export const Replay: React.FC<{ state: ReplayViewState; you: PlayerId; onClose: () => void }> = ({ state, you, onClose }) => {
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
    ctx.fillStyle = '#1a2119';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
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
      ctx.fillStyle = 'rgba(207,154,68,0.5)';
      ctx.beginPath();
      ctx.arc((o.x + 0.5) * cell, (o.y + 0.5) * cell, Math.max(2, cell * 0.4), 0, Math.PI * 2);
      ctx.fill();
    });
    round.entries.forEach((e) => {
      const color = PLAYER_COLORS[e.owner]?.light ?? '#ccc';
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc((e.x + 0.5) * cell, (e.y + 0.5) * cell, Math.max(2, cell * 0.55), 0, Math.PI * 2);
      ctx.fill();
      if (e.owner !== you) {
        ctx.strokeStyle = 'rgba(0,0,0,0.4)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    });
  }, [round, state.objectives, you]);

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
