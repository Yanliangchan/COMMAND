import React, { useEffect } from 'react';
import { FACTION_NAMES } from '../game/data';
import { FetchedReplay } from '../net/client';
import { Replay } from './Replay';

/**
 * STANDALONE REPLAY LINK (phase 11 §6). Reached via a `?replay=CODE` query
 * param — see App.tsx's own on-load check, a plain query param rather than a
 * router dependency. Fetches the saved replay over a fresh socket connection
 * (net/client.ts's `getReplay`) and hands it straight to the SAME Replay.tsx
 * scrubber a live match's "Review Replay" uses. There is no per-side
 * perspective to pick: the saved replay is one fully-revealed view of the
 * whole match — both task forces, real terrain — since the operation is
 * over and there is nothing left on either side worth hiding from a review
 * of it (see server/index.ts's `saveReplay`, built with `filterStateForSpectator`).
 */
export const ReplayLinkView: React.FC<{
  code: string;
  fetched: FetchedReplay | null;
  error: string | null;
  onFetch: (code: string) => void;
  onExit: () => void;
}> = ({ code, fetched, error, onFetch, onExit }) => {
  useEffect(() => {
    onFetch(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (fetched && fetched.code === code) {
    return (
      <div className="replay-link-root" data-testid="replay-link-view">
        <div className="replay-link-bar">
          <div className="replay-link-title">
            <b>{fetched.mapName}</b>
            <span>
              {fetched.winner === 'DRAW' || !fetched.winner ? 'Draw' : `${FACTION_NAMES[fetched.winner]} won`} — shared replay
            </span>
          </div>
          <button className="btn-ghost small" onClick={onExit} data-testid="replay-link-exit">
            Exit
          </button>
        </div>
        <Replay state={fetched.full} onClose={onExit} />
      </div>
    );
  }

  return (
    <div className="landing" data-testid="replay-link-loading">
      <div className="landing-inner">
        <header className="landing-brand">
          <h1 className="landing-title">COMMAND</h1>
          <p className="landing-tagline">Shared replay</p>
        </header>
        <main className="landing-menu">
          {error ? (
            <div className="landing-error" data-testid="replay-link-error">
              {error}
            </div>
          ) : (
            <div className="status-card">
              <div className="status-line">
                <span className="pulse-dot" /> Loading replay {code}&hellip;
              </div>
            </div>
          )}
          <button className="btn-secondary" onClick={onExit} data-testid="replay-link-back">
            Back to COMMAND
          </button>
        </main>
      </div>
    </div>
  );
};
