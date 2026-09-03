import React from 'react';
import { ActionAvailability } from '../game/actions';
import { Formation } from '../game/types';
import { TargetMode } from '../App.types';

interface Props {
  formation: Formation;
  actions: ActionAvailability[];
  targetMode: TargetMode;
  onAction: (a: ActionAvailability) => void;
  onCancel: () => void;
  hint: string | null;
}

/**
 * The floating order bar. Everything the selected formation can do is visible
 * at once with its shortcut on the face of the button — no nested menus, and
 * the keyboard is never required.
 *
 * Phase 6: an unavailable order is styled as unavailable but is NOT `disabled`,
 * because a genuinely disabled button swallows the click and tells a new player
 * nothing. Clicking one now flashes the exact reason ("No identified enemy
 * within attack range…"), which is the same string the tooltip carries and the
 * same one actions.ts hands the roster and the end-turn warning.
 */
export const ActionBar: React.FC<Props> = ({ formation, actions, targetMode, onAction, onCancel, hint }) => {
  const shown = actions.filter((a) => a.applicable);
  return (
    <div className="action-bar">
      <div className="action-bar-head">
        <span className="action-bar-unit">{formation.shortName}</span>
        <span className="action-bar-sep">ORDERS</span>
      </div>
      <div className="action-bar-btns">
        {shown.map((a) => (
          <button
            key={a.id}
            className={`order-btn ${targetMode && targetMode === a.mode ? 'armed' : ''} ${a.enabled ? '' : 'unavailable'}`}
            aria-disabled={!a.enabled}
            title={a.enabled ? a.blurb : a.reason}
            data-action={a.id}
            onClick={() => onAction(a)}
          >
            <span className="order-key">{a.shortcut}</span>
            <span className="order-label">{a.label}</span>
            <span className="order-ap">{a.apCost}AP</span>
          </button>
        ))}
      </div>
      {hint && (
        <div className="order-hint">
          <span>{hint}</span>
          <button className="order-cancel" onClick={onCancel}>
            Esc — Cancel
          </button>
        </div>
      )}
    </div>
  );
};
