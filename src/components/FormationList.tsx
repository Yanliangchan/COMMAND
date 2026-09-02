import React from 'react';
import { FORMATION_DEFS } from '../game/data';
import { formationActivity } from '../game/actions';
import { Formation, GameState, PlayerId } from '../game/types';
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
}> = ({ state, viewer, selectedId, collapsed, onToggle, onSelect }) => {
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
                className={`roster-row ${selectedId === f.id ? 'active' : ''} ${a.actionable ? '' : 'spent'}`}
                onClick={() => onSelect(f)}
                title={`${f.name} — ${FORMATION_DEFS[f.type].label}`}
              >
                <span className="roster-glyph">{formationGlyph(f.type)}</span>
                <span className="roster-name">{f.shortName}</span>
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
          <div className="roster-foot">Tab — jump to the next formation with orders left</div>
        </div>
      )}
    </div>
  );
};
