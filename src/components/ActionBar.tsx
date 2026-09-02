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
            className={`order-btn ${targetMode && targetMode === a.mode ? 'armed' : ''}`}
            disabled={!a.enabled}
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
