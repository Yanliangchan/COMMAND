import React from 'react';
import { FORMATION_DEFS } from '../game/data';
import { formationActivity } from '../game/actions';
import { canReorganize } from '../game/engine';
import { Formation, GameState, isLastStandActive, PlayerId, STATIONARY_CONCEALMENT_MIN_ROUNDS } from '../game/types';
import { formationGlyph } from '../render/renderMap';

/**
 * Floating roster. Its whole job is answering "who still has something to do?"
 * at a glance — every row carries a movement-pip and major-action badge, and
 * spent formations dim out.
 */
export const FormationList: React.FC<{
  state: GameState;
  viewer: PlayerId;
  selectedId: string | null;
  collapsed: boolean;
  onToggle: () => void;
  onSelect: (f: Formation) => void;
  /** Shift-click — add/remove the formation from the Move Formation group. */
  onToggleGroup: (f: Formation) => void;
  groupIds: string[];
}> = ({ state, viewer, selectedId, collapsed, onToggle, onSelect, onToggleGroup, groupIds }) => {
  const mine = Object.values(state.formations)
    .filter((f) => f.owner === viewer)
    .sort((a, b) => a.id.localeCompare(b.id));
  const activity = new Map(mine.map((f) => [f.id, formationActivity(state, f, viewer)]));
  const ready = mine.filter((f) => activity.get(f.id)!.actionable).length;

  return (
    <div className={`roster ${collapsed ? 'collapsed' : ''}`}>
      <button className="roster-head" onClick={onToggle} title="Collapse / expand the roster">
        <span className="roster-title">FORMATIONS</span>
        <span className={`roster-count ${ready ? 'has-ready' : ''}`}>{ready} ready</span>
        <span className="roster-caret">{collapsed ? '▸' : '▾'}</span>
      </button>
      {!collapsed && (
        <div className="roster-body">
          {mine.map((f) => {
            const a = activity.get(f.id)!;
            return (
              <button
                key={f.id}
                className={`roster-row ${selectedId === f.id ? 'active' : ''} ${a.actionable ? '' : 'spent'} ${
                  groupIds.includes(f.id) ? 'grouped' : ''
                }`}
                onClick={(e) => (e.shiftKey ? onToggleGroup(f) : onSelect(f))}
                title={`${f.name} — ${FORMATION_DEFS[f.type].label}`}
              >
                <span className="roster-glyph">{formationGlyph(f.type)}</span>
                <span className="roster-name">
                  {f.shortName}
                  {/* At-a-glance condition dots — alert / suppressed / reorganize-ready.
                      Absent entirely when none apply, so a healthy formation's row
                      stays uncluttered. */}
                  <span className="roster-status">
                    {f.onAlert && (
                      <i className="status-dot status-alert" title="On alert — will fire a reaction shot at an enemy that moves into range and line of sight." />
                    )}
                    {f.suppression > 0 && (
                      <i className="status-dot status-suppressed" title={`Suppressed (${Math.round(f.suppression)}) — attack power and movement range reduced until it decays.`} />
                    )}
                    {a.majorFree && canReorganize(state, f) && (
                      <i className="status-dot status-reorg" title="Reorganize is available this round (S) — no move made yet, off cooldown." />
                    )}
                    {isLastStandActive(f, state.round) && (
                      <i className="status-dot status-laststand" title={`Last stand — cornered and fighting harder through round ${f.lastStandUntilRound}.`} />
                    )}
                    {(f.roundsStationary ?? 0) >= STATIONARY_CONCEALMENT_MIN_ROUNDS && (
                      <i className="status-dot status-concealed" title={`Concealed — held this ground for ${f.roundsStationary} round${f.roundsStationary === 1 ? '' : 's'} without moving, harder for the enemy to spot.`} />
                    )}
                  </span>
                </span>
                <span className="roster-str">{Math.round(f.strength)}%</span>
                <span className="roster-badges">
                  {Array.from({ length: f.movesMax }).map((_, i) => (
                    <i key={i} className={`pip ${i < f.movesMax - f.movesUsed ? 'on' : ''}`} />
                  ))}
                  <i className={`star ${a.majorFree ? 'on' : ''}`}>★</i>
                </span>
              </button>
            );
          })}
          <div className="roster-foot">
            Tab — jump to the next formation with orders left. Shift-click two or more, then Shift+M to move them as a
            formation.
          </div>
        </div>
      )}
    </div>
  );
};
