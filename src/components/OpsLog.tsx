import React from 'react';
import { GameState } from '../game/types';

/**
 * A compact, collapsible feed of the operations log (phase 7). Before this the
 * log existed only as data — fully fought over by fog.ts's redaction, but
 * never actually shown to the player. Reaction fire, Zones of Control,
 * suppression and destruction all need a legible trail, so this surfaces the
 * last several entries `state.log` already carries (server-filtered per
 * viewer — nothing here bypasses fog of war).
 */
export const OpsLog: React.FC<{
  state: GameState;
  collapsed: boolean;
  onToggle: () => void;
}> = ({ state, collapsed, onToggle }) => {
  const entries = state.log.slice(0, 40);
  return (
    <div className={`ops-log ${collapsed ? 'collapsed' : ''}`} data-testid="ops-log">
      <button className="ops-log-head" onClick={onToggle} title="Collapse / expand the operations log">
        <span className="ops-log-title">LOG</span>
        <span className="ops-log-count">{entries.length}</span>
        <span className="ops-log-caret">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className="ops-log-body" data-testid="ops-log-body">
          {entries.length === 0 && <div className="ops-log-empty">No orders logged yet.</div>}
          {entries.map((e, i) => (
            <div
              key={i}
              className={`ops-log-line ${/destroyed at grid/.test(e.text) ? 'kill' : /reaction fire/.test(e.text) ? 'reaction' : ''}`}
            >
              {e.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
