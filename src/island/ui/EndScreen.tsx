// ============================================================================
// The end of the match: victory or defeat, the final table, Play again.
// ============================================================================

import { player } from '../engine';
import { FACTIONS, GameState, FactionId } from '../types';
import type { BotLevel } from '../bot';
import { Emblem } from './Glyphs';
import { FACTION_INK } from './theme';
import './end.css';

const LEVEL_NAME: Record<BotLevel, string> = { RECRUIT: 'Recruit', REGULAR: 'Regular', VETERAN: 'Veteran' };

export function Victory({ game, me, level, onRestart, onExit }: { game: GameState; me: FactionId; level: BotLevel; onRestart: () => void; onExit: () => void }) {
  const w = game.winner!;
  const won = w === me;
  const fac = FACTIONS[w];
  const table = [...game.factions].sort((a, b) => player(game, b).vp - player(game, a).vp);
  const reason = game.winReason ? `${fac.name} — ${game.winReason}` : '';
  return (
    <div className="io-modal-backdrop">
      <div
        className={`io-card io-victory${won ? '' : ' io-defeat'}`}
        style={{ ['--c' as string]: won ? fac.color : FACTIONS[me].color, ['--d' as string]: won ? fac.deep : FACTIONS[me].deep }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="io-victory-title"
      >
        <div className="io-victory-emblem">
          <Emblem faction={won ? w : me} size={58} color={FACTION_INK[won ? w : me]} />
        </div>
        <h1 id="io-victory-title">{won ? 'Victory!' : 'Defeat'}</h1>
        <p className="io-victory-who">{won ? 'The island is yours, Commander.' : `${fac.name} takes the exercise.`}</p>
        <p className="io-victory-reason">{reason.charAt(0).toUpperCase() + reason.slice(1)}</p>
        <ol className="io-victory-table">
          {table.map((f, i) => (
            <li key={f} className={f === me ? 'io-mine' : ''} style={{ ['--c' as string]: FACTIONS[f].color }}>
              <span className="io-rank">{i + 1}</span>
              <span className="io-emblem-dot io-emblem-sm">
                <Emblem faction={f} size={12} color={FACTION_INK[f]} />
              </span>
              <span>
                {FACTIONS[f].name}
                {f === me ? ' (you)' : ''}
              </span>
              <b>{player(game, f).vp} VP</b>
            </li>
          ))}
        </ol>
        <div className="io-victory-stats">
          <span>
            <b>{game.round}</b> rounds
          </span>
          <span>
            <b>{game.stats.battles}</b> battles
          </span>
          <span>
            <b>{game.stats.captures}</b> captures
          </span>
          <span>
            <b>{LEVEL_NAME[level]}</b> bots
          </span>
        </div>
        <div className="io-actions io-actions-center">
          <button className="io-btn io-btn-primary" onClick={onRestart} data-autofocus>
            Play again
          </button>
          <button className="io-btn io-btn-ghost" onClick={onExit}>
            Main menu
          </button>
        </div>
      </div>
    </div>
  );
}

