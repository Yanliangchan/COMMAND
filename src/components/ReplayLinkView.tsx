import React, { useEffect, useState } from 'react';
import { FACTION_NAMES } from '../game/data';
import { FetchedReplay } from '../net/client';
import { PlayerId } from '../game/types';
import { Replay } from './Replay';

/**
 * STANDALONE REPLAY LINK (phase 11 §6). Reached via a `?replay=CODE` query
 * param — see App.tsx's own on-load check, a plain query param rather than a
 * router dependency. Fetches the saved replay over a fresh socket connection
 * (net/client.ts's `getReplay`) and, once it arrives, hands it straight to
 * the SAME Replay.tsx scrubber a live match's "Review Replay" uses — anyone
 * with the link sees exactly what a player reviewing their own finished
 * match would, including the same fog-of-war caveat phase 9 documented
 * (final-rung redaction, not a per-round reconstruction of detection): pick
 * a side below and you see that side's redacted view of the whole match.
 */
export const ReplayLinkView: React.FC<{
  code: string;
  fetched: FetchedReplay | null;
  error: string | null;
  onFetch: (code: string) => void;
  onExit: () => void;
}> = ({ code, fetched, error, onFetch, onExit }) => {
  const [perspective, setPerspective] = useState<PlayerId>('SABRE');

  useEffect(() => {
    onFetch(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (fetched && fetched.code === code) {
    const view = perspective === 'SABRE' ? fetched.sabre : fetched.vanguard;
    return (
      <div className="replay-link-root" data-testid="replay-link-view">
        <div className="replay-link-bar">
          <div className="replay-link-title">
            <b>{fetched.mapName}</b>
            <span>
              {fetched.winner === 'DRAW' || !fetched.winner ? 'Draw' : `${FACTION_NAMES[fetched.winner]} won`} — shared replay
            </span>
          </div>
          <div className="replay-link-perspective" role="group" aria-label="Viewing perspective">
            {(['SABRE', 'VANGUARD'] as PlayerId[]).map((p) => (
              <button
                key={p}
                className={`sandbox-side-btn ${perspective === p ? 'active' : ''}`}
                onClick={() => setPerspective(p)}
                data-testid={`replay-link-perspective-${p}`}
              >
                {FACTION_NAMES[p]}&rsquo;s view
              </button>
            ))}
          </div>
          <button className="btn-ghost small" onClick={onExit} data-testid="replay-link-exit">
            Exit
          </button>
        </div>
        <Replay state={view} you={perspective} onClose={onExit} />
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
