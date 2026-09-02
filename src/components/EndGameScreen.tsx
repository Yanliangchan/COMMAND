import React from 'react';
import { GameState, PlayerId } from '../game/types';

export const EndGameScreen: React.FC<{ state: GameState; you: PlayerId; onRestart: () => void }> = ({ state, you, onRestart }) => {
  const won = state.winner === you;
  const draw = state.winner === 'DRAW';
  const held = state.objectives.filter((o) => o.controlledBy === you).length;
  return (
    <div className="modal-backdrop">
      <div className="modal handoff">
        <div className="handoff-title">COMMAND — OPERATION CONCLUDED</div>
        <div className={`handoff-player ${draw ? '' : won ? 'result-win' : 'result-loss'}`}>
          {draw ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT'}
        </div>
        <div className="handoff-sub">{draw ? 'Both sides fought to a standstill.' : `${state.winner} secured the operation.`}</div>
        <div className="handoff-sub">
          Final VP — BLUEFOR {state.players.BLUEFOR.vp} : REDFOR {state.players.REDFOR.vp}
        </div>
        <div className="handoff-note">
          You finished holding {held} of {state.objectives.length} objectives after {state.round} rounds.
        </div>
        <button className="close-btn" onClick={onRestart}>
          Return to Lobby
        </button>
      </div>
    </div>
  );
};
