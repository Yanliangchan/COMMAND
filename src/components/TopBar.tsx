import React from 'react';
import { AP_CAP, GameState } from '../game/types';

export const TopBar: React.FC<{ state: GameState }> = ({ state }) => {
  const ps = state.players[state.activePlayer];
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="op-name">OPERATION IRON HORIZON</span>
        <span className="divider">|</span>
        <span>Round {state.round} / 20</span>
      </div>
      <div className="topbar-center">
        <span className={`player-chip ${state.activePlayer.toLowerCase()}`}>{state.activePlayer} TURN</span>
      </div>
      <div className="topbar-right">
        <span className="ap-counter">
          AP: <b>{ps.ap}</b> / {AP_CAP}
        </span>
        <span className="divider">|</span>
        <span>Sorties: {ps.airSorties}</span>
        <span className="divider">|</span>
        <span>
          VP — BLUE {state.players.BLUEFOR.vp} : RED {state.players.REDFOR.vp}
        </span>
      </div>
    </div>
  );
};
