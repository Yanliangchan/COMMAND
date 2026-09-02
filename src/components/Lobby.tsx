import React, { useState } from 'react';
import { ConnStatus } from '../net/client';
import { BotDifficulty } from '../net/protocol';

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
      <div className="lobby-card">
        <div className="lobby-brand">
          <span className="lobby-brand-mark">COMMAND</span>
          <span className="lobby-brand-sub">Operation Iron Horizon &mdash; Multiplayer Staging</span>
        </div>

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
            <div className="lobby-panel">
              <div className="lobby-panel-title">CREATE ROOM</div>
              <p className="lobby-hint">Generate a shareable room code and wait for a second commander to join.</p>
              <button className="btn-primary" onClick={onCreate} disabled={busy}>
                Create Room
              </button>
            </div>
            <div className="lobby-panel">
              <div className="lobby-panel-title">JOIN ROOM</div>
              <p className="lobby-hint">Enter a code you were given.</p>
              <div className="join-row">
                <input
                  className="join-input"
                  value={joinCode}
                  maxLength={5}
                  placeholder="CODE"
                  onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && joinCode.trim()) onJoin(joinCode.trim());
                  }}
                />
                <button className="btn-primary" onClick={() => joinCode.trim() && onJoin(joinCode.trim())} disabled={busy || !joinCode.trim()}>
                  Join
                </button>
              </div>
            </div>
            <div className="lobby-panel">
              <div className="lobby-panel-title">QUICK MATCH</div>
              <p className="lobby-hint">Get paired with the next available commander.</p>
              <button className="btn-primary" onClick={onQuickMatch} disabled={busy}>
                Quick Match
              </button>
            </div>
            <div className="lobby-panel">
              <div className="lobby-panel-title">VS BOT</div>
              <p className="lobby-hint">Play a solo operation against an AI opponent — no second commander needed.</p>
              <div className="bot-difficulty-row">
                {BOT_DIFFICULTIES.map((d) => (
                  <button
                    key={d.level}
                    className="btn-secondary bot-difficulty-btn"
                    title={d.blurb}
                    onClick={() => onVsBot(d.level)}
                    disabled={busy}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {error && <div className="lobby-error">{error}</div>}
      </div>
    </div>
  );
};
