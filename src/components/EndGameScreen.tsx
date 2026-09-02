import React from 'react';
import { GameState, PlayerId } from '../game/types';

export const EndGameScreen: React.FC<{ state: GameState; you: PlayerId; onRestart: () => void }> = ({ state, you, onRestart }) => {
  const won = state.winner === you;
  const draw = state.winner === 'DRAW';
  return (
    <div className="modal-backdrop">
      <div className="modal handoff">
        <div className="handoff-title">OPERATION CONCLUDED</div>
        <div className={`handoff-player ${draw ? '' : won ? 'result-win' : 'result-loss'}`}>
          {draw ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT'}
        </div>
        <div className="handoff-sub">{draw ? 'Both sides fought to a standstill.' : `${state.winner} secured the operation.`}</div>
        <div className="handoff-sub">
          Final VP — BLUEFOR {state.players.BLUEFOR.vp} : REDFOR {state.players.REDFOR.vp}
        </div>
        <button className="close-btn" onClick={onRestart}>
          Return to Lobby
        </button>
      </div>
    </div>
  );
};
