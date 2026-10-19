// The room before the exercise starts: share the code, pick a Pasukan, and
// the host starts — bots take whatever seats are still empty.

import { useState } from 'react';
import type { IslandOnline } from '../net';
import { FACTIONS, FACTION_IDS } from '../types';
import { Emblem } from './Glyphs';

export function Lobby({ online }: { online: IslandOnline }) {
  const [copied, setCopied] = useState(false);
  const lobby = online.lobby;
  if (!lobby || online.status === 'closed') {
    return (
      <div className="io-title io-lobby-screen">
        <div className="io-lobby">
          <h2>{online.status === 'closed' ? 'Connection lost' : 'Connecting…'}</h2>
          <p className="io-fine">{online.notice?.text ?? 'Reaching the command server.'}</p>
          <button className="io-btn io-btn-ghost" onClick={online.leave}>
            Back
          </button>
        </div>
      </div>
    );
  }
  const me = lobby.seats.find((s) => s.faction === online.you);
  const link = `${location.origin}${location.pathname}?room=${lobby.code}`;
  const empty = lobby.size - lobby.seats.length;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard blocked; the link is on screen to copy by hand.
    }
  };

  return (
    <div className="io-title io-lobby-screen">
      <div className="io-lobby" data-testid="lobby">
        <div className="io-hero-kicker">Exercise room</div>
        <div className="io-room-code" data-testid="room-code">
          {lobby.code}
        </div>
        <div className="io-share">
          <code>{link}</code>
          <button className="io-btn io-btn-ghost io-small" onClick={copy}>
            {copied ? 'Copied!' : 'Copy link'}
          </button>
        </div>

        <div className="io-seats">
          {lobby.seats.map((s) => (
            <div key={s.faction} className={`io-seat${s.faction === online.you ? ' io-seat-me' : ''}`} style={{ ['--c' as string]: FACTIONS[s.faction].color }}>
              <span className="io-faction-emblem">
                <Emblem faction={s.faction} size={26} color="#fff" />
              </span>
              <span className="io-seat-text">
                <b>
                  {s.name}
                  {s.host && <em> HOST</em>}
                  {s.faction === online.you && <em> YOU</em>}
                </b>
                <small>
                  {FACTIONS[s.faction].name} · {FACTIONS[s.faction].doctrine}
                </small>
              </span>
            </div>
          ))}
          {Array.from({ length: empty }, (_, i) => (
            <div key={`empty-${i}`} className="io-seat io-seat-empty">
              <span className="io-seat-text">
                <b>Open seat</b>
                <small>A bot takes it if nobody joins</small>
              </span>
            </div>
          ))}
        </div>

        <div className="io-field">
          <span className="io-field-label">Your Pasukan</span>
          <div className="io-seg">
            {FACTION_IDS.map((f) => {
              const taken = lobby.seats.some((s) => s.faction === f && s.faction !== online.you);
              return (
                <button key={f} className={online.you === f ? 'on' : ''} disabled={taken} onClick={() => online.pick(f)}>
                  {FACTIONS[f].short}
                </button>
              );
            })}
          </div>
        </div>

        <div className="io-lobby-actions">
          <button className="io-btn io-btn-ghost" onClick={online.leave}>
            Leave
          </button>
          {me?.host ? (
            <button className="io-btn io-btn-primary io-btn-deploy" onClick={online.start} data-testid="start">
              Start{empty ? ` — ${empty} bot${empty > 1 ? 's' : ''} fill in` : ''}
            </button>
          ) : (
            <span className="io-fine">Waiting for the host to start…</span>
          )}
        </div>
      </div>
      {online.notice && (
        <div className="io-toast" key={online.notice.id}>
          {online.notice.text}
        </div>
      )}
    </div>
  );
}
