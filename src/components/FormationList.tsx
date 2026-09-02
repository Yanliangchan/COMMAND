import React from 'react';
import { FORMATION_DEFS } from '../game/data';
import { Formation, GameState, PlayerId } from '../game/types';

const GROUP_ORDER: Formation['type'][] = ['INFANTRY', 'COMMANDO', 'ARMOUR', 'ARTILLERY', 'ENGINEER', 'RECON', 'FRIGATE', 'CORVETTE'];

export const FormationList: React.FC<{
  state: GameState;
  viewer: PlayerId;
  selectedId: string | null;
  onSelect: (f: Formation) => void;
}> = ({ state, viewer, selectedId, onSelect }) => {
  const mine = Object.values(state.formations).filter((f) => f.owner === viewer);
  const grouped = GROUP_ORDER.map((t) => ({ type: t, list: mine.filter((f) => f.type === t) })).filter((g) => g.list.length);

  return (
    <div className="formation-list">
      <div className="panel-title">FORMATIONS</div>
      {grouped.map((g) => (
        <div key={g.type} className="formation-group">
          <div className="formation-group-label">{FORMATION_DEFS[g.type].label}</div>
          {g.list.map((f) => (
            <button
              key={f.id}
              className={`formation-row ${selectedId === f.id ? 'active' : ''} ${f.hasActedThisTurn && f.movesUsed >= f.movesMax ? 'spent' : ''}`}
              onClick={() => onSelect(f)}
              title={f.name}
            >
              <span className="formation-name">{f.shortName}</span>
              <span className="formation-str">
                {Math.round(f.strength)}% · {f.movesUsed}/{f.movesMax}
              </span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
};
