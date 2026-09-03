import React from 'react';
import { PriorityTarget } from '../game/threat';

/**
 * Compact, non-blocking "who threatens you right now" readout (phase 12 §2).
 * Sits alongside the turn-start SITREP banner rather than inside it, so it
 * can carry its own click targets — clicking an entry jumps the camera to
 * that formation, the same "click to jump" affordance the phase-10 event
 * notification already established. Never a modal; never blocks play.
 */
export const PriorityTargets: React.FC<{
  targets: PriorityTarget[];
  onJump: (x: number, y: number) => void;
}> = ({ targets, onJump }) => {
  if (!targets.length) return null;
  return (
    <div className="priority-targets" data-testid="priority-targets">
      <span className="priority-targets-tag">PRIORITY</span>
      {targets.map((t, i) => (
        <button
          key={t.formationId}
          className="priority-target-btn"
          data-testid="priority-target-entry"
          title={`${t.label} threatens ${t.threatenedCount} of your formation${t.threatenedCount === 1 ? '' : 's'} (${t.threatenedNames.join(', ')}) — click to jump there.`}
          onClick={() => onJump(t.x, t.y)}
        >
          {i > 0 && <span className="priority-target-sep">·</span>}
          {t.label} <em>×{t.threatenedCount}</em>
        </button>
      ))}
    </div>
  );
};
