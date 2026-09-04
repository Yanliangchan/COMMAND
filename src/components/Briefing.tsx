import React, { useEffect, useRef } from 'react';
import { FACTION_NAMES, FACTION_SHORT, ORDERS_OF_BATTLE } from '../game/data';
import { BotDifficulty } from '../net/protocol';
import { MatchKind } from '../net/client';
import { FormationType, GameState, PlayerId, otherPlayer } from '../game/types';
import { sound } from '../audio/sound';

/** Minimum time the briefing stays up, however fast the match itself loaded — see App.tsx §1. */
const MIN_DISPLAY_MS = 2600;

const DIFFICULTY_LABEL: Record<BotDifficulty, string> = {
  EASY: 'Easy',
  MEDIUM: 'Medium',
  HARD: 'Hard',
};

/** Display grouping for the roster summary — arm counts only, per phase 10 §4. */
const ROSTER_GROUPS: { key: string; label: string; types: FormationType[] }[] = [
  { key: 'infantry', label: 'Infantry', types: ['INFANTRY'] },
  { key: 'elite', label: 'Commandos / Guards', types: ['COMMANDO', 'GUARDS'] },
  { key: 'armour', label: 'Armour', types: ['ARMOUR'] },
  { key: 'artillery', label: 'Artillery', types: ['ARTILLERY'] },
  { key: 'engineer', label: 'Engineers', types: ['ENGINEER'] },
  { key: 'c4i', label: 'C4I', types: ['RECON'] },
  { key: 'naval', label: 'Naval', types: ['FRIGATE', 'CORVETTE'] },
];

function rosterCounts(side: PlayerId) {
  const counts: Record<FormationType, number> = {} as any;
  ORDERS_OF_BATTLE[side].forEach((f) => {
    counts[f.type] = (counts[f.type] ?? 0) + 1;
  });
  return ROSTER_GROUPS.map((g) => ({ ...g, count: g.types.reduce((s, t) => s + (counts[t] ?? 0), 0) })).filter((g) => g.count > 0);
}

/**
 * Pre-battle briefing + roster interstitial (phase 10 §1 and §4, deliberately
 * one screen rather than two overlapping ones). Mounted as soon as `state`
 * arrives at round 1 — by that point the match is already fully loaded (the
 * server sends the whole starting GameState in one `start` message, see
 * net/client.ts), so this is purely a minimum-readable-time interstitial: it
 * never adds load time, it only guarantees the player sees it for at least
 * MIN_DISPLAY_MS before the board underneath becomes interactive.
 */
export const Briefing: React.FC<{
  state: GameState;
  you: PlayerId;
  matchKind: MatchKind | null;
  botDifficulty: BotDifficulty | null;
  onDismiss: () => void;
}> = ({ state, you, matchKind, botDifficulty, onDismiss }) => {
  const dismissedRef = useRef(false);

  const finish = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    sound.play('ui');
    onDismiss();
  };

  useEffect(() => {
    // unlock() runs inside this mount's own render pass, but the very first
    // real gesture is what matters for autoplay policy — App.tsx's own
    // one-time pointerdown/keydown listener is what actually unlocks audio;
    // this call is a harmless extra attempt for whoever's first gesture IS
    // clicking Begin.
    const autoTimer = window.setTimeout(finish, MIN_DISPLAY_MS);
    return () => window.clearTimeout(autoTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Self-contained capture-phase keyboard handling (same pattern as
  // Tutorial/HelpPanel): Escape or Enter dismisses immediately, and — since
  // this overlay appears OVER a live, already-loaded game (App.tsx bails its
  // own global shortcut listener while briefingOpen is true) — stopping
  // propagation here is what guarantees no keystroke reaches the board
  // underneath while the briefing is up.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        finish();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opponent = otherPlayer(you);
  const opponentLine =
    matchKind === 'bot'
      ? `Opposing force: ${FACTION_NAMES[opponent]}, under AI control (${botDifficulty ? DIFFICULTY_LABEL[botDifficulty] : 'Medium'} difficulty).`
      : `Opposing force: ${FACTION_NAMES[opponent]}, commanded by another player.`;

  const yourRoster = rosterCounts(you);
  const enemyRoster = rosterCounts(opponent);

  return (
    <div className="modal-backdrop briefing-backdrop" data-testid="briefing">
      <div className="briefing">
        <div className="briefing-kicker">EXERCISE SABRE VANGUARD &mdash; TASK ORDER</div>
        <div className="briefing-title">PRE-BATTLE BRIEFING</div>
        <div className="briefing-scenario" data-testid="briefing-scenario">
          <span className="briefing-scenario-label">SCENARIO</span>
          <span className="briefing-scenario-name">{state.mapName}</span>
        </div>
        <ul className="briefing-lines">
          <li>
            You command <b>{FACTION_NAMES[you]}</b> ({FACTION_SHORT[you]}).
          </li>
          <li>{opponentLine}</li>
          <li>
            Victory: the match ends the instant either side reaches <b>{state.rules.vpToWin} VP</b> — usually well before the{' '}
            {state.rules.roundLimit}-round limit. Only a match that never reaches that threshold runs the full{' '}
            {state.rules.roundLimit} rounds, at which point the higher score wins.
          </li>
          <li>
            AP per turn: <b>{state.rules.apPerTurn}</b> (carries over up to {state.rules.apCap}).
          </li>
          <li>
            <b>{FACTION_SHORT[state.initiative]}</b> holds the initiative and moves first this operation.
          </li>
        </ul>

        <div className="briefing-rosters">
          {([you, opponent] as PlayerId[]).map((side) => (
            <div key={side} className={`briefing-roster ${side === you ? 'mine' : ''}`}>
              <div className="briefing-roster-head">{FACTION_SHORT[side]}</div>
              <ul>
                {(side === you ? yourRoster : enemyRoster).map((g) => (
                  <li key={g.key}>
                    <span className="briefing-roster-count">{g.count}&times;</span> {g.label}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="briefing-note">
          Both task forces field a symmetric order of battle for this exercise &mdash; exact unit condition and position are
          withheld until your formations make contact.
        </p>

        <button className="btn-primary briefing-begin" onClick={finish} data-testid="briefing-begin">
          Begin <kbd>Enter</kbd>
        </button>
      </div>
    </div>
  );
};
