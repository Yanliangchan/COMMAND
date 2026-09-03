import React, { useState } from 'react';
import { ConnStatus } from '../net/client';
import { BotDifficulty } from '../net/protocol';
import { GRID_SIZE } from '../game/types';
import { Tutorial } from './Tutorial';
import { HelpPanel } from './HelpPanel';
import { HeroBackdrop } from './HeroBackdrop';

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
  const [help, setHelp] = useState(false);
  const busy = status === 'connecting' || status === 'waiting' || status === 'searching';
  const pending = status === 'waiting' || status === 'searching' || status === 'connecting';

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
    <div className="landing" data-testid="landing">
      <HeroBackdrop />

      <div className="landing-inner">
        <header className="landing-brand">
          <div className="landing-eyebrow">
            <span className="landing-eyebrow-rule" />
            Turn-based operational warfare
          </div>
          <h1 className="landing-title">COMMAND</h1>
          <p className="landing-tagline">Lead the force. Shape the battlefield.</p>
          <p className="landing-blurb">
            Manoeuvre battalions across a {GRID_SIZE}&times;{GRID_SIZE} topographic battlefield, scout what you cannot see, and
            hold the ground that scores.
          </p>
        </header>

        <main className="landing-menu">
          {pending ? (
            <section className="status-card" data-testid="status-card">
              {status === 'waiting' && roomCode && (
                <>
                  <div className="status-kicker">Room created</div>
                  <h2 className="status-head">Share this code</h2>
                  <div className="room-code-display">
                    <span className="room-code-text" data-testid="room-code">
                      {roomCode}
                    </span>
                    <button className="btn-secondary" onClick={copyCode}>
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <div className="status-line">
                    <span className="pulse-dot" /> Waiting for your opponent to join&hellip;
                  </div>
                  <p className="status-note">The operation begins automatically the moment they enter the code.</p>
                </>
              )}
              {status === 'searching' && (
                <>
                  <div className="status-kicker">Quick match</div>
                  <h2 className="status-head">Searching for an opponent</h2>
                  <div className="scan-bar" />
                  <div className="status-line">
                    <span className="pulse-dot" /> Holding in the queue&hellip;
                  </div>
                  <p className="status-note">You&rsquo;ll be paired the moment another commander queues up.</p>
                </>
              )}
              {status === 'connecting' && (
                <>
                  <div className="status-kicker">Standby</div>
                  <h2 className="status-head">Connecting to command server</h2>
                  <div className="scan-bar" />
                </>
              )}
              <button className="btn-ghost status-cancel" onClick={onCancel}>
                Cancel
              </button>
            </section>
          ) : (
            <>
              {status === 'opponent_left' && (
                <div className="landing-banner">The other commander has left the operation. Start a new one below.</div>
              )}

              <section className="menu-block menu-block-primary">
                <div className="menu-kicker">Single player</div>
                <div className="menu-primary-row">
                  <div className="menu-copy">
                    <b>Play vs Bot</b>
                    <span>A full operation against an AI opponent. The fastest way in.</span>
                  </div>
                  <div className="diff-group" role="group" aria-label="Bot difficulty">
                    {BOT_DIFFICULTIES.map((d) => (
                      <button
                        key={d.level}
                        className="diff-btn"
                        title={d.blurb}
                        onClick={() => onVsBot(d.level)}
                        disabled={busy}
                        data-testid={`bot-${d.level}`}
                      >
                        <span>{d.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className="menu-block">
                <div className="menu-kicker">Multiplayer</div>
                <div className="menu-grid">
                  <button className="menu-tile" onClick={onCreate} disabled={busy} data-testid="create-room">
                    <b>Create Room</b>
                    <span>Get a five-character code to share.</span>
                  </button>
                  <button className="menu-tile" onClick={onQuickMatch} disabled={busy} data-testid="quick-match">
                    <b>Quick Match</b>
                    <span>Pair with the next commander in the queue.</span>
                  </button>
                  <div className="menu-tile menu-tile-join">
                    <b>Join with a code</b>
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
                      <button
                        className="btn-secondary"
                        data-testid="join-btn"
                        onClick={() => joinCode.trim() && onJoin(joinCode.trim())}
                        disabled={busy || !joinCode.trim()}
                      >
                        Join
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <nav className="menu-links">
                <button className="link-btn" onClick={() => setTutorial(true)} data-testid="tutorial-btn">
                  <span className="link-icon">▶</span> Tutorial
                  <i>Five minutes, start to finish</i>
                </button>
                <span className="link-sep" />
                <button className="link-btn" onClick={() => setHelp(true)} data-testid="help-btn">
                  <span className="link-icon">?</span> Field Manual
                  <i>Rules, orders and shortcuts</i>
                </button>
              </nav>

              {error && (
                <div className="landing-error" data-testid="landing-error">
                  {error}
                </div>
              )}
            </>
          )}
        </main>

        <footer className="landing-foot">
          <span>Task Force Sabre</span>
          <span className="foot-dot" />
          <span>Task Force Vanguard</span>
          <span className="foot-dot" />
          <span>Exercise Sabre Vanguard — a fictional SAF force-on-force exercise. See the field manual.</span>
        </footer>
      </div>

      {tutorial && <Tutorial onClose={() => setTutorial(false)} />}
      {help && <HelpPanel onClose={() => setHelp(false)} />}
    </div>
  );
};
