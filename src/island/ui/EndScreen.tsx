// ============================================================================
// The end of the match: victory or defeat, the final standings, Play again.
// A real dialog — focus moves to Play again and stays inside; Escape does
// nothing (this is the end); on short screens the card scrolls inside itself
// with its buttons pinned, so they're always in reach.
// ============================================================================

import { useEffect, useId, useRef, useState } from 'react';
import { player, regionsOf } from '../engine';
import { FACTIONS, GameState, FactionId, VP_TARGET } from '../types';
import type { BotLevel } from '../bot';
import { Emblem, Icon } from './Glyphs';
import { FACTION_INK } from './theme';
import { prefersReducedMotion, useFocusTrap } from './useFocusTrap';
import './end.css';

const LEVEL_NAME: Record<BotLevel, string> = { RECRUIT: 'Recruit', REGULAR: 'Regular', VETERAN: 'Veteran' };
const ORDINAL = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

/** Counts up to `to` once, after `delay` ms; instant under reduced motion. */
function useCountUp(to: number, delay = 0, ms = 1100): number {
  const [n, setN] = useState(() => (prefersReducedMotion() ? to : 0));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setN(to);
      return;
    }
    let raf = 0;
    const t0 = performance.now() + delay;
    const tick = (t: number) => {
      const k = Math.min(1, Math.max(0, (t - t0) / ms));
      setN(Math.round(to * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [to, delay, ms]);
  return n;
}

function Stat({ value, label, delay }: { value: number; label: string; delay: number }) {
  const n = useCountUp(value, delay);
  return (
    <div className="io-end-stat">
      <b aria-hidden="true">{n}</b>
      <span className="io-sr">{value}</span>
      <span>{label}</span>
    </div>
  );
}

/** A hanging medal: ribbon in the faction colour, gold rim, emblem. */
function Medal({ faction, dull }: { faction: FactionId; dull?: boolean }) {
  const f = FACTIONS[faction];
  const id = useId().replace(/:/g, '');
  return (
    <svg className="io-end-medal-svg" viewBox="0 0 140 170" aria-hidden="true">
      <defs>
        <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={dull ? '#c9d2db' : '#fff1b8'} />
          <stop offset="0.45" stopColor={dull ? '#8d99a6' : '#ffc83d'} />
          <stop offset="1" stopColor={dull ? '#5b6977' : '#c98a00'} />
        </linearGradient>
      </defs>
      <g className="io-end-ribbon">
        <path d="M34 0 H64 L84 78 L60 86 Z" fill={f.deep} />
        <path d="M76 0 H106 L80 86 L56 78 Z" fill={f.color} />
        <path d="M45 0 H53 L72 76 L66 79 Z" fill="#fff" opacity="0.85" />
        <path d="M87 0 H95 L74 79 L68 76 Z" fill="#fff" opacity="0.85" />
      </g>
      <g transform="translate(70 112)">
        <circle r="50" fill={`url(#g${id})`} stroke={dull ? '#3f4852' : '#7a5200'} strokeWidth="3" />
        <circle r="41" fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="2" strokeDasharray="3 4" />
        <circle r="36" fill={f.color} stroke={f.deep} strokeWidth="4" />
        <g transform="translate(-22 -22) scale(1.85)">
          <Emblem faction={faction} size={24} color={FACTION_INK[faction]} />
        </g>
      </g>
    </svg>
  );
}

/** Confetti in the winner's colour, gold and white — one burst, transforms only. */
function Confetti({ color }: { color: string }) {
  const palette = [color, '#ffc83d', '#ffffff', color, '#ffe08a'];
  return (
    <div className="io-end-confetti" aria-hidden="true">
      {Array.from({ length: 64 }, (_, i) => {
        const x = (i * 37) % 100;
        const style = {
          left: `${x}%`,
          background: palette[i % palette.length],
          ['--dx' as string]: `${((i * 53) % 41) - 20}vw`,
          ['--r' as string]: `${((i * 97) % 720) - 360}deg`,
          ['--dur' as string]: `${2.6 + ((i * 7) % 13) / 10}s`,
          ['--delay' as string]: `${((i * 11) % 9) / 10}s`,
          width: `${6 + (i % 3) * 3}px`,
          height: `${10 + ((i * 5) % 4) * 3}px`,
        };
        return <i key={i} style={style} />;
      })}
    </div>
  );
}

export function Victory({ game, me, level, onRestart, onExit }: { game: GameState; me: FactionId; level: BotLevel; onRestart: () => void; onExit: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { blockEscape: true, restoreFocus: false });
  const w = game.winner!;
  const won = w === me;
  const fac = FACTIONS[w];
  const regions = (f: FactionId) => regionsOf(game, f).length;
  const table = [...game.factions].sort((a, b) => (b === w ? 1 : 0) - (a === w ? 1 : 0) || player(game, b).vp - player(game, a).vp || regions(b) - regions(a));
  const myRank = table.indexOf(me);
  const myP = player(game, me);
  const scale = Math.max(VP_TARGET, ...table.map((f) => player(game, f).vp));
  const reason = game.winReason ? game.winReason.charAt(0).toUpperCase() + game.winReason.slice(1) : '';
  const tint = won ? fac : FACTIONS[me];

  return (
    <div className={`io-end ${won ? 'io-end-win' : 'io-end-loss'}`} style={{ ['--c' as string]: tint.color, ['--d' as string]: tint.deep, ['--w' as string]: fac.color }}>
      <div className="io-end-veil" aria-hidden="true" />
      {won && (
        <>
          <div className="io-end-rays" aria-hidden="true" />
          <Confetti color={fac.color} />
        </>
      )}
      <div ref={ref} className="io-end-card" role="dialog" aria-modal="true" aria-labelledby="io-victory-title" aria-describedby="io-end-desc" tabIndex={-1}>
        <div className="io-end-scroll">
          <div className="io-end-hero">
            <div className="io-end-medal">
              {won && <span className="io-end-burst" aria-hidden="true" />}
              <Medal faction={won ? w : me} dull={!won} />
            </div>
            <p className="io-end-kicker">Exercise complete · round {game.round}</p>
            <h1 id="io-victory-title" className="io-end-title">
              {won ? 'Victory' : 'Defeat'}
            </h1>
            <p className="io-end-who" id="io-end-desc">
              {won ? (
                'The island is yours, Commander.'
              ) : (
                <>
                  <span className="io-end-victor" style={{ ['--c' as string]: fac.color }}>
                    <span className="io-end-victor-dot" aria-hidden="true">
                      <Emblem faction={w} size={14} color={FACTION_INK[w]} />
                    </span>
                    {fac.name}
                  </span>{' '}
                  takes the exercise. You finished {ORDINAL[myRank]} of {table.length}
                  {myP.eliminatedRound ? `, knocked out in round ${myP.eliminatedRound}` : ''}.
                </>
              )}
            </p>
            {reason && <p className="io-end-reason">{won ? reason : `${fac.name} — ${reason.charAt(0).toLowerCase()}${reason.slice(1)}`}</p>}
          </div>

          <div className="io-end-body">
            <div className="io-end-stats">
              <Stat value={myP.vp} label="your VP" delay={350} />
              <Stat value={game.round} label="rounds" delay={450} />
              <Stat value={game.stats.battles} label="battles" delay={550} />
              <Stat value={game.stats.captures} label="captures" delay={650} />
            </div>

            <h2 className="io-end-sub">Final standings</h2>
            <ol className="io-end-table">
              {table.map((f, i) => {
                const p = player(game, f);
                return (
                  <li
                    key={f}
                    className={`${f === me ? 'io-mine' : ''}${p.alive ? '' : ' io-out'}`}
                    style={{ ['--c' as string]: FACTIONS[f].color, ['--d' as string]: FACTIONS[f].deep, ['--i' as string]: i, ['--pct' as string]: Math.min(1, p.vp / scale) }}
                  >
                    <span className={`io-end-rank io-end-rank-${i + 1}`}>{i + 1}</span>
                    <span className="io-end-dot" aria-hidden="true">
                      <Emblem faction={f} size={14} color={FACTION_INK[f]} />
                    </span>
                    <span className="io-end-name">
                      {FACTIONS[f].name}
                      {f === me && <em> (you)</em>}
                      {!p.alive && <small> · out{p.eliminatedRound ? `, round ${p.eliminatedRound}` : ''}</small>}
                    </span>
                    <b className="io-end-vp">{p.vp} VP</b>
                    <span className="io-end-bar" aria-hidden="true">
                      <span />
                      <i style={{ left: `${(VP_TARGET / scale) * 100}%` }} title={`${VP_TARGET} VP`} />
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="io-end-level">
              <Icon name="flag" size={14} /> {LEVEL_NAME[level]} bots · first to {VP_TARGET} VP
            </p>
          </div>
        </div>
        <div className="io-end-actions">
          <button className="io-btn io-btn-primary io-end-again" onClick={onRestart} data-autofocus>
            <Icon name="undo" size={18} /> Play again
          </button>
          <button className="io-btn io-btn-ghost" onClick={onExit}>
            <Icon name="exit" size={18} /> Main menu
          </button>
        </div>
      </div>
    </div>
  );
}
