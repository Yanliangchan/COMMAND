import { KeyboardEvent, useMemo, useState } from 'react';
import { BotLevel } from '../bot';
import { BOARD } from '../map';
import { FACTIONS, FACTION_IDS, FactionId, MAX_ROUNDS, VP_TARGET } from '../types';
import { Emblem, Icon, IconName } from './Glyphs';
import { Help } from './Help';
import { SoundButton } from './Hud';
import { Badge, MapView } from './MapView';
import type { SavedMatch } from './save';
import { FACTION_INK } from './theme';
import './title.css';

export interface Setup {
  faction: FactionId;
  opponents: number;
  level: BotLevel;
}

const LEVELS: { id: BotLevel; label: string; blurb: string; rank: number }[] = [
  { id: 'RECRUIT', label: 'Recruit', blurb: 'Bots get fewer reinforcements. Learn the ropes.', rank: 1 },
  { id: 'REGULAR', label: 'Regular', blurb: 'A fair fight.', rank: 2 },
  { id: 'VETERAN', label: 'Veteran', blurb: 'Bots get extra reinforcements and take every opening.', rank: 3 },
];

const PERK_ICON: Record<FactionId, IconName> = { SINGA: 'deploy', HARIMAU: 'shield', HELANG: 'plane', JERUNG: 'ship' };

/** Arrow keys move through a radio group and select, like native radios. */
function radioKeys<T>(values: T[], current: T, pick: (v: T) => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const i = (values.indexOf(current) + dir + values.length) % values.length;
    pick(values[i]);
    const radios = e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]');
    radios[i]?.focus();
  };
}

/** Rank chevrons for the difficulty picker. */
function Chevrons({ n }: { n: number }) {
  return (
    <svg width={14} height={16} viewBox="0 0 14 16" aria-hidden="true" className="io-chev">
      {Array.from({ length: n }, (_, i) => (
        <path key={i} d={`M1 ${3 + i * 4.5} L7 ${7 + i * 4.5} L13 ${3 + i * 4.5}`} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      ))}
    </svg>
  );
}

export function TitleScreen({ initial, onStart, saved, onResume }: { initial: Setup; onStart: (s: Setup) => void; saved: SavedMatch | null; onResume: () => void }) {
  const [setup, setSetup] = useState(initial);
  const [howTo, setHowTo] = useState(false);
  const backdrop = useMemo(() => {
    const out: Record<string, Badge> = {};
    BOARD.regions.forEach((r, i) => (out[r.id] = { owner: FACTION_IDS[(i * 7 + r.sector.length * 3) % FACTION_IDS.length], text: String(1 + ((i * 13) % 9)), fog: false }));
    return out;
  }, []);
  const chosen = FACTIONS[setup.faction];
  const level = LEVELS.find((l) => l.id === setup.level)!;
  const savedMe = saved?.game.factions.find((f) => saved.game.players[f]?.human);
  const pick = (patch: Partial<Setup>) => setSetup((s) => ({ ...s, ...patch }));

  return (
    <div className="io-title" style={{ ['--c' as string]: chosen.color, ['--d' as string]: chosen.deep }}>
      {/* Decorative only: out of the tab order and the accessibility tree. */}
      <div className="io-title-bg" aria-hidden="true" ref={(el) => el?.setAttribute('inert', '')}>
        <div className="io-title-map">
          <MapView badges={backdrop} showLabels={false} cover />
        </div>
        <div className="io-title-shade" />
        <div className="io-title-radar" />
        <div className="io-title-grid" />
      </div>

      <div className="io-title-tools">
        <SoundButton />
      </div>

      <main className="io-title-inner">
        <header className="io-hero">
          <div className="io-hero-kicker">
            <span className="io-hero-rule" aria-hidden="true" />A Total Defence strategy game<span className="io-hero-rule" aria-hidden="true" />
          </div>
          <h1 className="io-logo">
            <span className="io-logo-word">
              COMMAND
              <span className="io-logo-shine" aria-hidden="true">
                <span className="io-logo-shine-win">
                  <span className="io-logo-shine-txt">COMMAND</span>
                </span>
              </span>
            </span>
            <span className="io-logo-tag">ISLAND OPS</span>
          </h1>
          <p className="io-tagline">Plan in secret. Strike together. Hold the island.</p>
        </header>

        {saved && savedMe && (
          <section className="io-resume" style={{ ['--c' as string]: FACTIONS[savedMe].color, ['--d' as string]: FACTIONS[savedMe].deep }} aria-label="Match in progress">
            <span className="io-tf-medal io-resume-medal" aria-hidden="true">
              <Emblem faction={savedMe} size={24} color={FACTION_INK[savedMe]} />
            </span>
            <span className="io-resume-text">
              <span className="io-resume-kicker">{saved.game.phase === 'GAME_OVER' ? 'Exercise over — result waiting' : 'Operation in progress'}</span>
              <b>{FACTIONS[savedMe].name}</b>
              <small>
                Round {saved.game.round} of {MAX_ROUNDS} · {saved.game.players[savedMe]!.vp} VP
              </small>
            </span>
            <button className="io-btn io-btn-primary io-resume-go" onClick={onResume} data-testid="continue">
              Continue <Icon name="play" size={14} />
            </button>
          </section>
        )}

        <section className="io-setup2" aria-labelledby="io-setup-title">
          <div className="io-step-head">
            <span className="io-step-n" aria-hidden="true">
              1
            </span>
            <h2 id="io-setup-title">Choose your task force</h2>
          </div>
          <div className="io-tf-grid" role="radiogroup" aria-labelledby="io-setup-title" onKeyDown={radioKeys(FACTION_IDS, setup.faction, (faction) => pick({ faction }))}>
            {FACTION_IDS.map((id) => {
              const f = FACTIONS[id];
              const on = setup.faction === id;
              return (
                <button
                  key={id}
                  role="radio"
                  aria-checked={on}
                  tabIndex={on ? 0 : -1}
                  aria-label={`${f.name} — ${f.doctrine}`}
                  aria-describedby={`io-tf-text-${id}`}
                  className={`io-tf io-tf-${id}${on ? ' io-tf-on' : ''}`}
                  style={{ ['--c' as string]: f.color, ['--d' as string]: f.deep, ['--ink' as string]: FACTION_INK[id] }}
                  onClick={() => pick({ faction: id })}
                  data-testid={`faction-${id}`}
                >
                  <span className="io-tf-band" aria-hidden="true">
                    <span className="io-tf-short">
                      {String(FACTION_IDS.indexOf(id) + 1).padStart(2, '0')} · {f.short}
                    </span>
                    <span className="io-tf-check">
                      <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 12.5l5 5L20 6.5" />
                      </svg>
                      Selected
                    </span>
                  </span>
                  <span className="io-tf-medal" aria-hidden="true">
                    <Emblem faction={id} size={30} color={FACTION_INK[id]} />
                  </span>
                  <span className="io-tf-body">
                    <span className="io-tf-name">
                      <span className="io-tf-tf">Task Force </span>
                      {f.animal}
                    </span>
                    <span className="io-tf-motto">“{f.motto}”</span>
                    <span className="io-tf-perk">
                      <Icon name={PERK_ICON[id]} size={13} />
                      {f.doctrine}
                    </span>
                    <span className="io-tf-text" id={`io-tf-text-${id}`}>
                      {f.doctrineText}
                    </span>
                    <span className="io-tf-orbat">
                      <span className="io-tf-orbat-label">ORBAT</span>
                      {f.battalions.map((b) => b.replace(/ /g, '\u00a0')).join(' · ')}
                      <span className="io-tf-sqn">
                        <Icon name="ship" size={11} /> {f.squadron}
                      </span>
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Narrow screens show the cards compact and brief the chosen one here. */}
          <div className="io-tf-brief" aria-hidden="true">
            <span className="io-tf-perk">
              <Icon name={PERK_ICON[setup.faction]} size={13} />
              {chosen.doctrine}
            </span>
            <span className="io-tf-brief-text">{chosen.doctrineText}</span>
            <span className="io-tf-orbat">{chosen.battalions.join(' · ')} · {chosen.squadron}</span>
          </div>

          <div className="io-setup-bar">
            <div className="io-field2">
              <div className="io-step-head io-step-sm">
                <span className="io-step-n" aria-hidden="true">
                  2
                </span>
                <span className="io-field2-label" id="io-opp-label">
                  Opponents
                </span>
              </div>
              <div className="io-seg io-seg2" role="radiogroup" aria-labelledby="io-opp-label" onKeyDown={radioKeys([2, 3], setup.opponents, (opponents) => pick({ opponents }))}>
                {[2, 3].map((n) => (
                  <button key={n} role="radio" aria-checked={setup.opponents === n} tabIndex={setup.opponents === n ? 0 : -1} className={setup.opponents === n ? 'on' : ''} onClick={() => pick({ opponents: n })}>
                    <span className="io-pips" aria-hidden="true">
                      {Array.from({ length: n }, (_, i) => (
                        <i key={i} />
                      ))}
                    </span>
                    {n} bots
                  </button>
                ))}
              </div>
            </div>
            <div className="io-field2">
              <div className="io-step-head io-step-sm">
                <span className="io-step-n" aria-hidden="true">
                  3
                </span>
                <span className="io-field2-label" id="io-lvl-label">
                  Difficulty
                </span>
              </div>
              <div className="io-seg io-seg2" role="radiogroup" aria-labelledby="io-lvl-label" aria-describedby="io-lvl-blurb" onKeyDown={radioKeys(LEVELS.map((l) => l.id), setup.level, (lv) => pick({ level: lv }))}>
                {LEVELS.map((l) => (
                  <button key={l.id} role="radio" aria-checked={setup.level === l.id} tabIndex={setup.level === l.id ? 0 : -1} className={setup.level === l.id ? 'on' : ''} onClick={() => pick({ level: l.id })}>
                    <Chevrons n={l.rank} />
                    {l.label}
                  </button>
                ))}
              </div>
              <span className="io-field2-note" id="io-lvl-blurb">
                {level.blurb}
              </span>
            </div>
          </div>
          <div className="io-setup-go2">
            <button className="io-btn io-btn-ghost io-howto" onClick={() => setHowTo(true)} data-testid="howto">
              <Icon name="help" /> How to play
            </button>
            <button className="io-btn io-btn-primary io-deploy" onClick={() => onStart(setup)} data-testid="deploy">
              <span className="io-deploy-emblem" aria-hidden="true">
                <Emblem faction={setup.faction} size={18} color={FACTION_INK[setup.faction]} />
              </span>
              {saved ? 'New match' : 'Start'}
              <Icon name="move" size={18} />
            </button>
          </div>
          <p className="io-setup-goal">
            <Icon name="star" size={14} className="io-star" /> Hold Key Installations — each one scores a victory point every round. First to {VP_TARGET} VP
            wins.
          </p>
        </section>

        <footer className="io-title-foot">
          <a className="io-link" href="#classic">
            Classic mode
          </a>
          <span aria-hidden="true">·</span>
          <span className="io-fine">A fictional Total Defence exercise. Not an official MINDEF product.</span>
        </footer>
      </main>

      {howTo && <Help onClose={() => setHowTo(false)} />}
    </div>
  );
}
