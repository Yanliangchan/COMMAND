import React from 'react';
import { GameState } from '../game/types';

export const EndGameScreen: React.FC<{ state: GameState; onRestart: () => void }> = ({ state, onRestart }) => {
  return (
    <div className="modal-backdrop">
      <div className="modal handoff">
        <div className="handoff-title">OPERATION CONCLUDED</div>
        <div className={`handoff-player ${state.winner === 'DRAW' ? '' : (state.winner ?? '').toLowerCase()}`}>
          {state.winner === 'DRAW' ? 'DRAW' : `${state.winner} VICTORY`}
        </div>
        <div className="handoff-sub">
          Final VP — BLUEFOR {state.players.BLUEFOR.vp} : REDFOR {state.players.REDFOR.vp}
        </div>
        <button className="close-btn" onClick={onRestart}>
          New Operation
        </button>
      </div>
    </div>
  );
};
