import React, { useState } from 'react';
import { GameState, PlayerId, otherPlayer } from '../game/types';
import { FACTION_NAMES, FACTION_SHORT } from '../game/data';
import { FetchedReplay } from '../net/client';
import { Replay } from './Replay';

export const EndGameScreen: React.FC<{
  state: GameState;
  you: PlayerId;
  onRestart: () => void;
  fetchedReplay: FetchedReplay | null;
  replayError: string | null;
  onFetchReplay: (code: string) => void;
}> = ({ state, you, onRestart, fetchedReplay, replayError, onFetchReplay }) => {
  const [replayOpen, setReplayOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // "Review Replay" shows the SAME fully-revealed view (terrain, both task
  // forces) a shared link shows, not this client's own fogged final state —
  // fetched over the wire from the server's saved-replay store the instant
  // the button is pressed, since the match is already over and there is
  // nothing left on either side worth keeping secret from a review of it.
  const openReplay = () => {
    setReplayOpen(true);
    if (state.replayCode && (!fetchedReplay || fetchedReplay.code !== state.replayCode)) onFetchReplay(state.replayCode);
  };
  const replayReady = fetchedReplay && fetchedReplay.code === state.replayCode;
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
  // Why the match ended — read straight off state.winReason, which
  // checkVictory() (engine.ts) sets the instant it decides the game is
  // over. The client never re-derives this from VP/round numbers itself,
  // so it can't drift out of sync with the engine's own logic.
  const reasonText =
    state.winReason === 'VP_THRESHOLD'
      ? `Victory point threshold reached (${state.rules.vpToWin} VP) — the match ended at round ${state.round}, before the ${state.rules.roundLimit}-round limit.`
      : `Round limit reached (round ${state.rules.roundLimit}) — higher score wins.`;
  return (
    <div className="modal-backdrop">
      <div className="modal handoff">
        <div className="handoff-stamp" aria-hidden="true">
          OPERATION CONCLUDED
        </div>
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
        <div className="handoff-reason" data-testid="endgame-reason">
          {reasonText}
        </div>
        <div className="handoff-note">
          You finished holding {held} of {state.objectives.length} objectives after {state.round} rounds.
        </div>
        <button className="btn-ghost small" data-testid="open-replay" onClick={openReplay}>
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
      {replayOpen && replayReady && <Replay state={fetchedReplay.full} onClose={() => setReplayOpen(false)} />}
      {replayOpen && !replayReady && (
        <div className="modal-backdrop">
          <div className="modal replay-modal replay-loading" data-testid="replay-loading">
            {replayError ? (
              <>
                <div className="landing-error">{replayError}</div>
                <button className="btn-ghost small" onClick={() => setReplayOpen(false)}>
                  Close
                </button>
              </>
            ) : (
              <div className="status-line">
                <span className="pulse-dot" /> Loading replay&hellip;
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
