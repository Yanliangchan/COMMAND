import React from 'react';
import { FORMATION_DEFS } from '../game/data';
import { Formation, GameState, PlayerId } from '../game/types';

const GROUP_ORDER: Formation['type'][] = ['INFANTRY', 'COMMANDO', 'ARMOUR', 'ARTILLERY', 'ENGINEER', 'RECON', 'LOGISTICS', 'NAVAL_TRANSPORT', 'FRIGATE'];

export const FormationList: React.FC<{
  state: GameState;
  viewer: PlayerId;
  selectedId: string | null;
  onSelect: (f: Formation) => void;
}> = ({ state, viewer, selectedId, onSelect }) => {
  const mine = Object.values(state.formations).filter((f) => f.owner === viewer && !f.embarkedOn);
  const grouped = GROUP_ORDER.map((t) => ({ type: t, list: mine.filter((f) => f.type === t) })).filter((g) => g.list.length);

  return (
    <div className="formation-list">
      <div className="panel-title">FORMATIONS</div>
      {grouped.map((g) => (
        <div key={g.type} className="formation-group">
          <div className="formation-group-label">{FORMATION_DEFS[g.type].label}</div>
          {g.list.map((f) => (
            <button key={f.id} className={`formation-row ${selectedId === f.id ? 'active' : ''} ${f.hasActedThisTurn ? 'spent' : ''}`} onClick={() => onSelect(f)}>
              <span className="formation-name">{f.name}</span>
              <span className="formation-str">{Math.round(f.strength)}%</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
};
