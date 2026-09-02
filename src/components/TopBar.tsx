import React from 'react';
import { AP_CAP, GameState, PlayerId } from '../game/types';

export const TopBar: React.FC<{ state: GameState; you: PlayerId }> = ({ state, you }) => {
  const mine = state.players[you];
  const myTurn = state.activePlayer === you;
  return (
    <div className="topbar">
      <div className="topbar-left">
        <span className="op-name">OPERATION IRON HORIZON</span>
        <span className="divider">|</span>
        <span>Round {state.round} / 20</span>
      </div>
      <div className="topbar-center">
        <span className={`player-chip ${you.toLowerCase()}`}>YOU: {you}</span>
        <span className={`turn-chip ${myTurn ? 'turn-active' : ''}`}>{myTurn ? 'YOUR TURN' : `${state.activePlayer} TURN`}</span>
      </div>
      <div className="topbar-right">
        <span className="ap-counter">
          AP: <b>{mine.ap}</b> / {AP_CAP}
        </span>
        <span className="divider">|</span>
        <span>Sorties: {mine.airSorties}</span>
        <span className="divider">|</span>
        <span>
          VP — BLUE {state.players.BLUEFOR.vp} : RED {state.players.REDFOR.vp}
        </span>
      </div>
    </div>
  );
};
