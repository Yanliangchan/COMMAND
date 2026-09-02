import React from 'react';
import { GameState } from '../game/types';

export const TurnHandoffScreen: React.FC<{ state: GameState; onContinue: () => void }> = ({ state, onContinue }) => {
  return (
    <div className="modal-backdrop">
      <div className="modal handoff">
        <div className="handoff-title">PASS THE DEVICE</div>
        <div className={`handoff-player ${state.activePlayer.toLowerCase()}`}>{state.activePlayer}'S TURN</div>
        <div className="handoff-sub">Round {state.round}</div>
        <p className="handoff-note">
          Hand the device to the {state.activePlayer} commander. The map will redraw with {state.activePlayer}'s fog of war —
          only formations spotted by recon or currently in sight range will be visible.
        </p>
        <button className="close-btn" onClick={onContinue}>
          Begin {state.activePlayer} Turn
        </button>
      </div>
    </div>
  );
};
