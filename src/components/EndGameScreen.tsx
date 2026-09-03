import React, { useState } from 'react';
import { GameState, PlayerId, otherPlayer } from '../game/types';
import { FACTION_NAMES, FACTION_SHORT } from '../game/data';
import { Replay } from './Replay';

export const EndGameScreen: React.FC<{ state: GameState; you: PlayerId; onRestart: () => void }> = ({ state, you, onRestart }) => {
  const [replayOpen, setReplayOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const won = state.winner === you;
  const replayLink = state.replayCode ? `${window.location.origin}${window.location.pathname}?replay=${state.replayCode}` : null;
  const copyReplayLink = async () => {
    if (!replayLink) return;
    try {
      await navigator.clipboard.writeText(replayLink);
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1800);
    } catch {
      // clipboard API unavailable — the link is still visible to copy manually.
    }
  };
  const draw = state.winner === 'DRAW';
  const held = state.objectives.filter((o) => o.controlledBy === you).length;
  return (
    <div className="modal-backdrop">
      <div className="modal handoff">
        <div className="handoff-title">COMMAND — OPERATION CONCLUDED</div>
        <div className={`handoff-player ${draw ? '' : won ? 'result-win' : 'result-loss'}`}>
          {draw ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT'}
        </div>
        <div className="handoff-sub" data-testid="endgame-winner">
          {draw
            ? 'Both task forces fought to a standstill.'
            : `${FACTION_NAMES[state.winner as PlayerId]} secured the operation.`}
        </div>
        <div className="handoff-sub" data-testid="endgame-vp">
          Final VP — {FACTION_SHORT[you]} {state.players[you].vp} : {FACTION_SHORT[otherPlayer(you)]}{' '}
          {state.players[otherPlayer(you)].vp}
        </div>
        <div className="handoff-note">
          You finished holding {held} of {state.objectives.length} objectives after {state.round} rounds.
        </div>
        <button className="btn-ghost small" data-testid="open-replay" onClick={() => setReplayOpen(true)}>
          Review Replay
        </button>
        {replayLink && (
          <div className="replay-share-row" data-testid="replay-share-row">
            <input className="replay-share-input" readOnly value={replayLink} onFocus={(e) => e.currentTarget.select()} data-testid="replay-share-link" />
            <button className="btn-ghost small" onClick={copyReplayLink} data-testid="copy-replay-link">
              {linkCopied ? 'Copied' : 'Copy link'}
            </button>
          </div>
        )}
        <button className="close-btn" onClick={onRestart}>
          Return to Lobby
        </button>
      </div>
      {replayOpen && <Replay state={state} you={you} onClose={() => setReplayOpen(false)} />}
    </div>
  );
};
