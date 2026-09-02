import React, { useState } from 'react';
import { ConnStatus } from '../net/client';
import { BotDifficulty } from '../net/protocol';
import { Tutorial } from './Tutorial';

interface Props {
  status: ConnStatus;
  roomCode: string | null;
  error: string | null;
  onCreate: () => void;
  onJoin: (code: string) => void;
  onQuickMatch: () => void;
  onVsBot: (difficulty: BotDifficulty) => void;
  onCancel: () => void;
}

const BOT_DIFFICULTIES: { level: BotDifficulty; label: string; blurb: string }[] = [
  { level: 'EASY', label: 'Easy', blurb: 'Mostly improvised orders — good for learning the ropes.' },
  { level: 'MEDIUM', label: 'Medium', blurb: 'Plays for objectives and avoids obviously bad attacks.' },
  { level: 'HARD', label: 'Hard', blurb: 'Combined-arms, target-priority, efficient with its AP.' },
];

export const Lobby: React.FC<Props> = ({ status, roomCode, error, onCreate, onJoin, onQuickMatch, onVsBot, onCancel }) => {
  const [joinCode, setJoinCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [tutorial, setTutorial] = useState(false);
  const busy = status === 'connecting' || status === 'waiting' || status === 'searching';

  const copyCode = async () => {
    if (!roomCode) return;
    try {
      await navigator.clipboard.writeText(roomCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — the code is still visible on screen to copy manually.
    }
  };

  return (
    <div className="lobby-root">
      <div className="lobby-grid-bg" aria-hidden />
      <div className="lobby-card">
        <div className="lobby-brand">
          <span className="lobby-brand-mark">COMMAND</span>
          <span className="lobby-brand-rule" />
          <span className="lobby-brand-sub">Lead the force. Shape the battlefield.</span>
          <span className="lobby-brand-note">
            A turn-based operational strategy game. Manoeuvre battalions across an 80×80 topographic battlefield, scout what you
            cannot see, and hold the ground that scores.
          </span>
        </div>

        <button className="tutorial-cta" onClick={() => setTutorial(true)} data-testid="tutorial-btn">
          <span className="tutorial-cta-icon">▶</span>
          <span>
            <b>New here? Start with the tutorial.</b>
            <i>Movement, attacking, recon, fortifying, combined arms and how you win — about five minutes.</i>
          </span>
        </button>

        {status === 'waiting' && roomCode && (
          <div className="lobby-panel">
            <div className="lobby-panel-title">ROOM CREATED</div>
            <div className="room-code-display">
              <span className="room-code-text">{roomCode}</span>
              <button className="btn-secondary" onClick={copyCode}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p className="lobby-hint">Share this code with your opponent. The operation begins automatically once they join.</p>
            <div className="lobby-status-row">
              <span className="pulse-dot" /> Waiting for opponent to join&hellip;
            </div>
            <button className="btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}

        {status === 'searching' && (
          <div className="lobby-panel">
            <div className="lobby-panel-title">QUICK MATCH</div>
            <div className="lobby-status-row lobby-status-row-center">
              <span className="pulse-dot" /> Searching for opponent&hellip;
            </div>
            <p className="lobby-hint">You&rsquo;ll be paired automatically the moment another commander queues up.</p>
            <button className="btn-ghost" onClick={onCancel}>
              Cancel
            </button>
          </div>
        )}

        {status === 'connecting' && (
          <div className="lobby-panel">
            <div className="lobby-status-row lobby-status-row-center">
              <span className="pulse-dot" /> Connecting to command server&hellip;
            </div>
          </div>
        )}

        {(status === 'lobby' || status === 'error' || status === 'opponent_left') && (
          <div className="lobby-options">
            {status === 'opponent_left' && (
              <div className="lobby-banner">The other commander has left the operation. Start a new one below.</div>
            )}
            <div className="lobby-panel lobby-panel-primary">
              <div className="lobby-panel-title">PLAY SOLO — VS BOT</div>
              <p className="lobby-hint">A full operation against an AI opponent. No second commander needed.</p>
              <div className="bot-difficulty-row">
                {BOT_DIFFICULTIES.map((d) => (
                  <button
                    key={d.level}
                    className="btn-primary bot-difficulty-btn"
                    title={d.blurb}
                    onClick={() => onVsBot(d.level)}
                    disabled={busy}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="lobby-row-2">
              <div className="lobby-panel">
                <div className="lobby-panel-title">CREATE ROOM</div>
                <p className="lobby-hint">Get a room code to share.</p>
                <button className="btn-secondary wide" onClick={onCreate} disabled={busy}>
                  Create Room
                </button>
              </div>
              <div className="lobby-panel">
                <div className="lobby-panel-title">QUICK MATCH</div>
                <p className="lobby-hint">Pair with the next commander in the queue.</p>
                <button className="btn-secondary wide" onClick={onQuickMatch} disabled={busy}>
                  Quick Match
                </button>
              </div>
            </div>
            <div className="lobby-panel">
              <div className="lobby-panel-title">JOIN ROOM</div>
              <div className="join-row">
                <input
                  className="join-input"
                  value={joinCode}
                  maxLength={5}
                  placeholder="CODE"
                  aria-label="Room code"
                  data-testid="room-code-input"
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && joinCode.trim()) onJoin(joinCode.trim());
                  }}
                />
                <button className="btn-secondary" onClick={() => joinCode.trim() && onJoin(joinCode.trim())} disabled={busy || !joinCode.trim()}>
                  Join
                </button>
              </div>
            </div>
          </div>
        )}

        {error && <div className="lobby-error">{error}</div>}
      </div>
      {tutorial && <Tutorial onClose={() => setTutorial(false)} />}
    </div>
  );
};
